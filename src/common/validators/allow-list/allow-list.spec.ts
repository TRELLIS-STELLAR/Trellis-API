import { of } from "rxjs";
import {
  DestinationAllowListService,
  DestinationNotAllowedError,
  DestinationPolicy,
  hostMatchesPattern,
  webhookDestinationPolicy,
} from "./destination-allow-list";
import {
  checkFileTypeAllowList,
  fileTypeAllowListMode,
} from "./file-type-allow-list";
import { WebhookSubscriptionService } from "../../../infrastructure/webhooks/services/webhook-subscription.service";
import { WebhookDeliveryService } from "../../../infrastructure/webhooks/services/webhook-delivery.service";
import { WebhookDeliveryStatus } from "../../../infrastructure/webhooks/entities/webhook-delivery.entity";

/** Strict allow-list validation for URLs, file types and destinations (#279). */

class FakeDnsAllowList extends DestinationAllowListService {
  answers: Record<string, string[] | Error> = {};
  lookups: string[] = [];
  protected async resolve(hostname: string): Promise<string[]> {
    this.lookups.push(hostname);
    const answer = this.answers[hostname] ?? ["93.184.216.34"];
    if (answer instanceof Error) {
      throw new DestinationNotAllowedError(
        "DESTINATION_DNS_FAILED",
        answer.message,
        true,
      );
    }
    return answer;
  }
}

function service(env: Record<string, string> = {}) {
  return new FakeDnsAllowList({ get: (k: string) => env[k] } as never);
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as DestinationNotAllowedError).code;
  }
}

describe("DestinationAllowListService", () => {
  it("accepts a public https destination and normalizes it", async () => {
    const allowList = service();
    const result = await allowList.validate(
      "HTTPS://Hooks.Example.com/path?a=1#frag",
    );
    expect(result).toEqual({
      url: "https://hooks.example.com/path?a=1",
      hostname: "hooks.example.com",
      port: 443,
      addresses: ["93.184.216.34"],
    });
  });

  it.each([
    ["http://hooks.example.com/x", "DESTINATION_PROTOCOL_NOT_ALLOWED"],
    ["ftp://hooks.example.com/x", "DESTINATION_PROTOCOL_NOT_ALLOWED"],
    ["file:///etc/passwd", "DESTINATION_PROTOCOL_NOT_ALLOWED"],
    ["javascript:alert(1)", "DESTINATION_PROTOCOL_NOT_ALLOWED"],
    [
      "https://user:pass@hooks.example.com/",
      "DESTINATION_CREDENTIALS_NOT_ALLOWED",
    ],
    ["https://hooks.example.com:8080/", "DESTINATION_PORT_NOT_ALLOWED"],
    ["https://hooks.example.com:3000/", "DESTINATION_PORT_NOT_ALLOWED"],
    ["https://127.0.0.1/", "DESTINATION_IP_LITERAL_NOT_ALLOWED"],
    ["https://[::1]/", "DESTINATION_IP_LITERAL_NOT_ALLOWED"],
    ["https://2130706433/", "DESTINATION_IP_LITERAL_NOT_ALLOWED"],
    ["https://0x7f000001/", "DESTINATION_IP_LITERAL_NOT_ALLOWED"],
    [
      "https://169.254.169.254/latest/meta-data",
      "DESTINATION_IP_LITERAL_NOT_ALLOWED",
    ],
    ["https://localhost/", "DESTINATION_HOST_NOT_ALLOWED"],
    ["https://api.internal/", "DESTINATION_HOST_NOT_ALLOWED"],
    ["https://printer.local/", "DESTINATION_HOST_NOT_ALLOWED"],
    ["https://metadata.google.internal/", "DESTINATION_HOST_NOT_ALLOWED"],
    ["https://intranet/", "DESTINATION_HOST_NOT_ALLOWED"],
    ["not a url", "DESTINATION_INVALID"],
    ["", "DESTINATION_INVALID"],
  ])("rejects %s with %s", async (url, code) => {
    expect(await codeOf(service().validate(url))).toBe(code);
  });

  it("rejects overly long URLs", async () => {
    const url = `https://hooks.example.com/${"a".repeat(3000)}`;
    expect(await codeOf(service().validate(url))).toBe("DESTINATION_TOO_LONG");
  });

  it("rejects a public-looking host that resolves to a private address", async () => {
    const allowList = service();
    allowList.answers["rebind.example.com"] = ["93.184.216.34", "10.0.0.7"];
    expect(
      await codeOf(allowList.validate("https://rebind.example.com/")),
    ).toBe("DESTINATION_PRIVATE_ADDRESS");
    allowList.answers["meta.example.com"] = ["::ffff:169.254.169.254"];
    expect(await codeOf(allowList.validate("https://meta.example.com/"))).toBe(
      "DESTINATION_PRIVATE_ADDRESS",
    );
  });

  it("reports DNS failure as retryable and policy failures as permanent", async () => {
    const allowList = service();
    allowList.answers["flaky.example.com"] = new Error("EAI_AGAIN");
    const dnsError = await allowList
      .validate("https://flaky.example.com/")
      .catch((e) => e);
    expect(dnsError).toMatchObject({
      code: "DESTINATION_DNS_FAILED",
      retryable: true,
    });

    const policyError = await allowList
      .validate("http://hooks.example.com/")
      .catch((e) => e);
    expect(policyError).toMatchObject({ retryable: false });
    expect(policyError.getStatus()).toBe(400);
  });

  it("enforces the configured host allow-list with label-boundary wildcards", async () => {
    const allowList = service({
      WEBHOOK_DESTINATION_ALLOWED_HOSTS: "hooks.partner.io, *.example.com",
    });
    await expect(
      allowList.validate("https://hooks.partner.io/"),
    ).resolves.toBeDefined();
    await expect(
      allowList.validate("https://a.b.example.com/"),
    ).resolves.toBeDefined();
    for (const url of [
      "https://example.com/",
      "https://badexample.com/",
      "https://evil.partner.io/",
      "https://hooks.partner.io.attacker.net/",
    ]) {
      expect(await codeOf(allowList.validate(url))).toBe(
        "DESTINATION_HOST_NOT_ALLOWED",
      );
    }
  });

  it("allows http and extra ports only when explicitly configured", async () => {
    const allowList = service({
      WEBHOOK_DESTINATION_ALLOW_HTTP: "true",
      WEBHOOK_DESTINATION_ALLOWED_PORTS: "443,8443",
    });
    await expect(
      allowList.validate("http://hooks.example.com:8443/"),
    ).resolves.toMatchObject({ port: 8443 });
    expect(await codeOf(allowList.validate("http://hooks.example.com/"))).toBe(
      "DESTINATION_PORT_NOT_ALLOWED",
    );
  });

  it("supports a custom policy with IP literals still checked for privacy", async () => {
    const policy: DestinationPolicy = {
      ...webhookDestinationPolicy(() => undefined),
      allowIpLiterals: true,
    };
    await expect(
      service().validate("https://93.184.216.34/", policy),
    ).resolves.toBeDefined();
    expect(
      await codeOf(service().validate("https://192.168.1.10/", policy)),
    ).toBe("DESTINATION_PRIVATE_ADDRESS");
  });

  it("matches host patterns precisely", () => {
    expect(hostMatchesPattern("a.example.com", "*.example.com")).toBe(true);
    expect(hostMatchesPattern("example.com", "*.example.com")).toBe(false);
    expect(hostMatchesPattern("notexample.com", "*.example.com")).toBe(false);
    expect(hostMatchesPattern("Example.com.", "example.com")).toBe(true);
  });
});

describe("checkFileTypeAllowList", () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);
  const pdf = Buffer.from("%PDF-1.7\n");

  it("accepts a file whose extension, MIME type and content agree", () => {
    expect(
      checkFileTypeAllowList({
        originalname: "a.png",
        mimetype: "image/png",
        buffer: png,
      }),
    ).toMatchObject({
      allowed: true,
      entry: { id: "png", category: "image" },
    });
    expect(
      checkFileTypeAllowList({
        originalname: "notes.txt",
        mimetype: "text/plain",
        buffer: Buffer.from("héllo\n"),
      }),
    ).toMatchObject({ allowed: true, entry: { id: "text" } });
  });

  it("rejects content that does not match the declared type (polyglot / renamed)", () => {
    const result = checkFileTypeAllowList({
      originalname: "a.png",
      mimetype: "image/png",
      buffer: pdf,
    });
    expect(result.allowed).toBe(false);
    expect(result.errors.join()).toMatch(/does not match/);
  });

  it("rejects a declared MIME type that does not belong to the extension", () => {
    const result = checkFileTypeAllowList({
      originalname: "a.png",
      mimetype: "application/pdf",
      buffer: png,
    });
    expect(result.allowed).toBe(false);
  });

  it.each([
    ["logo.svg", "image/svg+xml", Buffer.from("<svg onload=alert(1)>")],
    ["page.html", "text/html", Buffer.from("<script>")],
    [
      "data.xml",
      "application/xml",
      Buffer.from("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]>"),
    ],
    ["tool.exe", "application/x-msdownload", Buffer.from("MZ")],
    ["noext", "image/png", Buffer.from([0x89, 0x50])],
  ])("rejects non-allow-listed type %s", (originalname, mimetype, buffer) => {
    expect(
      checkFileTypeAllowList({ originalname, mimetype, buffer }).allowed,
    ).toBe(false);
  });

  it("rejects hidden executable extensions and binary content in text files", () => {
    expect(
      checkFileTypeAllowList({
        originalname: "invoice.exe.pdf",
        mimetype: "application/pdf",
        buffer: pdf,
      }).allowed,
    ).toBe(false);
    expect(
      checkFileTypeAllowList({
        originalname: "a.txt",
        mimetype: "text/plain",
        buffer: Buffer.from([0x41, 0x00, 0x42]),
      }).allowed,
    ).toBe(false);
  });

  it("requires content to verify the type and honours category restrictions", () => {
    expect(
      checkFileTypeAllowList({ originalname: "a.png", mimetype: "image/png" })
        .allowed,
    ).toBe(false);
    expect(
      checkFileTypeAllowList(
        { originalname: "a.png", mimetype: "image/png", buffer: png },
        { categories: ["document"] },
      ).allowed,
    ).toBe(false);
  });

  it("parses the rollout mode, defaulting to enforce", () => {
    expect(fileTypeAllowListMode(undefined)).toBe("enforce");
    expect(fileTypeAllowListMode("REPORT")).toBe("report");
    expect(fileTypeAllowListMode("off")).toBe("off");
    expect(fileTypeAllowListMode("nonsense")).toBe("enforce");
  });
});

describe("webhook destinations", () => {
  it("rejects a subscription to a non-allow-listed destination before saving it", async () => {
    const repo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: "s1", ...x })),
    };
    const subscriptions = new WebhookSubscriptionService(
      repo as any,
      service(),
    );

    await expect(
      subscriptions.create("u1", {
        url: "https://169.254.169.254/latest",
        events: ["*"],
      } as any),
    ).rejects.toBeInstanceOf(DestinationNotAllowedError);
    expect(repo.save).not.toHaveBeenCalled();

    const created = await subscriptions.create("u1", {
      url: "https://Hooks.Example.com/in",
      events: ["*"],
    } as any);
    expect(created.url).toBe("https://hooks.example.com/in");
  });

  it("validates the URL on update too", async () => {
    const existing = {
      id: "s1",
      userId: "u1",
      url: "https://hooks.example.com/",
    };
    const repo = {
      findOne: jest.fn(async () => ({ ...existing })),
      save: jest.fn(async (x) => x),
    };
    const subscriptions = new WebhookSubscriptionService(
      repo as any,
      service(),
    );
    await expect(
      subscriptions.update("s1", "u1", { url: "http://10.0.0.1/" } as any),
    ).rejects.toBeInstanceOf(DestinationNotAllowedError);
    expect(repo.save).not.toHaveBeenCalled();
  });

  function deliveryHarness(url: string, allowList = service()) {
    const subscription = {
      id: "s1",
      userId: "u1",
      url,
      signingKey: "k",
      retryDelayMs: 1000,
      backoffMultiplier: 2,
      timeoutMs: 1000,
    };
    const delivery: any = {
      id: "d1",
      subscriptionId: "s1",
      eventId: "e1",
      attempts: 0,
      maxAttempts: 5,
      metadata: {},
    };
    const event = { id: "e1", eventType: "x", payload: {} };
    const deliveryRepo = {
      findOne: jest.fn(async () => delivery),
      save: jest.fn(async (x) => x),
    };
    const deadLetterRepo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => x),
    };
    const qb: any = {
      update: () => qb,
      set: () => qb,
      where: () => qb,
      execute: async () => undefined,
    };
    const eventRepo = {
      findOne: jest.fn(async () => event),
      createQueryBuilder: () => qb,
    };
    const subscriptionRepo = { findOne: jest.fn(async () => subscription) };
    const http = {
      post: jest.fn(() => of({ status: 200, data: "ok", headers: {} })),
    };
    const hmac = { buildSignedHeaders: jest.fn(() => ({})) };
    const deliveries = new WebhookDeliveryService(
      deliveryRepo as any,
      deadLetterRepo as any,
      eventRepo as any,
      subscriptionRepo as any,
      http as any,
      hmac as any,
      allowList,
    );
    return { deliveries, delivery, http, deadLetterRepo, allowList };
  }

  it("delivers to an allowed destination with redirects disabled and DNS pinned", async () => {
    const { deliveries, http, allowList } = deliveryHarness(
      "https://hooks.example.com/in",
    );
    allowList.answers["hooks.example.com"] = ["93.184.216.34"];

    const result = await deliveries.processDelivery("d1");

    expect(result.status).toBe(WebhookDeliveryStatus.SUCCESS);
    const config = (http.post.mock.calls[0] as unknown[])[2] as any;
    expect(config.maxRedirects).toBe(0);
    const resolved = await new Promise((resolve) =>
      config.lookup("hooks.example.com", {}, (_e: unknown, address: string) =>
        resolve(address),
      ),
    );
    expect(resolved).toBe("93.184.216.34");
  });

  it("dead-letters immediately when a stored destination is no longer allowed", async () => {
    const { deliveries, http, deadLetterRepo } = deliveryHarness(
      "https://hooks.example.com/in",
      service({
        WEBHOOK_DESTINATION_ALLOWED_HOSTS: "*.partner.io",
      }),
    );

    const result = await deliveries.processDelivery("d1");

    expect(http.post).not.toHaveBeenCalled();
    expect(result.status).toBe(WebhookDeliveryStatus.DEAD_LETTERED);
    expect(result.attempts).toBe(1);
    expect(result.errorMessage).toMatch(/DESTINATION_HOST_NOT_ALLOWED/);
    expect(deadLetterRepo.save).toHaveBeenCalled();
  });

  it("schedules a retry when the destination's DNS lookup fails transiently", async () => {
    const allowList = service();
    allowList.answers["hooks.example.com"] = new Error("EAI_AGAIN");
    const { deliveries, http } = deliveryHarness(
      "https://hooks.example.com/in",
      allowList,
    );

    const result = await deliveries.processDelivery("d1");

    expect(http.post).not.toHaveBeenCalled();
    expect(result.status).toBe(WebhookDeliveryStatus.FAILED);
    expect(result.nextRetryAt).toBeInstanceOf(Date);
  });
});

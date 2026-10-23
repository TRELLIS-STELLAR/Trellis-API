import * as fs from "fs";
import {
  ArgumentMetadata,
  BadRequestException,
  ConflictException,
  HttpException,
  Type,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CreatePaymentDto } from "../../../payments/dto/create-payment.dto";
import { SubmitPayloadDto } from "../../../blockchain/oracle/dto/submit-payload.dto";
import { WebhookSignatureService } from "../../../payments/webhooks/webhook-signature.service";
import { WebhookInboundService } from "../../../infrastructure/webhooks/services/webhook-inbound.service";
import { WebhookHmacService } from "../../../infrastructure/webhooks/services/webhook-hmac.service";
import { WebhookEventService } from "../../../infrastructure/webhooks/services/webhook-event.service";
import {
  WebhookSubscription,
  WebhookSubscriptionStatus,
} from "../../../infrastructure/webhooks/entities/webhook-subscription.entity";
import { createGlobalValidationPipe } from "../../../common/pipes/validation.pipe";
import { SanitizePipe } from "../../../common/pipes/sanitize.pipe";
import {
  arraySource,
  EventReplayEngine,
  InMemoryCheckpointStore,
  InMemoryProjectionStore,
  ReplayAbortedError,
  ReplayReport,
  StoredEvent,
} from "../../../common/events/replay/event-replay";
import {
  DEFAULT_UPCASTERS,
  EventUpcasterRegistry,
} from "../../../common/events/replay/event-upcaster";
import { userDirectoryProjection } from "../../../common/events/replay/projections/user-directory.projection";
import {
  CORPUS_NOW_MS,
  FIXTURE_TARGETS,
  FixtureTarget,
  GoldenFixture,
  loadCorpus,
  REQUIRED_CATEGORIES,
} from "./corpus";

/**
 * Executes the golden fixture corpus (#208) against the real validation
 * paths. Each fixture is a checked-in adversarial input plus the golden
 * outcome; this spec routes it to production code and asserts the outcome.
 */

const corpus = loadCorpus();
const executed = new Set<string>();

// ── Target runners ────────────────────────────────────────────────────────

function runWebhookSignature(
  input: Record<string, any>,
): ReturnType<WebhookSignatureService["verify"]> {
  const secrets = (input.secrets ?? {}) as Record<string, string>;
  const config = {
    get: (key: string, fallback?: unknown) => secrets[key] ?? fallback,
  } as unknown as ConfigService;

  return new WebhookSignatureService(config).verify({
    provider: input.provider,
    headers: input.headers,
    rawBody:
      input.rawBody === null || input.rawBody === undefined
        ? null
        : Buffer.from(String(input.rawBody), "utf8"),
    now:
      input.nowSeconds === undefined
        ? undefined
        : Number(input.nowSeconds) * 1000,
  });
}

async function runWebhookSignatureCase(fixture: GoldenFixture): Promise<void> {
  const result = runWebhookSignature(fixture.input);
  const expected = fixture.expected;

  if (expected.ok === true) {
    expect(result).toMatchObject({
      ok: true,
      provider: fixture.input.provider,
    });
    return;
  }

  expect(result).toMatchObject({
    ok: false,
    reason: expected.reason,
    status: expected.status,
  });
}

function inboundService(input: Record<string, any>): {
  service: WebhookInboundService;
} {
  const subscription =
    input.subscription === "missing"
      ? null
      : ({
          id: input.subscriptionId,
          signingKey: input.signingKey,
          status: WebhookSubscriptionStatus.ACTIVE,
          events: input.events ?? ["*"],
        } as unknown as WebhookSubscription);

  const subscriptions = {
    findOne: jest.fn().mockResolvedValue(subscription),
  };

  const publishEvent =
    input.publish === "duplicate-conflict"
      ? jest.fn().mockRejectedValue(
          new ConflictException({
            statusCode: 409,
            error: "Conflict",
            reason: "duplicate_event",
            message: "This webhook event ID has already been processed.",
          }),
        )
      : jest.fn().mockResolvedValue({ id: "stored-event" });

  const events = { publishEvent } as unknown as WebhookEventService;
  const config = {
    get: (_key: string, fallback?: unknown) => fallback,
  } as unknown as ConfigService;

  return {
    service: new WebhookInboundService(
      subscriptions as never,
      events,
      new WebhookHmacService(),
      config,
    ),
  };
}

async function runWebhookInboundCase(fixture: GoldenFixture): Promise<void> {
  const input = fixture.input as Record<string, any>;
  const { service } = inboundService(input);

  const headers: Record<string, string> = { ...input.headers };
  if (!headers["x-webhook-signature"]) {
    // Fixtures that need a *valid* signature let the runner compute one over
    // the fixture's own body and timestamp; adversarial fixtures pin their
    // bad signature explicitly and are used verbatim.
    headers["x-webhook-signature"] = new WebhookHmacService().signTimestamped(
      String(input.rawBody),
      String(input.signingKey),
      headers["x-webhook-timestamp"],
    );
  }

  const expected = fixture.expected;

  if (expected.accepted === true) {
    await expect(
      service.accept(
        input.subscriptionId,
        Buffer.from(String(input.rawBody), "utf8"),
        headers,
        input.nowMillis ?? CORPUS_NOW_MS,
      ),
    ).resolves.toMatchObject({ accepted: true, duplicate: false });
    return;
  }

  try {
    await service.accept(
      input.subscriptionId,
      Buffer.from(String(input.rawBody), "utf8"),
      headers,
      input.nowMillis ?? CORPUS_NOW_MS,
    );
    throw new Error(`expected rejection (${expected.reason}) but accepted`);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const httpError = error as HttpException;
    expect(httpError.getStatus()).toBe(expected.status);
    expect(httpError.getResponse()).toMatchObject({
      reason: expected.reason,
    });
  }
}

const API_DTOS: Record<string, Type | undefined> = {
  CreatePaymentDto,
  SubmitPayloadDto,
};

async function runApiBodyCase(fixture: GoldenFixture): Promise<void> {
  const input = fixture.input as Record<string, any>;
  const metatype = API_DTOS[input.dto];

  if (metatype === undefined) {
    throw new Error(`unknown api.body-validation dto "${input.dto}"`);
  }

  const metadata: ArgumentMetadata = { type: "body", metatype };
  const sanitized = new SanitizePipe().transform(input.payload, metadata);

  try {
    const value = await createGlobalValidationPipe().transform(
      sanitized,
      metadata,
    );

    if (fixture.expected.rejected !== false) {
      throw new Error("expected validation rejection but body was accepted");
    }

    expect(value).toMatchObject(fixture.expected.sanitized);
  } catch (error) {
    if (!(error instanceof BadRequestException)) {
      throw error;
    }

    const body = error.getResponse() as { errors?: Array<{ field: string }> };
    const fields = (body.errors ?? []).map((entry) => entry.field).sort();

    expect(fixture.expected.rejected).toBe(true);
    expect(fields).toEqual(fixture.expected.fields);
  }
}

function replayEngine(): EventReplayEngine {
  const upcasters = new EventUpcasterRegistry();
  DEFAULT_UPCASTERS.forEach((upcaster) => upcasters.register(upcaster));

  return new EventReplayEngine(
    new InMemoryCheckpointStore(),
    new InMemoryProjectionStore(),
    upcasters,
  );
}

async function runEventsReplayCase(fixture: GoldenFixture): Promise<void> {
  const input = fixture.input as Record<string, any>;
  const events = input.events as StoredEvent[];
  const expected = fixture.expected;

  if (expected.rejected === true) {
    const attempt = replayEngine().rebuild(
      userDirectoryProjection,
      arraySource(events),
      { resume: false },
    );

    try {
      await attempt;
      throw new Error(`expected replay rejection (${expected.errorMatches})`);
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayAbortedError);
      expect((error as Error).message).toMatch(
        new RegExp(expected.errorMatches),
      );
      expect((error as ReplayAbortedError).report.outcome).toBe(
        expected.reportOutcome,
      );
    }
    return;
  }

  const report: ReplayReport = await replayEngine().rebuild(
    userDirectoryProjection,
    arraySource(events),
    { resume: false, ...input.options },
  );

  expect(report.outcome).toBe(expected.outcome);

  if (expected.applied !== undefined) {
    expect(report.applied).toBe(expected.applied);
  }
  if (expected.upcasts !== undefined) {
    expect(report.upcasts).toEqual(expected.upcasts);
  }
  if (expected.poisonEvents !== undefined) {
    expect(report.poisonEvents).toHaveLength(expected.poisonEvents.length);
    for (const poison of expected.poisonEvents) {
      const match = report.poisonEvents.find(
        (entry) => entry.sequence === poison.sequence,
      );
      expect(match).toBeDefined();
      expect(match?.eventName).toBe(poison.eventName);
      expect(match?.reason).toMatch(new RegExp(poison.reasonMatches));
    }
  }
}

const RUNNERS: Record<
  FixtureTarget,
  (fixture: GoldenFixture) => Promise<void>
> = {
  "payments.webhook-signature": runWebhookSignatureCase,
  "webhooks.inbound": runWebhookInboundCase,
  "api.body-validation": runApiBodyCase,
  "events.replay": runEventsReplayCase,
};

// ── Corpus integrity ──────────────────────────────────────────────────────

describe("golden fixture corpus: integrity", () => {
  it("loads at least one fixture for every required category", () => {
    const categories = new Set(corpus.map(({ fixture }) => fixture.category));
    expect([...categories].sort()).toEqual([...REQUIRED_CATEGORIES].sort());
  });

  it("has unique ids that match file names and category directories", () => {
    const seen = new Set<string>();

    for (const { fixture, file } of corpus) {
      expect(seen.has(fixture.id)).toBe(false);
      seen.add(fixture.id);

      expect(file.endsWith(`${fixture.id}.json`)).toBe(true);
      expect(file.includes(`/${fixture.category}/`)).toBe(true);
      expect(fixture.category).toBe(file.split("/").slice(-2)[0]);
      expect(fixture.description.length).toBeGreaterThan(0);
    }
  });

  it("targets only known validation paths with complete golden expectations", () => {
    for (const { fixture } of corpus) {
      expect(FIXTURE_TARGETS).toContain(fixture.target);

      const expected = fixture.expected;
      const hasGolden =
        expected.ok === true ||
        expected.ok === false ||
        expected.accepted === true ||
        expected.status !== undefined ||
        expected.rejected !== undefined ||
        expected.outcome !== undefined;
      expect(hasGolden).toBe(true);
    }
  });

  it("contains no unresolved generator placeholders", () => {
    for (const { file } of corpus) {
      expect(fs.readFileSync(file, "utf8")).not.toMatch(/__COMPUTE_/);
    }
  });
});

// ── Corpus execution against the real validation paths ────────────────────

describe("golden fixture corpus: execution", () => {
  it.each(corpus.map((loaded) => [loaded.fixture.id, loaded] as const))(
    "%s",
    async (_id, loaded) => {
      executed.add(loaded.fixture.id);
      await RUNNERS[loaded.fixture.target](loaded.fixture);
    },
  );

  it("executed every checked-in fixture", () => {
    expect([...executed].sort()).toEqual(
      corpus.map(({ fixture }) => fixture.id).sort(),
    );
  });
});

import { SyntheticMonitoringService } from "./synthetic-monitoring.service";
import {
  PAYMENT_PIPELINE_JOURNEY,
  classifyStatus,
  createPaymentPipelineJourney,
} from "./payment-pipeline-probe";

const TOKEN = "probe-token-do-not-leak";
const BASE = "https://api.test.example";
const AUTH = "/api/v1/auth/status";
const PROCESSORS = "/api/v1/payments/processors";

type Responder = (
  url: string,
  init: RequestInit,
) => Promise<Response> | Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Routes each request to the next scripted responder for its path. */
function scriptedFetch(script: Record<string, Responder[]>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = String(input);
    const path = new URL(url).pathname;
    calls.push({
      url: path,
      auth: new Headers(init.headers).get("authorization"),
    });
    const queue = script[path] ?? [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new Error(`no script for ${path}`);
    return next(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const okAuth: Responder = () =>
  json(200, { isAuthenticated: true, user: { id: "svc" } });
const okProcessors: Responder = () =>
  json(200, [{ name: "stellar", enabled: true, displayName: "Stellar" }]);

async function runProbe(
  options: Parameters<typeof createPaymentPipelineJourney>[0],
) {
  const monitor = new SyntheticMonitoringService();
  monitor.register(createPaymentPipelineJourney(options));
  return monitor.run(PAYMENT_PIPELINE_JOURNEY);
}

const base = {
  baseUrl: BASE,
  probeToken: TOKEN,
  retryDelayMs: 0,
  sleep: async () => undefined,
};

describe("payment pipeline synthetic probe (#530)", () => {
  describe("normal path", () => {
    it("passes all steps and sends the bearer credential on each request", async () => {
      const { fetchImpl, calls } = scriptedFetch({
        [AUTH]: [okAuth],
        [PROCESSORS]: [okProcessors],
      });

      const result = await runProbe({ ...base, fetchImpl });

      expect(result.passed).toBe(true);
      expect(result.steps.map((s) => s.status)).toEqual([
        "pass",
        "pass",
        "pass",
      ]);
      // Processor list is fetched once and reused for the enabled check.
      expect(calls.map((c) => c.url)).toEqual([AUTH, PROCESSORS]);
      expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    });
  });

  describe("failure path", () => {
    it("fails the pipeline when no processor is enabled, without retrying", async () => {
      const { fetchImpl, calls } = scriptedFetch({
        [AUTH]: [okAuth],
        [PROCESSORS]: [() => json(200, [{ name: "stellar", enabled: false }])],
      });

      const result = await runProbe({ ...base, fetchImpl, maxAttempts: 3 });

      expect(result.passed).toBe(false);
      const last = result.steps.find((s) => s.name === "enabled-processor");
      expect(last?.status).toBe("fail");
      expect(last?.error).toMatch(/no payment processor is enabled/);
      expect(calls.filter((c) => c.url === PROCESSORS)).toHaveLength(1);
    });

    it("skips the remaining steps after the first failure", async () => {
      const { fetchImpl } = scriptedFetch({
        [AUTH]: [() => json(401, { message: "unauthorized" })],
        [PROCESSORS]: [okProcessors],
      });

      const result = await runProbe({ ...base, fetchImpl });

      expect(result.passed).toBe(false);
      expect(result.steps.map((s) => s.status)).toEqual([
        "fail",
        "skip",
        "skip",
      ]);
    });

    it("treats a non-JSON success body as a client failure", async () => {
      const { fetchImpl } = scriptedFetch({
        [AUTH]: [() => new Response("<html>gateway</html>", { status: 200 })],
      });
      const result = await runProbe({ ...base, fetchImpl });
      expect(result.steps[0].error).toMatch(/non-JSON body/);
    });

    it("does not retry a 4xx client error", async () => {
      const { fetchImpl, calls } = scriptedFetch({
        [AUTH]: [() => json(404, {})],
      });
      const result = await runProbe({ ...base, fetchImpl, maxAttempts: 4 });
      expect(result.passed).toBe(false);
      expect(calls.filter((c) => c.url === AUTH)).toHaveLength(1);
    });
  });

  describe("retry path", () => {
    it("retries a 5xx and passes once the upstream recovers", async () => {
      const { fetchImpl, calls } = scriptedFetch({
        [AUTH]: [() => json(503, {}), okAuth],
        [PROCESSORS]: [okProcessors],
      });

      const result = await runProbe({ ...base, fetchImpl, maxAttempts: 2 });

      expect(result.passed).toBe(true);
      expect(calls.filter((c) => c.url === AUTH)).toHaveLength(2);
    });

    it("gives up after maxAttempts on persistent 5xx", async () => {
      const { fetchImpl, calls } = scriptedFetch({
        [AUTH]: [() => json(500, {})],
      });
      const result = await runProbe({ ...base, fetchImpl, maxAttempts: 3 });
      expect(result.passed).toBe(false);
      expect(calls.filter((c) => c.url === AUTH)).toHaveLength(3);
    });

    it("retries a network error", async () => {
      let attempts = 0;
      const { fetchImpl } = scriptedFetch({
        [AUTH]: [
          () => {
            attempts++;
            throw new TypeError("fetch failed");
          },
          okAuth,
        ],
        [PROCESSORS]: [okProcessors],
      });
      const result = await runProbe({ ...base, fetchImpl, maxAttempts: 2 });
      expect(result.passed).toBe(true);
      expect(attempts).toBe(1);
    });

    it("times out a hung request and classifies it as a retryable timeout", async () => {
      const hangs: Responder = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      const { fetchImpl, calls } = scriptedFetch({ [AUTH]: [hangs] });

      const result = await runProbe({
        ...base,
        fetchImpl,
        stepTimeoutMs: 20,
        maxAttempts: 2,
      });

      expect(result.passed).toBe(false);
      expect(result.steps[0].error).toMatch(/timed out after 20ms/);
      expect(calls.filter((c) => c.url === AUTH)).toHaveLength(2);
    });
  });

  describe("authorization path", () => {
    it("fails without retrying when the credential is rejected", async () => {
      const { fetchImpl, calls } = scriptedFetch({
        [AUTH]: [() => json(403, {})],
      });
      const result = await runProbe({ ...base, fetchImpl, maxAttempts: 3 });
      expect(result.passed).toBe(false);
      expect(calls.filter((c) => c.url === AUTH)).toHaveLength(1);
      expect(result.steps[0].error).toMatch(/responded 403/);
    });

    it("fails an auth/status response that is not an authenticated session", async () => {
      const { fetchImpl } = scriptedFetch({
        [AUTH]: [() => json(200, { isAuthenticated: false, user: null })],
      });
      const result = await runProbe({ ...base, fetchImpl });
      expect(result.passed).toBe(false);
      expect(result.steps[0].error).toMatch(
        /did not report an authenticated session/,
      );
    });

    it("sends no request at all when no credential is configured (fail closed)", async () => {
      const { fetchImpl, calls } = scriptedFetch({ [AUTH]: [okAuth] });
      const result = await runProbe({ ...base, probeToken: "   ", fetchImpl });
      expect(result.passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(result.steps[0].error).toMatch(/no probe credential configured/);
    });

    it("never echoes the credential into a step error", async () => {
      const { fetchImpl } = scriptedFetch({
        [AUTH]: [() => json(401, { echo: TOKEN })],
      });
      const result = await runProbe({ ...base, fetchImpl });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });
  });

  describe("configuration", () => {
    it("classifies status codes", () => {
      expect(classifyStatus(204)).toBeNull();
      expect(classifyStatus(401)).toBe("authorization");
      expect(classifyStatus(403)).toBe("authorization");
      expect(classifyStatus(422)).toBe("client");
      expect(classifyStatus(502)).toBe("server");
    });

    it("rejects a plaintext non-local base URL", () => {
      expect(() =>
        createPaymentPipelineJourney({
          ...base,
          baseUrl: "http://api.example.org",
        }),
      ).toThrow(/must use https/);
    });

    it("accepts a plaintext localhost base URL and strips the trailing slash", async () => {
      const seen: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return json(200, { isAuthenticated: true });
      }) as unknown as typeof fetch;

      await runProbe({ ...base, baseUrl: "http://localhost:3000/", fetchImpl });
      expect(seen[0]).toBe(`http://localhost:3000${AUTH}`);
    });

    it("rejects an unparseable base URL", () => {
      expect(() =>
        createPaymentPipelineJourney({ ...base, baseUrl: "not a url" }),
      ).toThrow(/invalid baseUrl/);
    });
  });
});

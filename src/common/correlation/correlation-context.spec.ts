import {
  CORRELATION_ID_HEADER,
  JOB_CORRELATION_FIELD,
  MAX_CORRELATION_ID_LENGTH,
  REQUEST_ID_HEADER,
  getCorrelationContext,
  getCorrelationId,
  normalizeCorrelationId,
  resolveInboundCorrelationId,
  runJobWithCorrelation,
  runWithCorrelation,
  withCorrelationHeaders,
  withJobCorrelation,
} from "./correlation-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("correlation context (#270)", () => {
  describe("normalizeCorrelationId", () => {
    it.each([
      ["req-123", "req-123"],
      ["  padded_id  ", "padded_id"],
      [["first-id", "second-id"], "first-id"],
      ["a".repeat(MAX_CORRELATION_ID_LENGTH), "a".repeat(MAX_CORRELATION_ID_LENGTH)],
    ])("accepts %p", (raw, expected) => {
      expect(normalizeCorrelationId(raw)).toBe(expected);
    });

    it.each([
      ["empty", ""],
      ["whitespace", "   "],
      ["too long", "a".repeat(MAX_CORRELATION_ID_LENGTH + 1)],
      ["CRLF header injection", "abc\r\nSet-Cookie: session=evil"],
      ["log forging newline", "abc\n{\"level\":\"error\"}"],
      ["path characters", "../../etc/passwd"],
      ["spaces inside", "two words"],
      ["non-string", 42],
      ["undefined", undefined],
    ])("rejects %s", (_label, raw) => {
      expect(normalizeCorrelationId(raw)).toBeNull();
    });
  });

  describe("resolveInboundCorrelationId", () => {
    it("prefers x-correlation-id over x-request-id", () => {
      expect(
        resolveInboundCorrelationId({
          [CORRELATION_ID_HEADER]: "corr-1",
          [REQUEST_ID_HEADER]: "req-1",
        }),
      ).toEqual({ correlationId: "corr-1", source: "header", rejected: false });
    });

    it("falls back to x-request-id for existing clients", () => {
      expect(
        resolveInboundCorrelationId({ [REQUEST_ID_HEADER]: "req-1" }),
      ).toMatchObject({ correlationId: "req-1", source: "header" });
    });

    it("skips an invalid preferred header and uses a valid fallback", () => {
      expect(
        resolveInboundCorrelationId({
          [CORRELATION_ID_HEADER]: "bad id\r\n",
          [REQUEST_ID_HEADER]: "req-1",
        }),
      ).toMatchObject({ correlationId: "req-1", source: "header" });
    });

    it("generates a UUID and flags rejection when every supplied value is invalid", () => {
      const resolved = resolveInboundCorrelationId({
        [CORRELATION_ID_HEADER]: "x".repeat(10_000),
      });
      expect(resolved.correlationId).toMatch(UUID);
      expect(resolved).toMatchObject({ source: "generated", rejected: true });
    });

    it("generates a UUID without flagging rejection when nothing is supplied", () => {
      const resolved = resolveInboundCorrelationId({});
      expect(resolved.correlationId).toMatch(UUID);
      expect(resolved.rejected).toBe(false);
    });
  });

  describe("async context", () => {
    it("is undefined outside a correlated scope", () => {
      expect(getCorrelationId()).toBeUndefined();
    });

    it("survives awaits and timers inside the scope", async () => {
      await runWithCorrelation("scope-1", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await Promise.resolve();
        expect(getCorrelationId()).toBe("scope-1");
      });
      expect(getCorrelationId()).toBeUndefined();
    });

    it("isolates concurrent requests from each other", async () => {
      const seen = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          runWithCorrelation(`req-${i}`, async () => {
            await new Promise((resolve) => setTimeout(resolve, 25 - i));
            return getCorrelationId();
          }),
        ),
      );
      expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `req-${i}`));
    });
  });

  describe("outbound headers", () => {
    it("adds both headers inside a correlated scope", () => {
      runWithCorrelation("out-1", () => {
        expect(withCorrelationHeaders({ Accept: "application/json" })).toEqual({
          Accept: "application/json",
          [CORRELATION_ID_HEADER]: "out-1",
          [REQUEST_ID_HEADER]: "out-1",
        });
      });
    });

    it("never overrides a header the caller set, in any letter case", () => {
      runWithCorrelation("out-1", () => {
        expect(
          withCorrelationHeaders({ "X-Correlation-Id": "explicit" }),
        ).toEqual({ "X-Correlation-Id": "explicit", [REQUEST_ID_HEADER]: "out-1" });
      });
    });

    it("leaves headers untouched outside a correlated scope", () => {
      const headers = { Accept: "application/json" };
      expect(withCorrelationHeaders(headers)).toBe(headers);
    });
  });

  describe("jobs", () => {
    it("stamps the enqueuing request's ID onto the payload", () => {
      runWithCorrelation("enqueue-1", () => {
        expect(withJobCorrelation({ deliveryId: "d1" })).toEqual({
          deliveryId: "d1",
          [JOB_CORRELATION_FIELD]: "enqueue-1",
        });
      });
    });

    it("does not stamp anything outside a correlated scope", () => {
      expect(withJobCorrelation({ deliveryId: "d1" })).toEqual({ deliveryId: "d1" });
    });

    it("restores the stamped ID for the worker, including on every retry", async () => {
      const job = { deliveryId: "d1", [JOB_CORRELATION_FIELD]: "enqueue-1" };
      for (let attempt = 0; attempt < 3; attempt++) {
        await runJobWithCorrelation(job, async (id) => {
          await Promise.resolve();
          expect(id).toBe("enqueue-1");
          expect(getCorrelationContext()).toEqual({
            correlationId: "enqueue-1",
            source: "job",
          });
        });
      }
    });

    it("replaces a tampered stamp and falls back for legacy jobs", () => {
      runJobWithCorrelation({ [JOB_CORRELATION_FIELD]: "bad\nid" }, (id) => {
        expect(id).toMatch(UUID);
        expect(getCorrelationContext()?.source).toBe("generated");
      });
      runJobWithCorrelation({ deliveryId: "legacy" }, (id) => expect(id).toMatch(UUID));
      runJobWithCorrelation(undefined, (id) => expect(id).toMatch(UUID));
    });
  });
});

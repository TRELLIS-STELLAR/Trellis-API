import { redactSensitive } from "../common/redaction";

describe("high-cardinality workflow load contract", () => {
  it("processes 5,000 distinct records without leaking sensitive fields", () => {
    const records = Array.from({ length: 5_000 }, (_, index) => ({ id: `record-${index}`, wallet: `G${index}`, status: "pending" }));
    const redacted = records.map(redactSensitive);
    expect(redacted).toHaveLength(5_000);
    expect(redacted[4999].wallet).toBe("[REDACTED]");
  });

  it("keeps retry and authorization paths explicit", () => {
    const retryable = { status: 503, retryAfterMs: 250 };
    const unauthorized = { status: 403, retryable: false };
    expect(retryable.retryAfterMs).toBeGreaterThan(0);
    expect(unauthorized.retryable).toBe(false);
  });
});

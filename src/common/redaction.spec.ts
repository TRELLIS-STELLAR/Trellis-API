import { redactSensitive } from "./redaction";

describe("sensitive telemetry redaction", () => {
  it("redacts wallet, secret, and transaction fields recursively", () => {
    const value = { walletAddress: "G...", nested: { secret: "s", transactionHash: "tx" }, ok: "visible" };
    expect(redactSensitive(value)).toEqual({ walletAddress: "[REDACTED]", nested: { secret: "[REDACTED]", transactionHash: "[REDACTED]" }, ok: "visible" });
  });

  it("does not recurse forever on cycles", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(redactSensitive(value)).toEqual({ self: "[Circular]" });
  });
});

import { createAdminAuditReceipt, explainRejectedAction, IdempotencyStore } from "./trellis-hardening";

describe("Trellis operational hardening", () => {
  it("rejects a reused idempotency key with a different request", () => {
    const store = new IdempotencyStore<string>();
    store.put("key", "request-a", "accepted", 60_000, 100);
    expect(() => store.put("key", "request-b", "accepted", 60_000, 101)).toThrow("idempotency");
  });

  it("creates deterministic audit receipts for equivalent payloads", () => {
    const first = createAdminAuditReceipt({ action: "freeze", actorId: "admin", resource: "bond-1", requestId: "req-1", payload: { b: 2, a: 1 } });
    const second = createAdminAuditReceipt({ action: "freeze", actorId: "admin", resource: "bond-1", requestId: "req-1", payload: { a: 1, b: 2 } });
    expect(first.payloadHash).toBe(second.payloadHash);
  });

  it("returns a safe next action for rejected operations", () => {
    expect(explainRejectedAction("STALE_VERSION").nextAction).toMatch(/Refresh/);
    expect(explainRejectedAction("UNKNOWN").message).toBeTruthy();
  });
});

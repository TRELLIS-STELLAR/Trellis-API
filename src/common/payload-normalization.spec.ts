import { hashSignedPayload, normalizeSignedPayload } from "./payload-normalization";

describe("signed payload normalization", () => {
  it("sorts keys and renders equivalent payloads with one hash", () => {
    expect(hashSignedPayload({ b: 2, a: { y: true, x: 1 } })).toBe(hashSignedPayload({ a: { x: 1, y: true }, b: 2 }));
  });

  it("rejects unsafe keys and imprecise numbers", () => {
    expect(() => normalizeSignedPayload({ __proto__: { polluted: true } })).toThrow();
    expect(() => normalizeSignedPayload({ amount: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});

import { hashSignedPayload, normalizeSignedPayload } from "./payload-normalization";

describe("signed payload normalization", () => {
  it("sorts keys and renders equivalent payloads with one hash", () => {
    expect(hashSignedPayload({ b: 2, a: { y: true, x: 1 } })).toBe(hashSignedPayload({ a: { x: 1, y: true }, b: 2 }));
  });

  it("rejects unsafe keys and imprecise numbers", () => {
    expect(() => normalizeSignedPayload({ __proto__: { polluted: true } })).toThrow();
    expect(() => normalizeSignedPayload({ amount: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });

  describe("boundary and malformed inputs", () => {
    it("accepts the largest and smallest safe integers", () => {
      expect(() => normalizeSignedPayload({ amount: Number.MAX_SAFE_INTEGER })).not.toThrow();
      expect(() => normalizeSignedPayload({ amount: Number.MIN_SAFE_INTEGER })).not.toThrow();
    });

    it("rejects values below the minimum safe integer", () => {
      expect(() => normalizeSignedPayload({ amount: Number.MIN_SAFE_INTEGER - 1 })).toThrow();
    });

    it("rejects NaN and infinite numbers", () => {
      expect(() => normalizeSignedPayload({ amount: Number.NaN })).toThrow();
      expect(() => normalizeSignedPayload({ amount: Number.POSITIVE_INFINITY })).toThrow();
      expect(() => normalizeSignedPayload({ amount: Number.NEGATIVE_INFINITY })).toThrow();
    });

    it("rejects unsafe keys at nested levels", () => {
      expect(() => normalizeSignedPayload({ outer: { __proto__: { polluted: true } } })).toThrow();
      expect(() => normalizeSignedPayload({ outer: { constructor: { prototype: {} } } })).toThrow();
    });

    it("handles empty objects and arrays deterministically", () => {
      expect(hashSignedPayload({})).toBe(hashSignedPayload({}));
      expect(hashSignedPayload({ list: [] })).toBe(hashSignedPayload({ list: [] }));
    });

    it("treats array order as significant", () => {
      expect(hashSignedPayload({ list: [1, 2] })).not.toBe(hashSignedPayload({ list: [2, 1] }));
    });

    it("produces a stable hash across repeated calls with malformed-looking but valid input", () => {
      const payload = { "key with spaces": "", unicode: "\u0000\uffff", nested: { z: [0, -0] } };
      expect(hashSignedPayload(payload)).toBe(hashSignedPayload(payload));
    });
  });
});

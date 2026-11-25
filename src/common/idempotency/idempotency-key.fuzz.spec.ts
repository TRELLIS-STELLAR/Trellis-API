import { BadRequestException } from "@nestjs/common";
import { IdempotencyService } from "./idempotency.service";

describe("idempotency input boundaries", () => {
  const service = new IdempotencyService({} as never);

  it("accepts only supported lengths without retaining invalid input across retries", () => {
    for (let length = 0; length <= 130; length += 1) {
      const key = "a".repeat(length);
      if (length >= 8 && length <= 128) {
        expect(service.assertValidKey(key)).toBe(key);
      } else {
        expect(() => service.assertValidKey(key)).toThrow(BadRequestException);
      }
    }
    expect(service.assertValidKey("  valid-key  ")).toBe("valid-key");
  });

  it("rejects malformed key characters and keeps equivalent retries scoped by actor", () => {
    for (const character of [" ", "\t", "\n", "/", "é", "🙂"]) {
      expect(() => service.assertValidKey(`valid${character}key`)).toThrow(BadRequestException);
    }
    expect(service.hashRequest({ amount: 1, memo: "tip" })).toBe(
      service.hashRequest({ memo: "tip", amount: 1 }),
    );
    expect(service.buildScope("POST", "/payments", "alice")).not.toBe(
      service.buildScope("POST", "/payments", "bob"),
    );
  });

  it("fuzzes random malformed keys and never accepts a key it would reject as a boundary", () => {
    // Deterministic pseudo-random fuzz: LCG so failures are reproducible.
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const alphabet = "abcXYZ019-_ /\\\t\n.:;\u00e9\u{1F642}";
    const chars = Array.from(alphabet);
    for (let i = 0; i < 500; i += 1) {
      const length = next() % 140;
      let key = "";
      for (let j = 0; j < length; j += 1) {
        key += chars[next() % chars.length];
      }
      const trimmed = key.trim();
      const valid = /^[A-Za-z0-9_-]+$/.test(trimmed) && trimmed.length >= 8 && trimmed.length <= 128;
      if (valid) {
        expect(service.assertValidKey(key)).toBe(trimmed);
      } else {
        expect(() => service.assertValidKey(key)).toThrow(BadRequestException);
      }
    }
  });
});

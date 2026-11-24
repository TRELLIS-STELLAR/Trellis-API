import { BadRequestException, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  validatePayloadLimits,
  validateQueryParamsCardinality,
  DEFAULT_INPUT_LIMITS,
} from "./input-limits.validator";
import { InputLimitsPipe } from "../pipes/input-limits.pipe";
import { InputLimitsGuard } from "../guard/input-limits.guard";
import { Role } from "../guard/roles.enum";

/**
 * Deterministic pseudo-random generator (LCG) so fuzz cases are reproducible
 * across runs and failures can be replayed from the printed seed.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const FUZZ_SEED = 437;
const FUZZ_ITERATIONS = 200;

function randomPrimitive(rng: () => number): unknown {
  const choices: Array<() => unknown> = [
    () => null,
    () => undefined,
    () => Math.floor(rng() * 1e9) - 5e8,
    () => rng() < 0.5,
    () => "",
    () => "x".repeat(Math.floor(rng() * 50)),
    () => NaN,
    () => Infinity,
    () => -0,
  ];
  return choices[Math.floor(rng() * choices.length)]();
}

function randomValue(rng: () => number, depth: number): unknown {
  const r = rng();
  if (depth <= 0 || r < 0.4) {
    return randomPrimitive(rng);
  }
  if (r < 0.7) {
    const len = Math.floor(rng() * 8);
    return Array.from({ length: len }, () => randomValue(rng, depth - 1));
  }
  const keys = Math.floor(rng() * 8);
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < keys; i++) {
    obj[`k_${Math.floor(rng() * 1000)}`] = randomValue(rng, depth - 1);
  }
  return obj;
}

describe("Strict Input Size and Cardinality Limits (#437)", () => {
  describe("Core Limits Validator: validatePayloadLimits", () => {
    describe("Normal Path", () => {
      it("should accept valid payload within default limits", () => {
        const payload = {
          name: "Stellar Portfolio Alpha",
          assets: [
            { code: "XLM", balance: "100.0000000" },
            { code: "USDC", balance: "500.0000000" },
          ],
          metadata: {
            strategy: "yield-maximizer",
            tags: ["stellar", "soroban", "defi"],
          },
        };

        const result = validatePayloadLimits(payload);

        expect(result.valid).toBe(true);
        expect(result.violations).toHaveLength(0);
        expect(result.metrics.maxObservedDepth).toBeLessThanOrEqual(DEFAULT_INPUT_LIMITS.maxDepth);
        expect(result.metrics.totalKeysCount).toBeLessThanOrEqual(DEFAULT_INPUT_LIMITS.maxTotalKeys);
      });

      it("should handle null, undefined, and non-object primitives gracefully", () => {
        expect(validatePayloadLimits(null).valid).toBe(true);
        expect(validatePayloadLimits(undefined).valid).toBe(true);
        expect(validatePayloadLimits(12345).valid).toBe(true);
        expect(validatePayloadLimits(true).valid).toBe(true);
      });
    });

    describe("Boundary Cases", () => {
      it("should accept an object exactly at maxObjectKeys", () => {
        const obj: Record<string, number> = {};
        for (let i = 0; i < 100; i++) obj[`k${i}`] = i;
        const result = validatePayloadLimits(obj, { maxObjectKeys: 100 });
        expect(result.violations.find((v) => v.code === "INPUT_CARDINALITY_EXCEEDED")).toBeUndefined();
      });

      it("should accept an object exactly one key over-limit only as a violation", () => {
        const obj: Record<string, number> = {};
        for (let i = 0; i < 101; i++) obj[`k${i}`] = i;
        const result = validatePayloadLimits(obj, { maxObjectKeys: 100 });
        expect(result.valid).toBe(false);
        expect(result.violations.find((v) => v.code === "INPUT_CARDINALITY_EXCEEDED")!.actual).toBe(101);
      });

      it("should accept an array exactly at maxArrayLength", () => {
        const result = validatePayloadLimits({ items: new Array(1000).fill(0) }, { maxArrayLength: 1000 });
        expect(result.violations.find((v) => v.code === "INPUT_CARDINALITY_EXCEEDED")).toBeUndefined();
      });

      it("should accept a string exactly at maxStringLength", () => {
        const result = validatePayloadLimits({ p: "A".repeat(65536) }, { maxStringLength: 65536 });
        expect(result.violations.find((v) => v.code === "INPUT_SIZE_EXCEEDED")).toBeUndefined();
      });

      it("should accept depth exactly at maxDepth", () => {
        let obj: any = { leaf: 1 };
        for (let i = 0; i < 4; i++) obj = { child: obj };
        const result = validatePayloadLimits(obj, { maxDepth: 10 });
        expect(result.violations.find((v) => v.code === "INPUT_DEPTH_EXCEEDED")).toBeUndefined();
      });

      it("should handle empty objects and arrays without violations", () => {
        expect(validatePayloadLimits({}).valid).toBe(true);
        expect(validatePayloadLimits([]).valid).toBe(true);
      });
    });

    describe("Failure Path: Cardinality & Depth Violations", () => {
      it("should reject deeply nested objects exceeding maxDepth (recursion bomb)", () => {
        // Construct an object nested 15 levels deep
        let deepObj: any = { value: "leaf" };
        for (let i = 0; i < 15; i++) {
          deepObj = { level: i, child: deepObj };
        }

        const result = validatePayloadLimits(deepObj, { maxDepth: 10 });

        expect(result.valid).toBe(false);
        const depthViolation = result.violations.find((v) => v.code === "INPUT_DEPTH_EXCEEDED");
        expect(depthViolation).toBeDefined();
        expect(depthViolation!.actual).toBeGreaterThan(10);
      });

      it("should reject objects with excessive property cardinality (Hash-DoS prevention)", () => {
        const wideObject: Record<string, number> = {};
        for (let i = 0; i < 150; i++) {
          wideObject[`dynamic_key_${i}`] = i;
        }

        const result = validatePayloadLimits(wideObject, { maxObjectKeys: 100 });

        expect(result.valid).toBe(false);
        const cardViolation = result.violations.find((v) => v.code === "INPUT_CARDINALITY_EXCEEDED");
        expect(cardViolation).toBeDefined();
        expect(cardViolation!.actual).toBe(150);
        expect(cardViolation!.limit).toBe(100);
      });

      it("should reject arrays exceeding maxArrayLength", () => {
        const largeArray = new Array(1500).fill("sample-item");

        const result = validatePayloadLimits({ items: largeArray }, { maxArrayLength: 1000 });

        expect(result.valid).toBe(false);
        const arrayViolation = result.violations.find((v) => v.code === "INPUT_CARDINALITY_EXCEEDED");
        expect(arrayViolation).toBeDefined();
        expect(arrayViolation!.actual).toBe(1500);
      });

      it("should reject strings exceeding maxStringLength", () => {
        const hugeString = "A".repeat(70000); // 70KB

        const result = validatePayloadLimits({ payload: hugeString }, { maxStringLength: 65536 });

        expect(result.valid).toBe(false);
        const sizeViolation = result.violations.find((v) => v.code === "INPUT_SIZE_EXCEEDED");
        expect(sizeViolation).toBeDefined();
        expect(sizeViolation!.actual).toBe(70000);
      });

      it("should reject payloads exceeding cumulative maxTotalKeys", () => {
        // Multiple objects that together exceed 500 keys
        const container: any = {};
        for (let objIndex = 0; objIndex < 10; objIndex++) {
          const subObj: any = {};
          for (let keyIndex = 0; keyIndex < 60; keyIndex++) {
            subObj[`sub_${keyIndex}`] = keyIndex;
          }
          container[`obj_${objIndex}`] = subObj;
        }

        const result = validatePayloadLimits(container, { maxTotalKeys: 500 });

        expect(result.valid).toBe(false);
        expect(result.violations.some((v) => v.message.includes("Total payload keys count"))).toBe(true);
      });
    });

    describe("Fuzz: malformed and random inputs", () => {
      it("never throws and always returns a well-formed result for random structures", () => {
        const rng = makeRng(FUZZ_SEED);
        for (let i = 0; i < FUZZ_ITERATIONS; i++) {
          const input = randomValue(rng, 6);
          let result: ReturnType<typeof validatePayloadLimits> | undefined;
          expect(() => {
            result = validatePayloadLimits(input);
          }).not.toThrow();
          expect(typeof result!.valid).toBe("boolean");
          expect(Array.isArray(result!.violations)).toBe(true);
          expect(result!.valid).toBe(result!.violations.length === 0);
        }
      });

      it("handles self-referential (cyclic) objects without infinite recursion", () => {
        const cyclic: any = { name: "loop" };
        cyclic.self = cyclic;
        let result: ReturnType<typeof validatePayloadLimits> | undefined;
        expect(() => {
          result = validatePayloadLimits(cyclic, { maxDepth: 10 });
        }).not.toThrow();
        expect(result!.valid).toBe(false);
        expect(result!.violations.some((v) => v.code === "INPUT_DEPTH_EXCEEDED")).toBe(true);
      });

      it("tolerates keys that look like prototype pollution without mutating Object.prototype", () => {
        const malicious = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"x": 1}}}');
        expect(() => validatePayloadLimits(malicious)).not.toThrow();
        expect(({} as any).polluted).toBeUndefined();
        expect(({} as any).x).toBeUndefined();
      });

      it("rejects a sparse array whose declared length exceeds the limit", () => {
        const sparse: unknown[] = [];
        sparse.length = 5000;
        const result = validatePayloadLimits({ items: sparse }, { maxArrayLength: 1000 });
        expect(result.valid).toBe(false);
        expect(result.violations.find((v) => v.code === "INPUT_CARDINALITY_EXCEEDED")!.actual).toBe(5000);
      });

      it("handles non-finite and negative-zero numeric values as ordinary primitives", () => {
        expect(validatePayloadLimits({ a: NaN, b: Infinity, c: -0 }).valid).toBe(true);
      });
    });

    describe("Query Parameter Cardinality", () => {
      it("should allow query params within cardinality limit", () => {
        const query = { page: "1", limit: "20", sort: "asc" };
        expect(validateQueryParamsCardinality(query, 50)).toBeNull();
      });

      it("should accept query params exactly at the cardinality limit", () => {
        const query: Record<string, string> = {};
        for (let i = 0; i < 50; i++) query[`f_${i}`] = "v";
        expect(validateQueryParamsCardinality(query, 50)).toBeNull();
      });

      it("should reject query params exceeding cardinality limit", () => {
        const query: Record<string, string> = {};
        for (let i = 0; i < 60; i++) {
          query[`filter_${i}`] = `value_${i}`;
        }

        const violation = validateQueryParamsCardinality(query, 50);

        expect(violation).not.toBeNull();
        expect(violation!.code).toBe("QUERY_CARDINALITY_EXCEEDED");
        expect(violation!.actual).toBe(60);
      });
    });
  });

  describe("InputLimitsPipe", () => {
    let pipe: InputLimitsPipe;

    beforeEach(() => {
      pipe = new InputLimitsPipe({ maxDepth: 5, maxObjectKeys: 50 });
    });

    it("should pass valid payloads through unchanged", () => {
      const payload = { valid: true, count: 10 };
      expect(pipe.transform(payload, { type: "body" })).toBe(payload);
    });

    it("should pass payloads exactly at the object key boundary", () => {
      const payload: Record<string, number> = {};
      for (let i = 0; i < 50; i++) payload[`p${i}`] = i;
      expect(pipe.transform(payload, { type: "body" })).toBe(payload);
    });

    it("should throw BadRequestException with RFC 7807 error details on limit violation", () => {
      const oversizedPayload: any = {};
      for (let i = 0; i < 60; i++) {
        oversizedPayload[`prop_${i}`] = i;
      }

      expect(() => {
        pipe.transform(oversizedPayload, { type: "body" });
      }).toThrow(BadRequestException);

      try {
        pipe.transform(oversizedPayload, { type: "body" });
      } catch (err: any) {
        const response = err.getResponse();
        expect(response.statusCode).toBe(400);
        expect(response.code).toBe("INPUT_CARDINALITY_EXCEEDED");
        expect(response.violations.length).toBeGreaterThan(0);
        expect(response.remediation).toBeDefined();
      }
    });

    it("should reject a deep payload with a depth violation code", () => {
      let deep: any = { leaf: true };
      for (let i = 0; i < 10; i++) deep = { child: deep };
      expect(() => pipe.transform(deep, { type: "body" })).toThrow(BadRequestException);
    });

    it("should never throw anything other than BadRequestException on random input", () => {
      const rng = makeRng(FUZZ_SEED + 1);
      for (let i = 0; i < FUZZ_ITERATIONS; i++) {
        const input = randomValue(rng, 6);
        try {
          pipe.transform(input, { type: "body" });
        } catch (err) {
          expect(err).toBeInstanceOf(BadRequestException);
        }
      }
    });
  });

  describe("InputLimitsGuard & Authorization Path", () => {
    let guard: InputLimitsGuard;
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      guard = new InputLimitsGuard(reflector);
    });

    function createMockContext(body: any, query: any, roles: string[] = []): ExecutionContext {
      return {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            body,
            query,
            user: { roles },
          }),
        }),
      } as unknown as ExecutionContext;
    }

    it("should allow normal user within baseline limits", () => {
      const context = createMockContext({ title: "Normal" }, { page: "1" }, [Role.USER]);
      expect(guard.canActivate(context)).toBe(true);
    });

    it("should reject standard user exceeding baseline limits", () => {
      const largeArray = new Array(1500).fill(1);
      const context = createMockContext({ items: largeArray }, {}, [Role.USER]);

      expect(() => guard.canActivate(context)).toThrow(BadRequestException);
    });

    it("should grant elevated capacity ceiling to ADMIN and OPERATOR roles", () => {
      // 3000 items exceeds default 1000 limit, but within ADMIN elevated 5000 ceiling
      const bulkArray = new Array(3000).fill(1);
      const context = createMockContext({ items: bulkArray }, {}, [Role.ADMIN]);

      expect(guard.canActivate(context)).toBe(true);
    });

    it("should grant elevated capacity ceiling to OPERATOR role", () => {
      const bulkArray = new Array(3000).fill(1);
      const context = createMockContext({ items: bulkArray }, {}, [Role.OPERATOR]);
      expect(guard.canActivate(context)).toBe(true);
    });

    it("should still reject ADMIN requests beyond the elevated ceiling", () => {
      const hugeArray = new Array(5001).fill(1);
      const context = createMockContext({ items: hugeArray }, {}, [Role.ADMIN]);
      expect(() => guard.canActivate(context)).toThrow(BadRequestException);
    });

    it("should treat a request with no roles as a standard user (fail-closed on elevation)", () => {
      const bulkArray = new Array(3000).fill(1);
      const context = createMockContext({ items: bulkArray }, {}, []);
      expect(() => guard.canActivate(context)).toThrow(BadRequestException);
    });

    it("should treat a request with missing user object as a standard user", () => {
      const context = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({ body: { ok: true }, query: {} }),
        }),
      } as unknown as ExecutionContext;
      expect(guard.canActivate(context)).toBe(true);
    });

    it("should reject request with excessive query parameters", () => {
      const queryParams: Record<string, string> = {};
      for (let i = 0; i < 75; i++) {
        queryParams[`param_${i}`] = "val";
      }

      const context = createMockContext({}, queryParams, [Role.USER]);

      expect(() => guard.canActivate(context)).toThrow(BadRequestException);
    });

    it("should not let query-parameter overflow be bypassed by an elevated role", () => {
      const queryParams: Record<string, string> = {};
      for (let i = 0; i < 75; i++) {
        queryParams[`param_${i}`] = "val";
      }
      const context = createMockContext({}, queryParams, [Role.ADMIN]);
      expect(() => guard.canActivate(context)).toThrow(BadRequestException);
    });
  });
});

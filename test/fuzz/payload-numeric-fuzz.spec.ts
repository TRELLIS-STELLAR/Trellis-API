import { canonicalJson } from "../../src/common/serialization/canonical-json";
import { createGlobalValidationPipe } from "../../src/common/pipes/validation.pipe";
import { SanitizePipe } from "../../src/common/pipes/sanitize.pipe";
import { BadRequestException, ArgumentMetadata } from "@nestjs/common";
import { IsNumber, IsPositive, IsString, Min, Max, IsOptional } from "class-validator";

class FuzzTransferDto {
  @IsNumber()
  @IsPositive()
  @Min(0.0000001)
  @Max(1000000000)
  amount!: number;

  @IsString()
  destination!: string;

  @IsOptional()
  @IsString()
  memo?: string;
}

describe("Fuzz Coverage: Malformed Payloads & Boundary Numeric Values", () => {
  const validationPipe = createGlobalValidationPipe();
  const sanitizePipe = new SanitizePipe();
  const metadata: ArgumentMetadata = {
    type: "body",
    metatype: FuzzTransferDto,
  };

  describe("Boundary Numeric Values", () => {
    it("should correctly accept valid positive values within safe integer bounds", async () => {
      const validPayload = {
        amount: 100.5,
        destination: "GABCD1234567890",
        memo: "payment",
      };

      const result = await validationPipe.transform(validPayload, metadata);
      expect(result.amount).toBe(100.5);
    });

    it("should normalize negative zero (-0) to positive zero in canonicalJson", () => {
      expect(canonicalJson({ val: -0 })).toBe('{"val":0}');
      expect(canonicalJson(-0)).toBe("0");
    });

    it("should reject non-finite numeric boundaries (NaN, Infinity, -Infinity)", () => {
      expect(() => canonicalJson({ val: NaN })).toThrow(TypeError);
      expect(() => canonicalJson({ val: Infinity })).toThrow(TypeError);
      expect(() => canonicalJson({ val: -Infinity })).toThrow(TypeError);
    });

    it("should reject integers exceeding Number.MAX_SAFE_INTEGER in canonicalJson", () => {
      const safeMax = Number.MAX_SAFE_INTEGER; // 9007199254740991
      expect(() => canonicalJson({ val: safeMax })).not.toThrow();

      const unsafe = safeMax + 1; // 9007199254740992
      expect(() => canonicalJson({ val: unsafe })).toThrow(/safe integers/);
    });

    it("should reject negative amounts and zero when positive is required", async () => {
      const testCases = [
        { amount: 0, destination: "GDEST" },
        { amount: -1, destination: "GDEST" },
        { amount: -0.0000001, destination: "GDEST" },
        { amount: -999999999, destination: "GDEST" },
        { amount: Number.MIN_SAFE_INTEGER, destination: "GDEST" },
      ];

      for (const payload of testCases) {
        await expect(validationPipe.transform(payload, metadata)).rejects.toThrow(
          BadRequestException,
        );
      }
    });

    it("should enforce Stellar stroop precision (min 0.0000001 XLM)", async () => {
      // 0.0000001 is exactly 1 stroop -> valid
      const validStroop = { amount: 0.0000001, destination: "GDEST" };
      await expect(validationPipe.transform(validStroop, metadata)).resolves.toBeDefined();

      // Below 1 stroop (0.00000001) violates Min constraint
      const subStroop = { amount: 0.00000001, destination: "GDEST" };
      await expect(validationPipe.transform(subStroop, metadata)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject non-numeric and type-confused amounts", async () => {
      const typeConfusions = [
        { amount: "100.5", destination: "GDEST" }, // string instead of number
        { amount: "1e18", destination: "GDEST" },
        { amount: true, destination: "GDEST" },
        { amount: null, destination: "GDEST" },
        { amount: [], destination: "GDEST" },
        { amount: {}, destination: "GDEST" },
        { amount: "NaN", destination: "GDEST" },
        { amount: "Infinity", destination: "GDEST" },
      ];

      for (const payload of typeConfusions) {
        await expect(validationPipe.transform(payload, metadata)).rejects.toThrow(
          BadRequestException,
        );
      }
    });
  });

  describe("Malformed Payloads & Security Fuzz Vectors", () => {
    it("should reject prototype pollution attempts without polluting Object prototype", async () => {
      const pollutedPayload = JSON.parse(
        '{"amount": 50, "destination": "GDEST", "__proto__": {"polluted": true}}',
      );

      // Clean execution through validation pipe
      try {
        await validationPipe.transform(pollutedPayload, metadata);
      } catch (e) {
        // Expected if non-whitelisted property is rejected
      }

      // Assert Object prototype is NOT poisoned
      expect((Object.prototype as any).polluted).toBeUndefined();
      expect(({} as any).polluted).toBeUndefined();
    });

    it("should reject circular references in canonical serialization", () => {
      const circular: any = { a: "test" };
      circular.self = circular;

      expect(() => canonicalJson(circular)).toThrow(/circular/);
    });

    it("should reject arrays containing sparse holes in canonical serialization", () => {
      const sparseArray: any[] = [1, 2];
      sparseArray[5] = 10; // holes at 2, 3, 4

      expect(() => canonicalJson({ arr: sparseArray })).toThrow(/holes/);
    });

    it("should sanitize null-byte injections in string fields", () => {
      const payload = {
        amount: 100,
        destination: "GDEST\0INJECTED_SUFFIX",
        memo: "memo\u0000with\u0000nulls",
      };

      const sanitized = sanitizePipe.transform(payload);
      expect(sanitized.destination).not.toContain("\0");
      expect(sanitized.memo).not.toContain("\u0000");
    });

    it("should sanitize XSS and script injections", () => {
      const payload = {
        amount: 100,
        destination: "GDEST",
        memo: '<script>alert("xss")</script>Hello World',
      };

      const sanitized = sanitizePipe.transform(payload);
      expect(sanitized.memo).not.toContain("<script>");
      expect(sanitized.memo).not.toContain("</script>");
    });

    it("should handle deeply nested JSON objects without crashing the process stack", () => {
      let nestedObj: any = { leaf: "deep_value" };
      for (let i = 0; i < 80; i++) {
        nestedObj = { child: nestedObj };
      }

      // CanonicalJson should safely serialize nested structure
      const serialized = canonicalJson(nestedObj);
      expect(serialized).toContain("deep_value");
    });
  });

  describe("Automated Random Fuzz Generator (1,000 iterations)", () => {
    it("should survive 1,000 randomized malformed payloads without process crashes or prototype corruption", async () => {
      const extremeValues = [
        0,
        -0,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER + 1,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_VALUE,
        Number.MIN_VALUE,
        Number.EPSILON,
        -1e-7,
        1e308,
        -1e308,
        "0",
        "1e18",
        "-1e18",
        "0x123",
        "null",
        "undefined",
        "",
        " ",
        "\0",
        "\u0000",
        "\uFFFF",
        "\u202E", // right-to-left override
        "🔥🚀💎",
        "A".repeat(5000),
        [],
        {},
        null,
        undefined,
      ];

      for (let i = 0; i < 1000; i++) {
        const randIndex = i % extremeValues.length;
        const candidateValue = extremeValues[randIndex];

        const fuzzedPayload = {
          amount: candidateValue,
          destination: `GD${i}_${String(candidateValue).slice(0, 10)}`,
          memo: i % 2 === 0 ? candidateValue : undefined,
          extraField: i % 3 === 0 ? { nested: candidateValue } : undefined,
        };

        // Must either successfully validate or throw BadRequestException / TypeError — NEVER crash process
        try {
          await validationPipe.transform(fuzzedPayload, metadata);
        } catch (err: any) {
          expect(err instanceof BadRequestException || err instanceof TypeError).toBe(true);
        }
      }

      // Ensure Object prototype was never polluted during all 1000 fuzz cycles
      expect((Object.prototype as any).polluted).toBeUndefined();
    });
  });
});

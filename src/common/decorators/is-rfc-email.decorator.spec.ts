import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  IsRfcEmail,
  NormalizeEmail,
  isDisposableEmailDomain,
  normalizeEmail,
  parseRfcEmail,
} from "./is-rfc-email.decorator";

class TestUserEmailDto {
  @IsRfcEmail()
  email!: string;
}

class AllowDisposableDto {
  @IsRfcEmail(undefined, { blockDisposable: false })
  email!: string;
}

class CustomBlockListDto {
  @IsRfcEmail(undefined, {
    blockedDomains: ["blocked.example"],
    allowedDomains: ["mailinator.com"],
  })
  email!: string;
}

class RegisterLikeDto {
  @NormalizeEmail()
  @IsRfcEmail()
  email!: string;
}

async function errorsFor(dto: object) {
  return validate(dto);
}

function dtoWith(email: unknown): TestUserEmailDto {
  const dto = new TestUserEmailDto();
  dto.email = email as string;
  return dto;
}

/**
 * Deterministic pseudo-random generator (mulberry32) so fuzz cases are
 * reproducible across runs while still exercising many inputs.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_ALPHABET =
  "abcxyzABCXYZ0189._+-@[]:()\"\\,;<>'`!#$%&*/=?^{|}~ \t\n\u0000\u00fc\u4e2d\ud83d\ude00";

function randomString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += FUZZ_ALPHABET[Math.floor(rand() * FUZZ_ALPHABET.length)];
  }
  return out;
}

describe("IsRfcEmail Decorator", () => {
  const originalBlock = process.env.DISPOSABLE_EMAIL_DOMAINS;
  const originalAllow = process.env.DISPOSABLE_EMAIL_ALLOWLIST;

  afterEach(() => {
    process.env.DISPOSABLE_EMAIL_DOMAINS = originalBlock;
    process.env.DISPOSABLE_EMAIL_ALLOWLIST = originalAllow;
    if (originalBlock === undefined) delete process.env.DISPOSABLE_EMAIL_DOMAINS;
    if (originalAllow === undefined) delete process.env.DISPOSABLE_EMAIL_ALLOWLIST;
  });

  describe("RFC 5322 syntax", () => {
    it.each([
      "user@example.com",
      "user.name+tag@example.co.uk",
      "user_name@sub.domain.org",
      "user-name123@domain.io",
      "disposable.style.email.with+symbol@example.com",
      "x@example.com",
      "!#$%&'*+/=?^_`{|}~-@example.com",
      '"john doe"@example.com',
      '"very.(),:;<>[]\\".VERY.\\"very@\\\\ \\"very\\".unusual"@example.com',
      '"a@b"@example.com',
      "user@[192.168.0.1]",
      "user@[IPv6:2001:db8::1]",
      "user@xn--bcher-kva.example",
      "user@123.example.com",
      "a".repeat(64) + "@example.com",
    ])("accepts %s", async (email) => {
      expect(await errorsFor(dtoWith(email))).toHaveLength(0);
    });

    it.each([
      "",
      "plainaddress",
      "@no-local.com",
      "no-at-sign.com",
      "user@",
      "user@.com",
      "user@domain..com",
      "user@-domain.com",
      "user@domain-.com",
      "user@localhost",
      "user@example.c",
      "user@example.123",
      "user@1.2.3.4",
      "user@[999.1.1.1]",
      "user@[IPv6:not-an-ip]",
      ".user@example.com",
      "user.@example.com",
      "user..name@example.com",
      "user name@example.com",
      "user@exa mple.com",
      "a@b@example.com",
      '"unterminated@example.com',
      '"bad"quote"@example.com',
      "user(comment)@example.com",
      "üser@example.com",
      "a".repeat(65) + "@example.com",
      "user@" + "a".repeat(64) + ".com",
      "user@" + "a".repeat(250) + ".com",
      `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}.com`,
    ])("rejects %s", async (email) => {
      const errors = await errorsFor(dtoWith(email));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe("email");
    });

    it.each([12345, null, undefined, {}, ["a@example.com"]])(
      "rejects non-string %p",
      async (email) => {
        expect((await errorsFor(dtoWith(email))).length).toBeGreaterThan(0);
      },
    );

    it("reports why a value was rejected", () => {
      expect(parseRfcEmail("nope")).toEqual({ ok: false, reason: "malformed" });
      expect(parseRfcEmail("a..b@example.com")).toEqual({
        ok: false,
        reason: "invalid_local_part",
      });
      expect(parseRfcEmail("a@example")).toEqual({
        ok: false,
        reason: "invalid_domain",
      });
      expect(parseRfcEmail("a".repeat(250) + "@x.com")).toEqual({
        ok: false,
        reason: "too_long",
      });
      expect(parseRfcEmail(42)).toEqual({ ok: false, reason: "not_a_string" });
    });

    it("produces a field-specific syntax error message", async () => {
      const [error] = await errorsFor(dtoWith("user@domain..com"));
      expect(error.constraints?.isRfcEmail).toBe(
        'email has an invalid domain (after "@")',
      );
    });

    it("fuzz: never throws and parseRfcEmail is consistent with the decorator", async () => {
      const rand = seededRandom(0xc0ffee);
      for (let i = 0; i < 500; i++) {
        const input = randomString(rand, 300);
        expect(() => parseRfcEmail(input)).not.toThrow();
        const result = parseRfcEmail(input);
        const errors = await errorsFor(dtoWith(input));
        if (result.ok) {
          // Accepted by the parser must not fail syntax validation.
          // Disposable-domain rejections are the only allowed exception.
          const syntaxFailed = errors.some(
            (e) => e.constraints?.isRfcEmail && !e.constraints.isRfcEmail.includes("disposable"),
          );
          expect(syntaxFailed).toBe(false);
        } else {
          expect(errors.length).toBeGreaterThan(0);
        }
      }
    });

    it("fuzz: rejects every non-string type without throwing", async () => {
      const rand = seededRandom(7);
      const values: unknown[] = [];
      for (let i = 0; i < 50; i++) {
        values.push(rand() * 1e6, Math.floor(rand() * 100) > 50, Symbol("s"), BigInt(i));
      }
      values.push(NaN, Infinity, -0, () => "a@example.com", new Date(0));
      for (const value of values) {
        expect(parseRfcEmail(value).ok).toBe(false);
        expect((await errorsFor(dtoWith(value))).length).toBeGreaterThan(0);
      }
    });

    it("boundary: accepts exactly-at-limit lengths and rejects one over", async () => {
      // local part: 64 ok, 65 rejected (covered above); total length boundary
      const localMax = "a".repeat(64);
      const domainLabel = "b".repeat(63);
      const atLimit = `${localMax}@${domainLabel}.${"c".repeat(63)}.${"d".repeat(58)}.com`;
      const overLimit = `${localMax}@${domainLabel}.${"c".repeat(63)}.${"d".repeat(60)}.com`;
      expect(parseRfcEmail(atLimit).ok).toBe(true);
      expect(parseRfcEmail(overLimit)).toEqual({ ok: false, reason: "too_long" });
    });

    it("boundary: empty and whitespace-only strings are rejected", async () => {
      for (const value of ["", " ", "\t", "\n", "   \n  "]) {
        expect(parseRfcEmail(value).ok).toBe(false);
        expect((await errorsFor(dtoWith(value))).length).toBeGreaterThan(0);
      }
    });
  });

  describe("disposable domains", () => {
    it.each([
      ["bot@mailinator.com", "mailinator.com"],
      ["bot@MAILINATOR.COM", "mailinator.com"],
      ["bot@tempmail.com", "tempmail.com"],
      ["bot@guerrillamail.com", "guerrillamail.com"],
      ["bot@yopmail.com", "yopmail.com"],
      ["bot@10minutemail.com", "10minutemail.com"],
      ["bot@inbox.mailinator.com", "inbox.mailinator.com"],
    ])("rejects %s with a descriptive message", async (email, domain) => {
      const [error] = await errorsFor(dtoWith(email));
      expect(error.property).toBe("email");
      expect(error.constraints?.isRfcEmail).toBe(
        `email uses a disposable email provider (${domain}); please use a permanent email address`,
      );
    });

    it("does not match look-alike domains", () => {
      expect(isDisposableEmailDomain("notmailinator.com")).toBe(false);
      expect(isDisposableEmailDomain("mailinator.com.example.org")).toBe(false);
    });

    it("can be disabled per field", async () => {
      const dto = new AllowDisposableDto();
      dto.email = "bot@mailinator.com";
      expect(await errorsFor(dto)).toHaveLength(0);
    });

    it("supports per-field block and allow lists", async () => {
      const blocked = new CustomBlockListDto();
      blocked.email = "user@blocked.example";
      expect((await errorsFor(blocked)).length).toBeGreaterThan(0);

      const allowed = new CustomBlockListDto();
      allowed.email = "user@mailinator.com";
      expect(await errorsFor(allowed)).toHaveLength(0);
    });

    it("reads extra blocked domains from DISPOSABLE_EMAIL_DOMAINS", async () => {
      process.env.DISPOSABLE_EMAIL_DOMAINS = " spam.example , Junk.Example ";
      expect((await errorsFor(dtoWith("a@spam.example"))).length).toBeGreaterThan(0);
      expect((await errorsFor(dtoWith("a@junk.example"))).length).toBeGreaterThan(0);
      expect(await errorsFor(dtoWith("a@example.com"))).toHaveLength(0);
    });

    it("honours DISPOSABLE_EMAIL_ALLOWLIST", async () => {
      process.env.DISPOSABLE_EMAIL_ALLOWLIST = "yopmail.com";
      expect(await errorsFor(dtoWith("qa@yopmail.com"))).toHaveLength(0);
    });

    it("failure path: malformed DISPOSABLE_EMAIL_DOMAINS entries do not disable validation", async () => {
      process.env.DISPOSABLE_EMAIL_DOMAINS = ",,  , ;;";
      expect(await errorsFor(dtoWith("user@example.com"))).toHaveLength(0);
      expect((await errorsFor(dtoWith("bot@mailinator.com"))).length).toBeGreaterThan(0);
    });
  });

  describe("normalizeEmail", () => {
    it.each([
      ["User@Example.COM", "user@example.com"],
      ["  user@example.com  ", "user@example.com"],
      ["John.Doe+newsletter@Gmail.com", "johndoe@gmail.com"],
      ["j.o.h.n.d.o.e@gmail.com", "johndoe@gmail.com"],
      ["johndoe+a+b@gmail.com", "johndoe@gmail.com"],
      ["John.Doe@googlemail.com", "johndoe@gmail.com"],
      // Only Gmail ignores dots and plus tags; other providers keep them.
      ["john.doe+tag@example.com", "john.doe+tag@example.com"],
      ["john.doe+tag@outlook.com", "john.doe+tag@outlook.com"],
    ])("normalizes %s to %s", (input, expected) => {
      expect(normalizeEmail(input)).toBe(expected);
    });

    it("is idempotent", () => {
      const once = normalizeEmail("A.B+c@GoogleMail.com");
      expect(normalizeEmail(once)).toBe(once);
    });

    it("is idempotent across fuzzed inputs", () => {
      const rand = seededRandom(42);
      for (let i = 0; i < 300; i++) {
        const input = randomString(rand, 80) + "@gmail.com";
        const once = normalizeEmail(input);
        expect(normalizeEmail(once)).toBe(once);
      }
    });

    it("leaves unparseable or non-string input for validation to reject", () => {
      expect(normalizeEmail("plainaddress")).toBe("plainaddress");
      expect(normalizeEmail("+tag@gmail.com")).toBe("+tag@gmail.com");
      expect(normalizeEmail(42)).toBe(42);
      expect(normalizeEmail(undefined)).toBeUndefined();
    });

    it("normalizes via @NormalizeEmail() before validation", async () => {
      const dto = plainToInstance(RegisterLikeDto, {
        email: "  Jane.Doe+Promo@GMAIL.com ",
      });
      expect(dto.email).toBe("janedoe@gmail.com");
      expect(await validate(dto)).toHaveLength(0);
    });

    it("still rejects disposable domains after normalization", async () => {
      const dto = plainToInstance(RegisterLikeDto, { email: "Bot@Mailinator.com" });
      expect(dto.email).toBe("bot@mailinator.com");
      expect((await validate(dto)).length).toBeGreaterThan(0);
    });
  });
});

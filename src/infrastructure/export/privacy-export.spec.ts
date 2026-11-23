import {
  FieldSensitivity,
  PrivacyExportAuthorizer,
} from "./privacy-export-authorizer";

describe("PrivacyExportAuthorizer (#296)", () => {
  let authorizer: PrivacyExportAuthorizer;

  beforeEach(() => {
    authorizer = new PrivacyExportAuthorizer();
  });

  describe("Field Classification", () => {
    it("identifies forbidden secrets", () => {
      expect(authorizer.classifyField("password")).toBe(
        FieldSensitivity.FORBIDDEN_SECRET,
      );
      expect(authorizer.classifyField("privateKey")).toBe(
        FieldSensitivity.FORBIDDEN_SECRET,
      );
      expect(authorizer.classifyField("mnemonicSeed")).toBe(
        FieldSensitivity.FORBIDDEN_SECRET,
      );
      expect(authorizer.classifyField("apiKeySecret")).toBe(
        FieldSensitivity.FORBIDDEN_SECRET,
      );
      expect(authorizer.classifyField("jwtToken")).toBe(
        FieldSensitivity.FORBIDDEN_SECRET,
      );
    });

    it("identifies restricted PII fields", () => {
      expect(authorizer.classifyField("email")).toBe(
        FieldSensitivity.RESTRICTED_PII,
      );
      expect(authorizer.classifyField("phoneNumber")).toBe(
        FieldSensitivity.RESTRICTED_PII,
      );
      expect(authorizer.classifyField("ipAddress")).toBe(
        FieldSensitivity.RESTRICTED_PII,
      );
      expect(authorizer.classifyField("fullName")).toBe(
        FieldSensitivity.RESTRICTED_PII,
      );
    });

    it("identifies public non-sensitive fields", () => {
      expect(authorizer.classifyField("stellarPublicKey")).toBe(
        FieldSensitivity.PUBLIC,
      );
      expect(authorizer.classifyField("transactionId")).toBe(
        FieldSensitivity.PUBLIC,
      );
      expect(authorizer.classifyField("createdAt")).toBe(
        FieldSensitivity.PUBLIC,
      );
    });
  });

  describe("Export filtering by role", () => {
    const rawData = {
      id: "exp_1",
      stellarPublicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      email: "alice@example.com",
      phoneNumber: "+15551234567",
      ipAddress: "192.168.1.50",
      balance: "5000.50",
      passwordHash: "bcrypt_hash_12345",
      privateKey: "SDEMOSECRETKEY1234567890",
      apiSecret: "sec_987654321",
    };

    it("strips forbidden secrets completely for standard user exports and masks PII", () => {
      const sanitized = authorizer.filterRecord(rawData, {
        role: "user",
        isOwner: true,
        includePiiConsent: false,
      }) as any;

      // Secrets must be stripped
      expect(sanitized.passwordHash).toBeUndefined();
      expect(sanitized.privateKey).toBeUndefined();
      expect(sanitized.apiSecret).toBeUndefined();

      // PII must be masked
      expect(sanitized.email).toBe("a***e@example.com");
      expect(sanitized.phoneNumber).toBe("***-***-4567");
      expect(sanitized.ipAddress).toBe("192.168.1.xxx");

      // Public and owner financial fields remain
      expect(sanitized.stellarPublicKey).toBe(rawData.stellarPublicKey);
      expect(sanitized.balance).toBe("5000.50");
    });

    it("includes unmasked PII for user export when explicit consent is provided", () => {
      const sanitized = authorizer.filterRecord(rawData, {
        role: "user",
        isOwner: true,
        includePiiConsent: true,
      }) as any;

      expect(sanitized.email).toBe("alice@example.com");
      expect(sanitized.phoneNumber).toBe("+15551234567");
      // Secrets still stripped!
      expect(sanitized.privateKey).toBeUndefined();
    });

    it("masks PII for auditors while allowing financial validation", () => {
      const sanitized = authorizer.filterRecord(rawData, {
        role: "auditor",
        isOwner: false,
      }) as any;

      expect(sanitized.email).toBe("a***e@example.com");
      expect(sanitized.balance).toBe("5000.50");
      expect(sanitized.privateKey).toBeUndefined();
    });

    it("allows compliance officer to view PII for investigation while stripping secrets", () => {
      const sanitized = authorizer.filterRecord(rawData, {
        role: "compliance_officer",
        isOwner: false,
      }) as any;

      expect(sanitized.email).toBe("alice@example.com");
      expect(sanitized.phoneNumber).toBe("+15551234567");
      expect(sanitized.ipAddress).toBe("192.168.1.50");
      expect(sanitized.privateKey).toBeUndefined();
    });

    it("redacts financial fields for third parties or unauthenticated contexts", () => {
      const sanitized = authorizer.filterRecord(rawData, {
        role: "user",
        isOwner: false,
      }) as any;

      expect(sanitized.balance).toBe("[CONFIDENTIAL]");
      expect(sanitized.email).toBe("a***e@example.com");
    });

    it("handles nested objects and arrays cleanly", () => {
      const complexData = {
        users: [
          {
            name: "Bob",
            email: "bob@stellar.org",
            secrets: { apiKey: "key_1" },
          },
        ],
      };

      const sanitized = authorizer.filterRecord(complexData, {
        role: "user",
        isOwner: false,
      }) as any;

      expect(sanitized.users[0].email).toBe("b***b@stellar.org");
      expect(sanitized.users[0].secrets).toBeUndefined();
    });
  });

  describe("snake_case and multi-value PII fields (#564)", () => {
    const profile = {
      id: "usr_9",
      first_name: "Alice",
      last_name: "Smith",
      date_of_birth: "1990-04-12",
      dateOfBirth: "1990-04-12",
      emails: ["alice@example.com", "bob@stellar.org"],
      phoneNumbers: ["+15551234567", null],
    };

    it("classifies snake_case name and birth-date keys as restricted PII", () => {
      for (const key of [
        "first_name",
        "last_name",
        "firstName",
        "lastName",
        "date_of_birth",
        "dateOfBirth",
      ]) {
        expect(authorizer.classifyField(key)).toBe(
          FieldSensitivity.RESTRICTED_PII,
        );
      }
    });

    it("authorization path: masks them for roles without PII access", () => {
      for (const context of [
        { role: "user" as const, isOwner: false },
        { role: "user" as const, isOwner: true, includePiiConsent: false },
        { role: "auditor" as const, isOwner: false },
      ]) {
        const sanitized = authorizer.filterRecord(profile, context) as any;
        expect(sanitized.first_name).toBe("A***e");
        expect(sanitized.last_name).toBe("S***h");
        expect(sanitized.date_of_birth).toBe("1***2");
        expect(sanitized.dateOfBirth).toBe("1***2");
        expect(sanitized.id).toBe("usr_9");
      }
    });

    it("authorization path: shows them in plaintext to PII-authorized roles", () => {
      for (const context of [
        { role: "user" as const, isOwner: true, includePiiConsent: true },
        { role: "compliance_officer" as const, isOwner: false },
        { role: "admin" as const, isOwner: false },
      ]) {
        const sanitized = authorizer.filterRecord(profile, context) as any;
        expect(sanitized.first_name).toBe("Alice");
        expect(sanitized.date_of_birth).toBe("1990-04-12");
        expect(sanitized.emails).toEqual(profile.emails);
      }
    });

    it("failure path: masks every value of a multi-value field instead of leaking the tail", () => {
      const sanitized = authorizer.filterRecord(
        { ...profile, emails: [...profile.emails, ["carol@example.com"]] },
        { role: "user", isOwner: false },
      ) as any;

      expect(sanitized.emails).toEqual([
        "a***e@example.com",
        "b***b@stellar.org",
        ["c***l@example.com"],
      ]);
      expect(JSON.stringify(sanitized)).not.toContain("bob@");
      expect(JSON.stringify(sanitized)).not.toContain("carol@");
      expect(sanitized.phoneNumbers).toEqual(["***-***-4567", ""]);
    });

    it("retry path: re-filtering the same raw record gives the same output and leaves it unmodified", () => {
      const raw = JSON.parse(JSON.stringify(profile));
      const context = { role: "user" as const, isOwner: false };

      const first = authorizer.filterRecord(raw, context);
      const second = authorizer.filterRecord(raw, context);

      expect(second).toEqual(first);
      expect(raw).toEqual(profile);
    });
  });
});

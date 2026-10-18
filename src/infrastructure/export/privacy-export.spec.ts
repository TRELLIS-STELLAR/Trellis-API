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
      expect(sanitized.users[0].secrets.apiKey).toBeUndefined();
    });
  });
});

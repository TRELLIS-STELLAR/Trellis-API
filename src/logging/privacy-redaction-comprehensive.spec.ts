/**
 * Comprehensive privacy redaction tests for logs and exports.
 * 
 * Tests cover:
 * - Normal path: Standard redaction patterns
 * - Failure path: Redaction in error messages and stack traces
 * - Retry path: Consistent redaction across multiple attempts
 * - Authorization path: Role-based redaction and masking
 * - Edge cases: Boundary conditions, special characters, encoding
 */

import {
  sanitizeValue,
  sanitizeErrorMessage,
  sanitizeHeaders,
  sanitizeUrl,
  formatError,
  redactSecretValues,
  sanitizeQuery,
  REDACTED,
  MAX_STRING_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  redactBounded,
} from "./sanitize.util";
import { PrivacyExportAuthorizer, FieldSensitivity } from "../infrastructure/export/privacy-export-authorizer";

describe("Privacy Redaction - Comprehensive Tests", () => {
  describe("Normal Path: Standard Redaction", () => {
    describe("Log Redaction", () => {
      it("should redact all common secret types in log messages", () => {
        const secrets = {
          password: "MyP@ssw0rd123",
          apiKey: "sk_live_51234567890",
          jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.signature",
          stellarSeed: "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4",
          privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQE\n-----END PRIVATE KEY-----",
          bearerToken: "Bearer abc123def456ghi789",
          basicAuth: "Basic dXNlcjpwYXNzd29yZA==",
          urlCredentials: "postgres://user:p@ssw0rd@db.host:5432/database",
        };

        const logEntry = {
          message: "Authentication failed",
          user: "alice@example.com",
          password: secrets.password,
          apiKey: secrets.apiKey,
          token: secrets.jwt,
          details: `Connection string: ${secrets.urlCredentials}`,
          headers: secrets.bearerToken,
        };

        const sanitized = sanitizeValue(logEntry);
        const jsonOutput = JSON.stringify(sanitized);

        // Verify no secrets leaked
        Object.values(secrets).forEach((secret) => {
          expect(jsonOutput).not.toContain(secret);
        });

        // Verify REDACTED marker is present
        expect(jsonOutput).toContain(REDACTED);

        // Verify non-sensitive data preserved
        expect(sanitized).toHaveProperty("message", "Authentication failed");
        expect(sanitized).toHaveProperty("user", "alice@example.com");
      });

      it("should handle deeply nested objects with secrets", () => {
        const nested = {
          level1: {
            level2: {
              level3: {
                password: "secret123",
                publicData: "visible",
              },
            },
          },
        };

        const sanitized = sanitizeValue(nested) as any;
        expect(sanitized.level1.level2.level3.password).toBe(REDACTED);
        expect(sanitized.level1.level2.level3.publicData).toBe("visible");
      });

      it("should redact secrets in array items", () => {
        const users = [
          { name: "Alice", password: "pass1" },
          { name: "Bob", apiKey: "key2" },
          { name: "Carol", publicKey: "GBXXX..." },
        ];

        const sanitized = sanitizeValue(users) as any[];
        expect(sanitized[0].password).toBe(REDACTED);
        expect(sanitized[1].apiKey).toBe(REDACTED);
        expect(sanitized[2].publicKey).toBe("GBXXX..."); // Public key preserved
      });
    });

    describe("Export Redaction", () => {
      const authorizer = new PrivacyExportAuthorizer();

      it("should strip all forbidden secrets from exports regardless of role", () => {
        const record = {
          id: "user_123",
          email: "alice@example.com",
          password: "secret123",
          apiKey: "sk_live_123",
          privateKey: "SCZANGBA...",
          publicData: "visible",
        };

        const roles = ["user", "auditor", "compliance_officer", "admin"] as const;

        roles.forEach((role) => {
          const exported = authorizer.filterRecord(record, {
            role,
            isOwner: true,
            includePiiConsent: true,
          }) as any;

          expect(exported).not.toHaveProperty("password");
          expect(exported).not.toHaveProperty("apiKey");
          expect(exported).not.toHaveProperty("privateKey");
          expect(exported.publicData).toBe("visible");
        });
      });

      it("should redact secrets in string values even if key is not sensitive", () => {
        const record = {
          note: "Remember to rotate token: eyJhbGciOiJIUzI1NiJ9.payload.signature",
          description: "Secret key: SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4",
          comment: "Normal text without secrets",
        };

        const exported = authorizer.filterRecord(record, {
          role: "user",
          isOwner: true,
        }) as any;

        expect(exported.note).not.toContain("eyJ");
        expect(exported.note).toContain(REDACTED);
        expect(exported.description).not.toContain("SCZANGBA");
        expect(exported.comment).toBe("Normal text without secrets");
      });
    });

    describe("Header Redaction", () => {
      it("should redact all sensitive HTTP headers", () => {
        const headers = {
          "authorization": "Bearer secret-token-123",
          "x-api-key": "api-key-456",
          "cookie": "session=abc123; user_id=789",
          "x-capability-token": "cap1.payload.sig",
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0",
        };

        const sanitized = sanitizeHeaders(headers);

        expect(sanitized.authorization).toBe(REDACTED);
        expect(sanitized["x-api-key"]).toBe(REDACTED);
        expect(sanitized.cookie).toBe(REDACTED);
        expect(sanitized["x-capability-token"]).toBe(REDACTED);
        expect(sanitized["content-type"]).toBe("application/json");
        expect(sanitized["user-agent"]).toBe("Mozilla/5.0");
      });
    });
  });

  describe("Failure Path: Error Message Redaction", () => {
    it("should redact secrets in error messages", () => {
      const errors = [
        new Error("Authentication failed with token eyJhbGciOiJIUzI1NiJ9.payload.sig"),
        new Error("Database connection failed: postgres://user:p@ss@db.host/db"),
        new Error("API key sk_live_123456 is invalid"),
        new Error("Invalid seed: SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4"),
      ];

      errors.forEach((error) => {
        const sanitized = sanitizeErrorMessage(error.message);
        expect(sanitized).toContain(REDACTED);
        expect(sanitized).not.toContain("eyJhbGci");
        expect(sanitized).not.toContain("p@ss");
        expect(sanitized).not.toContain("sk_live");
        expect(sanitized).not.toContain("SCZANGBA");
      });
    });

    it("should redact hex private keys in error messages", () => {
      const hexKey = "0x" + "a".repeat(64);
      const error = new Error(`Transaction failed with key ${hexKey}`);
      const sanitized = sanitizeErrorMessage(error.message);

      expect(sanitized).not.toContain(hexKey);
      expect(sanitized).toContain(REDACTED);
    });

    it("should format errors with redacted messages and stack traces", () => {
      const error = new Error("Failed with password=secret123");
      const formatted = formatError(error, true);

      expect(formatted.message).toContain(REDACTED);
      expect(formatted.message).not.toContain("secret123");

      if (formatted.stack) {
        expect(typeof formatted.stack).toBe("string");
        expect(formatted.stack).not.toContain("secret123");
      }
    });

    it("should handle errors with additional properties", () => {
      const error = new Error("Operation failed") as any;
      error.apiKey = "sk_live_123";
      error.statusCode = 401;
      error.userId = "user_456";

      const formatted = formatError(error, false);

      expect(formatted.apiKey).toBe(REDACTED);
      expect(formatted.statusCode).toBe(401);
      expect(formatted.userId).toBe("user_456");
    });
  });

  describe("Retry Path: Consistent Redaction", () => {
    it("should produce identical redaction across multiple attempts", () => {
      const sensitiveData = {
        password: "secret123",
        apiKey: "sk_live_456",
        user: "alice@example.com",
      };

      const attempt1 = sanitizeValue(sensitiveData);
      const attempt2 = sanitizeValue(sensitiveData);
      const attempt3 = sanitizeValue(sensitiveData);

      expect(attempt2).toEqual(attempt1);
      expect(attempt3).toEqual(attempt1);
    });

    it("should maintain idempotency for error redaction", () => {
      const error = new Error("Auth failed with token eyJhbGciOiJIUzI1NiJ9.sub.sig");

      const redacted1 = sanitizeErrorMessage(error.message);
      const redacted2 = sanitizeErrorMessage(error.message);
      const redacted3 = sanitizeErrorMessage(redacted1); // Redacting already redacted

      expect(redacted2).toBe(redacted1);
      expect(redacted3).toBe(redacted1);
    });

    it("should handle re-export with consistent results", () => {
      const authorizer = new PrivacyExportAuthorizer();
      const record = {
        id: "rec_1",
        email: "alice@example.com",
        password: "secret",
      };

      const context = { role: "user" as const, isOwner: true };

      const export1 = authorizer.filterRecord(record, context);
      const export2 = authorizer.filterRecord(record, context);

      expect(export2).toEqual(export1);
      // Original record should remain unchanged
      expect(record.password).toBe("secret");
    });
  });

  describe("Authorization Path: Role-Based Redaction", () => {
    const authorizer = new PrivacyExportAuthorizer();

    describe("PII Masking by Role", () => {
      const record = {
        id: "user_1",
        email: "alice@example.com",
        phoneNumber: "+15551234567",
        ipAddress: "192.168.1.100",
        balance: "1000.00",
      };

      it("should mask PII for non-owner users without consent", () => {
        const exported = authorizer.filterRecord(record, {
          role: "user",
          isOwner: true,
          includePiiConsent: false,
        }) as any;

        expect(exported.email).toBe("a***e@example.com");
        expect(exported.phoneNumber).toBe("***-***-4567");
        expect(exported.ipAddress).toBe("192.168.1.xxx");
        expect(exported.balance).toBe("1000.00"); // Owner can see balance
      });

      it("should show PII for owner with explicit consent", () => {
        const exported = authorizer.filterRecord(record, {
          role: "user",
          isOwner: true,
          includePiiConsent: true,
        }) as any;

        expect(exported.email).toBe("alice@example.com");
        expect(exported.phoneNumber).toBe("+15551234567");
        expect(exported.ipAddress).toBe("192.168.1.100");
      });

      it("should allow compliance officers to view PII", () => {
        const exported = authorizer.filterRecord(record, {
          role: "compliance_officer",
          isOwner: false,
        }) as any;

        expect(exported.email).toBe("alice@example.com");
        expect(exported.phoneNumber).toBe("+15551234567");
      });

      it("should mask financial data for non-owners", () => {
        const exported = authorizer.filterRecord(record, {
          role: "user",
          isOwner: false,
        }) as any;

        expect(exported.balance).toBe("[CONFIDENTIAL]");
        expect(exported.email).toBe("a***e@example.com");
      });

      it("should allow auditors to see financial data but not PII", () => {
        const exported = authorizer.filterRecord(record, {
          role: "auditor",
          isOwner: false,
        }) as any;

        expect(exported.balance).toBe("1000.00");
        expect(exported.email).toBe("a***e@example.com");
      });
    });

    describe("Multi-value PII Fields", () => {
      it("should mask each value in PII arrays", () => {
        const record = {
          emails: ["alice@example.com", "bob@test.com"],
          phoneNumbers: ["+15551234567", "+15559876543"],
        };

        const exported = authorizer.filterRecord(record, {
          role: "user",
          isOwner: false,
        }) as any;

        expect(exported.emails).toEqual([
          "a***e@example.com",
          "b***b@test.com",
        ]);
        expect(exported.phoneNumbers).toEqual([
          "***-***-4567",
          "***-***-6543",
        ]);

        // Ensure no unmasked emails in JSON output
        const jsonOutput = JSON.stringify(exported);
        expect(jsonOutput).not.toContain("alice@");
        expect(jsonOutput).not.toContain("bob@");
      });

      it("should handle nested arrays of PII", () => {
        const record = {
          contacts: [
            { emails: ["alice@example.com"] },
            { emails: ["bob@test.com", "carol@demo.com"] },
          ],
        };

        const exported = authorizer.filterRecord(record, {
          role: "user",
          isOwner: false,
        }) as any;

        expect(exported.contacts[0].emails[0]).toBe("a***e@example.com");
        expect(exported.contacts[1].emails[0]).toBe("b***b@test.com");
        expect(exported.contacts[1].emails[1]).toBe("c***l@demo.com");
      });
    });
  });

  describe("Edge Cases and Boundary Conditions", () => {
    describe("URL Redaction", () => {
      it("should redact credentials in URLs while preserving structure", () => {
        const urls = [
          "postgres://user:password@db.host:5432/database",
          "https://admin:secret@api.example.com/endpoint",
          "redis://:password@cache.host:6379/0",
        ];

        urls.forEach((url) => {
          const sanitized = sanitizeUrl(url);
          expect(sanitized).toContain(REDACTED);
          expect(sanitized).not.toContain("password");
          expect(sanitized).not.toContain("secret");
          expect(sanitized).toContain("db.host");
        });
      });

      it("should redact sensitive query parameters", () => {
        const url = "/api/auth/callback?code=oauth123&token=secret456&page=2&key=api789";
        const sanitized = sanitizeUrl(url);

        expect(sanitized).toContain("page=2");
        expect(sanitized).toContain(REDACTED);
        expect(sanitized).not.toContain("oauth123");
        expect(sanitized).not.toContain("secret456");
        expect(sanitized).not.toContain("api789");
      });

      it("should handle very long URLs with truncation", () => {
        const longUrl = "/api/endpoint?" + "param=value&".repeat(1000) + "token=secret";
        const sanitized = sanitizeUrl(longUrl);

        expect(sanitized.length).toBeLessThan(longUrl.length);
        expect(sanitized).toContain("TRUNCATED");
        expect(sanitized).not.toContain("secret");
      });
    });

    describe("Query Parameter Redaction", () => {
      it("should redact all sensitive parameters", () => {
        const query = {
          token: "secret123",
          apiKey: "key456",
          page: "1",
          limit: "50",
          code: "oauth789",
          signature: "sig012",
        };

        const sanitized = sanitizeQuery(query);

        expect(sanitized.token).toBe(REDACTED);
        expect(sanitized.apiKey).toBe(REDACTED);
        expect(sanitized.code).toBe(REDACTED);
        expect(sanitized.signature).toBe(REDACTED);
        expect(sanitized.page).toBe("1");
        expect(sanitized.limit).toBe("50");
      });
    });

    describe("String Length Limits", () => {
      it("should truncate very long strings", () => {
        const longString = "a".repeat(MAX_STRING_LENGTH + 1000);
        const sanitized = sanitizeValue(longString);

        expect(typeof sanitized).toBe("string");
        expect((sanitized as string).length).toBeLessThan(longString.length);
        expect(sanitized).toContain("TRUNCATED");
      });

      it("should truncate very long error messages", () => {
        const longError = "Error: " + "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 1000);
        const sanitized = sanitizeErrorMessage(longError);

        expect(sanitized.length).toBeLessThan(longError.length);
        expect(sanitized).toContain("TRUNCATED");
      });

      it("should handle redactBounded correctly", () => {
        const text = "normal text with secret eyJhbGciOiJIUzI1NiJ9.payload.sig at the end";
        const bounded = redactBounded(text, 50, redactSecretValues);

        expect(bounded.length).toBeLessThanOrEqual(100); // Allow some margin for TRUNCATED message
        expect(bounded).not.toContain("eyJhbGci");
      });
    });

    describe("Special Characters and Encoding", () => {
      it("should handle unicode characters in PII fields", () => {
        const record = {
          email: "user@例え.jp",
          name: "用户名",
          password: "secret123",
        };

        const sanitized = sanitizeValue(record) as any;
        expect(sanitized.email).toContain("@例え.jp");
        expect(sanitized.name).toBe("用户名");
        expect(sanitized.password).toBe(REDACTED);
      });

      it("should handle URL-encoded secrets", () => {
        const url = "/callback?token=eyJhbGci%3D%3D&key=test";
        const sanitized = sanitizeUrl(url);

        expect(sanitized).not.toContain("eyJhbGci");
        expect(sanitized).toContain("key=test");
      });

      it("should handle null and undefined values gracefully", () => {
        const record = {
          id: "123",
          email: null,
          phone: undefined,
          password: "secret",
        };

        const sanitized = sanitizeValue(record) as any;
        expect(sanitized.email).toBeNull();
        expect(sanitized.phone).toBeUndefined();
        expect(sanitized.password).toBe(REDACTED);
      });
    });

    describe("Field Classification Edge Cases", () => {
      const authorizer = new PrivacyExportAuthorizer();

      it("should classify fields with various naming conventions", () => {
        const fields = [
          { key: "password", expected: FieldSensitivity.FORBIDDEN_SECRET },
          { key: "Password", expected: FieldSensitivity.FORBIDDEN_SECRET },
          { key: "PASSWORD", expected: FieldSensitivity.FORBIDDEN_SECRET },
          { key: "user_password", expected: FieldSensitivity.FORBIDDEN_SECRET },
          { key: "passwordHash", expected: FieldSensitivity.FORBIDDEN_SECRET },
          { key: "api_key", expected: FieldSensitivity.FORBIDDEN_SECRET },
          { key: "apiKey", expected: FieldSensitivity.FORBIDDEN_SECRET },
          { key: "first_name", expected: FieldSensitivity.RESTRICTED_PII },
          { key: "firstName", expected: FieldSensitivity.RESTRICTED_PII },
          { key: "email", expected: FieldSensitivity.RESTRICTED_PII },
          { key: "balance", expected: FieldSensitivity.CONFIDENTIAL_FINANCIAL },
          { key: "publicKey", expected: FieldSensitivity.PUBLIC },
        ];

        fields.forEach(({ key, expected }) => {
          expect(authorizer.classifyField(key)).toBe(expected);
        });
      });

      it("should handle short field values in PII masking", () => {
        const authorizer = new PrivacyExportAuthorizer();
        const record = {
          email: "a@b.c",
          phone: "123",
          name: "Jo",
        };

        const exported = authorizer.filterRecord(record, {
          role: "user",
          isOwner: false,
        }) as any;

        // Short values should still be masked
        expect(exported.email).not.toBe("a@b.c");
        expect(exported.phone).toBe("***");
        expect(exported.name).toBe("**");
      });
    });
  });

  describe("Recovery and Rollback Scenarios", () => {
    it("should handle partial redaction failures gracefully", () => {
      const problematic = {
        good: "normal",
        bad: { toString: () => { throw new Error("Conversion failed"); } },
        password: "secret",
      };

      // Should not throw, should handle the error internally
      expect(() => {
        const sanitized = sanitizeValue(problematic);
        // Password should still be redacted
        expect((sanitized as any).password).toBe(REDACTED);
      }).not.toThrow();
    });

    it("should maintain data integrity when redaction is applied multiple times", () => {
      const original = {
        id: "user_1",
        email: "alice@example.com",
        password: "secret123",
      };

      const firstPass = sanitizeValue(original) as any;
      const secondPass = sanitizeValue(firstPass) as any;
      const thirdPass = sanitizeValue(secondPass) as any;

      expect(thirdPass.password).toBe(REDACTED);
      expect(thirdPass.id).toBe("user_1");
      // Email should not be further corrupted
      expect(typeof thirdPass.email).toBe("string");
    });

    it("should allow rollback by preserving original data", () => {
      const original = {
        id: "123",
        password: "secret",
        data: "important",
      };

      const originalCopy = JSON.parse(JSON.stringify(original));
      const sanitized = sanitizeValue(original);

      // Original should be unchanged
      expect(original).toEqual(originalCopy);

      // Sanitized should be different
      expect((sanitized as any).password).toBe(REDACTED);
    });
  });

  describe("Performance and Resource Limits", () => {
    it("should handle very wide objects (many keys)", () => {
      const wideObject: Record<string, any> = {};
      for (let i = 0; i < 200; i++) {
        wideObject[`field${i}`] = `value${i}`;
      }
      wideObject.password = "secret";

      const sanitized = sanitizeValue(wideObject) as any;
      expect(sanitized.password).toBe(REDACTED);
      // Should have truncation marker for excess keys
      expect(sanitized).toHaveProperty("[TRUNCATED_KEYS]");
    });

    it("should handle very large arrays", () => {
      const largeArray = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        password: `secret${i}`,
      }));

      const sanitized = sanitizeValue(largeArray) as any[];
      // Should be capped at MAX_ARRAY_LENGTH (50)
      expect(sanitized.length).toBe(50);
      expect(sanitized[0].password).toBe(REDACTED);
    });

    it("should prevent stack overflow on deeply nested objects", () => {
      let deepObject: any = { password: "secret" };
      for (let i = 0; i < 20; i++) {
        deepObject = { nested: deepObject };
      }

      expect(() => {
        const sanitized = sanitizeValue(deepObject);
        // Should reach MAX_DEPTH limit, not stack overflow
        expect(sanitized).toBeDefined();
      }).not.toThrow();
    });
  });
});

/**
 * Integration tests for privacy redaction in data exports.
 * 
 * Tests the complete export flow including:
 * - Normal path: Successful exports with appropriate redaction
 * - Failure path: Export failures with redacted error messages
 * - Retry path: Consistent redaction across retry attempts
 * - Authorization path: Role-based access and masking
 */

import { Test, TestingModule } from "@nestjs/testing";
import { Repository } from "typeorm";
import { ExportService } from "./export.service";
import { PrivacyExportAuthorizer, FieldSensitivity } from "./privacy-export-authorizer";
import { DataExport, ExportStatus } from "./entities/data-export.entity";
import { REDACTED } from "../../logging/sanitize.util";

describe("Privacy Redaction Integration Tests", () => {
  let service: ExportService;
  let authorizer: PrivacyExportAuthorizer;
  let repository: jest.Mocked<Repository<DataExport>>;

  beforeEach(async () => {
    const mockRepository = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ ...data, id: `exp_${Date.now()}` })),
      findOne: jest.fn(),
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExportService,
        PrivacyExportAuthorizer,
        {
          provide: "DataExportRepository",
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<ExportService>(ExportService);
    authorizer = module.get<PrivacyExportAuthorizer>(PrivacyExportAuthorizer);
    repository = module.get("DataExportRepository");
  });

  describe("Normal Path: Successful Export with Redaction", () => {
    it("should create export with secrets stripped for user role", async () => {
      const mockData = [
        {
          id: "user_1",
          email: "alice@example.com",
          password: "secret123",
          apiKey: "sk_live_456",
          balance: "1000.00",
          publicKey: "GABC123",
        },
        {
          id: "user_2",
          email: "bob@example.com",
          passwordHash: "bcrypt_hash",
          token: "jwt_token_xyz",
          balance: "2000.00",
        },
      ];

      // Mock the data extraction
      jest.spyOn(service as any, "extractData").mockResolvedValue(mockData);

      const exportRequest = {
        userId: "user_1",
        scope: "user_data",
        format: "json" as const,
        schemaVersion: "1.0.0",
      };

      repository.findOne.mockResolvedValue({
        ...exportRequest,
        id: "exp_1",
        status: ExportStatus.PENDING,
      } as any);

      await service.processExport("exp_1");

      const savedData = repository.save.mock.calls[0][0];

      // Verify secrets are not in the export
      const exportContent = JSON.stringify(savedData);
      expect(exportContent).not.toContain("secret123");
      expect(exportContent).not.toContain("sk_live_456");
      expect(exportContent).not.toContain("bcrypt_hash");
      expect(exportContent).not.toContain("jwt_token_xyz");

      // Verify public data is preserved
      expect(exportContent).toContain("GABC123");
      expect(savedData.status).toBe(ExportStatus.COMPLETED);
    });

    it("should apply different redaction for different roles", async () => {
      const record = {
        id: "user_1",
        email: "alice@example.com",
        phoneNumber: "+15551234567",
        balance: "5000.00",
        password: "secret",
      };

      const roles = [
        { role: "user" as const, isOwner: false },
        { role: "auditor" as const, isOwner: false },
        { role: "compliance_officer" as const, isOwner: false },
        { role: "admin" as const, isOwner: false },
      ];

      roles.forEach(({ role, isOwner }) => {
        const filtered = authorizer.filterRecord(record, { role, isOwner });
        const jsonOutput = JSON.stringify(filtered);

        // All roles: secrets must be stripped
        expect(jsonOutput).not.toContain("secret");

        // Role-specific assertions
        if (role === "user" && !isOwner) {
          // Non-owner users: masked PII, no balance
          expect((filtered as any).balance).toBe("[CONFIDENTIAL]");
          expect((filtered as any).email).toContain("***");
        } else if (role === "auditor") {
          // Auditors: can see balance, masked PII
          expect((filtered as any).balance).toBe("5000.00");
          expect((filtered as any).email).toContain("***");
        } else if (role === "compliance_officer" || role === "admin") {
          // Compliance/Admin: can see PII and balance
          expect((filtered as any).email).toBe("alice@example.com");
          expect((filtered as any).balance).toBe("5000.00");
        }
      });
    });

    it("should handle nested objects and arrays in exports", async () => {
      const complexData = {
        user: {
          id: "user_1",
          profile: {
            email: "alice@example.com",
            password: "secret123",
          },
          transactions: [
            { id: "tx_1", amount: "100", memo: "Payment for service" },
            { id: "tx_2", amount: "200", apiKey: "sk_live_789" },
          ],
        },
      };

      const filtered = authorizer.filterRecord(complexData, {
        role: "user",
        isOwner: true,
        includePiiConsent: true,
      }) as any;

      // Secrets should be stripped
      expect(filtered.user.profile).not.toHaveProperty("password");
      expect(filtered.user.transactions[1]).not.toHaveProperty("apiKey");

      // Public data should be preserved
      expect(filtered.user.profile.email).toBe("alice@example.com");
      expect(filtered.user.transactions[0].memo).toBe("Payment for service");
    });
  });

  describe("Failure Path: Export Failures with Redacted Errors", () => {
    it("should redact secrets in error messages when export fails", async () => {
      const sensitiveError = new Error(
        "Database connection failed: postgres://user:p@ssw0rd@db.host:5432/app"
      );

      jest.spyOn(service as any, "extractData").mockRejectedValue(sensitiveError);

      repository.findOne.mockResolvedValue({
        id: "exp_1",
        userId: "user_1",
        scope: "user_data",
        format: "json",
        schemaVersion: "1.0.0",
        status: ExportStatus.PENDING,
      } as any);

      await service.processExport("exp_1");

      const savedData = repository.save.mock.calls[0][0];

      expect(savedData.status).toBe(ExportStatus.FAILED);
      expect(savedData.error).toBeDefined();
      expect(savedData.error).not.toContain("p@ssw0rd");
      expect(savedData.error).toContain(REDACTED);
    });

    it("should redact JWT tokens in export failure messages", async () => {
      const jwtError = new Error(
        "Authorization failed with token eyJhbGciOiJIUzI1NiJ9.payload.signature"
      );

      jest.spyOn(service as any, "extractData").mockRejectedValue(jwtError);

      repository.findOne.mockResolvedValue({
        id: "exp_1",
        status: ExportStatus.PENDING,
      } as any);

      await service.processExport("exp_1");

      const savedError = repository.save.mock.calls[0][0].error;
      expect(savedError).not.toContain("eyJhbGci");
      expect(savedError).toContain(REDACTED);
    });

    it("should handle errors during authorization check", async () => {
      const record = {
        email: "test@example.com",
        password: "secret123",
      };

      // Authorization should never fail, but if data structure is unexpected,
      // secrets should still be stripped
      const filtered = authorizer.filterRecord(record, {
        role: "user",
        isOwner: true,
      });

      expect(filtered).not.toHaveProperty("password");
      expect((filtered as any).email).toBeDefined();
    });
  });

  describe("Retry Path: Consistent Redaction Across Retries", () => {
    it("should produce identical output when retrying the same export", async () => {
      const mockData = [
        {
          id: "user_1",
          email: "alice@example.com",
          password: "secret123",
          balance: "1000.00",
        },
      ];

      jest.spyOn(service as any, "extractData").mockResolvedValue(mockData);

      repository.findOne.mockResolvedValue({
        id: "exp_1",
        userId: "user_1",
        scope: "user_data",
        format: "json",
        schemaVersion: "1.0.0",
        status: ExportStatus.PENDING,
      } as any);

      // First attempt
      await service.processExport("exp_1");
      const firstAttempt = repository.save.mock.calls[0][0];

      // Reset mocks
      repository.save.mockClear();

      // Second attempt (retry)
      await service.processExport("exp_1");
      const secondAttempt = repository.save.mock.calls[0][0];

      // Results should be consistent
      expect(secondAttempt.status).toBe(firstAttempt.status);
      // Data redaction should be identical
      const firstData = JSON.stringify(firstAttempt.data);
      const secondData = JSON.stringify(secondAttempt.data);
      expect(secondData).toBe(firstData);
    });

    it("should maintain idempotency for failed export retries", async () => {
      const error = new Error("Failed with token eyJhbGciOiJIUzI1NiJ9.payload.sig");
      jest.spyOn(service as any, "extractData").mockRejectedValue(error);

      repository.findOne.mockResolvedValue({
        id: "exp_1",
        status: ExportStatus.PENDING,
      } as any);

      // First failure
      await service.processExport("exp_1");
      const firstError = repository.save.mock.calls[0][0].error;

      repository.save.mockClear();

      // Retry (second failure)
      await service.processExport("exp_1");
      const secondError = repository.save.mock.calls[0][0].error;

      // Error messages should be consistently redacted
      expect(secondError).toBe(firstError);
      expect(secondError).not.toContain("eyJhbGci");
    });

    it("should not corrupt data when filtering multiple times", async () => {
      const original = {
        id: "user_1",
        email: "alice@example.com",
        password: "secret",
      };

      const context = { role: "user" as const, isOwner: false };

      // Multiple filter passes
      const pass1 = authorizer.filterRecord(original, context);
      const pass2 = authorizer.filterRecord(pass1, context);
      const pass3 = authorizer.filterRecord(pass2, context);

      // Should remain stable
      expect(pass3).toEqual(pass2);
      expect(pass2).toEqual(pass1);

      // Original should be unchanged
      expect(original.password).toBe("secret");
    });
  });

  describe("Authorization Path: Role-Based Filtering", () => {
    it("should enforce owner-only access for sensitive financial data", async () => {
      const record = {
        userId: "user_1",
        balance: "10000.00",
        internalFee: "50.00",
        publicData: "visible",
      };

      // Owner can see everything (except secrets)
      const ownerView = authorizer.filterRecord(record, {
        role: "user",
        isOwner: true,
      }) as any;

      expect(ownerView.balance).toBe("10000.00");
      expect(ownerView.internalFee).toBe("50.00");

      // Non-owner cannot see financial data
      const nonOwnerView = authorizer.filterRecord(record, {
        role: "user",
        isOwner: false,
      }) as any;

      expect(nonOwnerView.balance).toBe("[CONFIDENTIAL]");
      expect(nonOwnerView.internalFee).toBe("[CONFIDENTIAL]");
      expect(nonOwnerView.publicData).toBe("visible");
    });

    it("should enforce PII consent requirement for owner exports", async () => {
      const record = {
        id: "user_1",
        email: "alice@example.com",
        phoneNumber: "+15551234567",
        fullName: "Alice Smith",
      };

      // Owner without consent: PII masked
      const withoutConsent = authorizer.filterRecord(record, {
        role: "user",
        isOwner: true,
        includePiiConsent: false,
      }) as any;

      expect(withoutConsent.email).toBe("a***e@example.com");
      expect(withoutConsent.phoneNumber).toBe("***-***-4567");
      expect(withoutConsent.fullName).toBe("A***h");

      // Owner with consent: PII visible
      const withConsent = authorizer.filterRecord(record, {
        role: "user",
        isOwner: true,
        includePiiConsent: true,
      }) as any;

      expect(withConsent.email).toBe("alice@example.com");
      expect(withConsent.phoneNumber).toBe("+15551234567");
      expect(withConsent.fullName).toBe("Alice Smith");
    });

    it("should allow compliance officers full PII access without consent", async () => {
      const record = {
        email: "suspect@example.com",
        phoneNumber: "+15559999999",
        ipAddress: "10.0.0.50",
        balance: "100000.00",
      };

      const complianceView = authorizer.filterRecord(record, {
        role: "compliance_officer",
        isOwner: false,
      }) as any;

      // Full PII access for compliance
      expect(complianceView.email).toBe("suspect@example.com");
      expect(complianceView.phoneNumber).toBe("+15559999999");
      expect(complianceView.ipAddress).toBe("10.0.0.50");
      expect(complianceView.balance).toBe("100000.00");
    });

    it("should never expose secrets even to admin role", async () => {
      const record = {
        id: "user_1",
        email: "admin@example.com",
        password: "admin_secret",
        apiKey: "sk_live_admin_key",
        privateKey: "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4",
        balance: "50000.00",
      };

      const adminView = authorizer.filterRecord(record, {
        role: "admin",
        isOwner: false,
      }) as any;

      // Admins can see PII and financial data
      expect(adminView.email).toBe("admin@example.com");
      expect(adminView.balance).toBe("50000.00");

      // But NEVER secrets
      expect(adminView).not.toHaveProperty("password");
      expect(adminView).not.toHaveProperty("apiKey");
      expect(adminView).not.toHaveProperty("privateKey");
    });
  });

  describe("Edge Cases and Recovery", () => {
    it("should handle malformed data gracefully", async () => {
      const malformedData = {
        id: "user_1",
        email: "not-an-email",
        password: "secret",
        circular: null as any,
      };

      // Create circular reference
      malformedData.circular = malformedData;

      // Should not throw
      expect(() => {
        const filtered = authorizer.filterRecord(malformedData, {
          role: "user",
          isOwner: true,
        });
        expect(filtered).toBeDefined();
      }).not.toThrow();
    });

    it("should handle empty and null records", async () => {
      const emptyRecord = {};
      const nullRecord = null;

      const filteredEmpty = authorizer.filterRecord(emptyRecord, {
        role: "user",
        isOwner: true,
      });
      const filteredNull = authorizer.filterRecord(nullRecord, {
        role: "user",
        isOwner: true,
      });

      expect(filteredEmpty).toEqual({});
      expect(filteredNull).toBeNull();
    });

    it("should preserve data types after filtering", async () => {
      const record = {
        id: "user_1",
        age: 30,
        balance: 1000.50,
        isActive: true,
        createdAt: new Date("2024-01-01"),
        tags: ["premium", "verified"],
        metadata: { level: 5 },
      };

      const filtered = authorizer.filterRecord(record, {
        role: "user",
        isOwner: true,
      }) as any;

      expect(typeof filtered.age).toBe("number");
      expect(typeof filtered.balance).toBe("number");
      expect(typeof filtered.isActive).toBe("boolean");
      expect(filtered.createdAt instanceof Date).toBe(true);
      expect(Array.isArray(filtered.tags)).toBe(true);
      expect(typeof filtered.metadata).toBe("object");
    });

    it("should classify fields correctly regardless of naming convention", async () => {
      const variations = {
        password: "secret1",
        Password: "secret2",
        PASSWORD: "secret3",
        user_password: "secret4",
        userPassword: "secret5",
        "user-password": "secret6",
      };

      const filtered = authorizer.filterRecord(variations, {
        role: "admin",
        isOwner: true,
      });

      // All password variations should be stripped
      Object.keys(variations).forEach((key) => {
        expect(filtered).not.toHaveProperty(key);
      });
    });
  });

  describe("Performance and Scalability", () => {
    it("should handle large export datasets efficiently", async () => {
      const largeDataset = Array.from({ length: 1000 }, (_, i) => ({
        id: `user_${i}`,
        email: `user${i}@example.com`,
        password: `secret${i}`,
        balance: `${i * 100}.00`,
      }));

      const startTime = Date.now();

      largeDataset.forEach((record) => {
        const filtered = authorizer.filterRecord(record, {
          role: "user",
          isOwner: true,
        });
        expect(filtered).not.toHaveProperty("password");
      });

      const duration = Date.now() - startTime;

      // Should complete in reasonable time (< 1 second for 1000 records)
      expect(duration).toBeLessThan(1000);
    });

    it("should handle records with many fields", async () => {
      const wideRecord: Record<string, any> = {
        password: "secret",
        apiKey: "key123",
      };

      // Add 100 public fields
      for (let i = 0; i < 100; i++) {
        wideRecord[`field${i}`] = `value${i}`;
      }

      const filtered = authorizer.filterRecord(wideRecord, {
        role: "user",
        isOwner: true,
      }) as any;

      expect(filtered).not.toHaveProperty("password");
      expect(filtered).not.toHaveProperty("apiKey");
      expect(filtered.field0).toBe("value0");
      expect(filtered.field99).toBe("value99");
    });
  });
});

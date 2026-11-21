import { ForbiddenException, ExecutionContext } from "@nestjs/common";
import { AuditLogService, RetentionReport } from "./audit-log.service";
import { AuditLogController } from "./audit-log.controller";
import { ComplianceOfficerGuard } from "./guards/compliance-officer.guard";
import { Role } from "src/common/guard/roles.enum";
import { minimizeAuditMetadata } from "./audit-log-metadata.policy";

describe("AuditLog Retention Enforcement for Sensitive Metadata", () => {
  const RETENTION_CUTOFF = new Date("2020-01-01T00:00:00.000Z");

  describe("Normal Path", () => {
    it("deletes records older than retention cutoff that have no active sensitive metadata holds", async () => {
      const oldDate = new Date("2010-01-01");
      const eligibleLog1 = { id: "log-eligible-1", createdAt: oldDate, metadata: null };
      const eligibleLog2 = { id: "log-eligible-2", createdAt: oldDate, metadata: { reasonCode: "auth_failure" } };
      const protectedDispute = {
        id: "log-protected-dispute",
        createdAt: oldDate,
        metadata: { activeDisputeId: "disp-101" },
      };
      const protectedCase = {
        id: "log-protected-case",
        createdAt: oldDate,
        metadata: { auditCaseId: "case-202" },
      };
      const protectedSettlement = {
        id: "log-protected-settlement",
        createdAt: oldDate,
        metadata: { settlementId: "settle-303" },
      };
      const protectedHold = {
        id: "log-protected-hold",
        createdAt: oldDate,
        metadata: { retentionHold: true },
      };

      const repo = {
        find: jest.fn().mockResolvedValue([
          eligibleLog1,
          eligibleLog2,
          protectedDispute,
          protectedCase,
          protectedSettlement,
          protectedHold,
        ]),
        remove: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AuditLogService(repo as any, {} as any, {} as any);

      const report = await service.enforceRetention(RETENTION_CUTOFF);

      expect(report.scanned).toBe(6);
      expect(report.eligible).toBe(2);
      expect(report.protected).toBe(4);
      expect(report.affectedIds).toEqual(["log-eligible-1", "log-eligible-2"]);
      expect(report.protectedIds).toEqual([
        "log-protected-dispute",
        "log-protected-case",
        "log-protected-settlement",
        "log-protected-hold",
      ]);
      expect(repo.remove).toHaveBeenCalledWith([eligibleLog1, eligibleLog2]);
    });

    it("keeps previewRetention strictly read-only with zero database deletions", async () => {
      const oldDate = new Date("2010-01-01");
      const eligible = { id: "eligible-1", createdAt: oldDate, metadata: null };
      const held = { id: "held-1", createdAt: oldDate, metadata: { retentionHold: true } };

      const repo = {
        find: jest.fn().mockResolvedValue([eligible, held]),
        remove: jest.fn(),
      };
      const service = new AuditLogService(repo as any, {} as any, {} as any);

      const preview = await service.previewRetention(RETENTION_CUTOFF);

      expect(repo.find).toHaveBeenCalled();
      expect(repo.remove).not.toHaveBeenCalled();
      expect(preview.scanned).toBe(2);
      expect(preview.eligible).toBe(1);
      expect(preview.protected).toBe(1);
      expect(preview.affectedIds).toEqual(["eligible-1"]);
      expect(preview.protectedIds).toEqual(["held-1"]);
    });

    it("preserves retention and investigation metadata under minimization policy while scrubbing secrets", () => {
      const sanitized = minimizeAuditMetadata({
        adminId: "admin-42",
        activeDisputeId: "dispute-77",
        auditCaseId: "case-99",
        retentionHold: true,
        settlementId: "settle-11",
        reasonCode: "security_audit",
        unauthorizedField: "discard_me",
        password: "super_secret_password",
        bearerToken: "eyJhbGciOi...",
      });

      expect(sanitized).toEqual({
        adminId: "admin-42",
        activeDisputeId: "dispute-77",
        auditCaseId: "case-99",
        retentionHold: true,
        settlementId: "settle-11",
        reasonCode: "security_audit",
      });
      expect(sanitized).not.toHaveProperty("password");
      expect(sanitized).not.toHaveProperty("bearerToken");
      expect(sanitized).not.toHaveProperty("unauthorizedField");
    });
  });

  describe("Failure Path", () => {
    it("handles database removal failure without altering state or deleting protected records", async () => {
      const eligible = { id: "eligible-1", createdAt: new Date("2010-01-01"), metadata: {} };
      const protectedItem = {
        id: "protected-1",
        createdAt: new Date("2010-01-01"),
        metadata: { retentionHold: true },
      };

      const repo = {
        find: jest.fn().mockResolvedValue([eligible, protectedItem]),
        remove: jest.fn().mockRejectedValue(new Error("Database connection dropped during DELETE")),
      };
      const service = new AuditLogService(repo as any, {} as any, {} as any);

      await expect(service.enforceRetention(RETENTION_CUTOFF)).rejects.toThrow(
        "Database connection dropped during DELETE",
      );
      expect(repo.remove).toHaveBeenCalledWith([eligible]);
      expect(repo.remove).not.toHaveBeenCalledWith(expect.arrayContaining([protectedItem]));
    });

    it("safely handles malformed metadata (null, undefined, string, non-object) without crashing", async () => {
      const candidateNullMeta = { id: "null-meta", createdAt: new Date("2010-01-01"), metadata: null };
      const candidateUndefMeta = { id: "undef-meta", createdAt: new Date("2010-01-01"), metadata: undefined };
      const candidateStringMeta = { id: "str-meta", createdAt: new Date("2010-01-01"), metadata: "malformed_json_str" };
      const candidateProtected = {
        id: "protected-meta",
        createdAt: new Date("2010-01-01"),
        metadata: { activeDisputeId: "disp-1" },
      };

      const repo = {
        find: jest.fn().mockResolvedValue([
          candidateNullMeta,
          candidateUndefMeta,
          candidateStringMeta,
          candidateProtected,
        ]),
        remove: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AuditLogService(repo as any, {} as any, {} as any);

      const report = await service.enforceRetention(RETENTION_CUTOFF);

      expect(report.scanned).toBe(4);
      expect(report.eligible).toBe(3);
      expect(report.protected).toBe(1);
      expect(report.affectedIds).toEqual(["null-meta", "undef-meta", "str-meta"]);
      expect(report.protectedIds).toEqual(["protected-meta"]);
      expect(repo.remove).toHaveBeenCalledWith([
        candidateNullMeta,
        candidateUndefMeta,
        candidateStringMeta,
      ]);
    });
  });

  describe("Retry Path", () => {
    it("safely re-executes retention after transient failure and achieves idempotent clean completion", async () => {
      const eligible = { id: "eligible-item", createdAt: new Date("2010-01-01"), metadata: null };
      const protectedItem = {
        id: "protected-item",
        createdAt: new Date("2010-01-01"),
        metadata: { auditCaseId: "case-001" },
      };

      let activeRows = [eligible, protectedItem];
      const repo = {
        find: jest.fn().mockImplementation(() => Promise.resolve([...activeRows])),
        remove: jest
          .fn()
          .mockRejectedValueOnce(new Error("Transient connection timeout"))
          .mockImplementationOnce(async (toRemove: any[]) => {
            activeRows = activeRows.filter((row) => !toRemove.includes(row));
          }),
      };
      const service = new AuditLogService(repo as any, {} as any, {} as any);

      // Attempt 1 fails
      await expect(service.enforceRetention(RETENTION_CUTOFF)).rejects.toThrow("Transient connection timeout");

      // Attempt 2 (retry) succeeds
      const retryReport = await service.enforceRetention(RETENTION_CUTOFF);
      expect(retryReport.scanned).toBe(2);
      expect(retryReport.eligible).toBe(1);
      expect(retryReport.protected).toBe(1);
      expect(retryReport.affectedIds).toEqual(["eligible-item"]);

      // Attempt 3 (idempotent run) finds 0 eligible records
      const subsequentReport = await service.enforceRetention(RETENTION_CUTOFF);
      expect(subsequentReport.scanned).toBe(1);
      expect(subsequentReport.eligible).toBe(0);
      expect(subsequentReport.protected).toBe(1);
      expect(subsequentReport.affectedIds).toEqual([]);
    });

    it("does not call remove when no eligible records exist", async () => {
      const protectedItem = {
        id: "protected-only",
        createdAt: new Date("2010-01-01"),
        metadata: { retentionHold: true },
      };

      const repo = {
        find: jest.fn().mockResolvedValue([protectedItem]),
        remove: jest.fn(),
      };
      const service = new AuditLogService(repo as any, {} as any, {} as any);

      const report = await service.enforceRetention(RETENTION_CUTOFF);
      expect(report.scanned).toBe(1);
      expect(report.eligible).toBe(0);
      expect(repo.remove).not.toHaveBeenCalled();
    });
  });

  describe("Authorization Path", () => {
    const createMockContext = (user: any): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ user }),
        }),
      } as unknown as ExecutionContext);

    it("allows compliance officers (KYC_OPERATOR) and ADMIN roles to access retention controls", () => {
      const guard = new ComplianceOfficerGuard();

      expect(guard.canActivate(createMockContext({ id: "user-1", role: Role.ADMIN }))).toBe(true);
      expect(guard.canActivate(createMockContext({ id: "user-2", role: Role.KYC_OPERATOR }))).toBe(true);
      expect(guard.canActivate(createMockContext({ id: "user-3", role: "admin" }))).toBe(true);
      expect(guard.canActivate(createMockContext({ id: "user-4", role: "kyc_operator" }))).toBe(true);
    });

    it("rejects non-compliance roles (USER, OPERATOR) with 403 Forbidden", () => {
      const guard = new ComplianceOfficerGuard();

      expect(() => guard.canActivate(createMockContext({ id: "user-5", role: Role.USER }))).toThrow(
        ForbiddenException,
      );
      expect(() => guard.canActivate(createMockContext({ id: "user-6", role: "operator" }))).toThrow(
        ForbiddenException,
      );
    });

    it("rejects unauthenticated requests with 403 Forbidden", () => {
      const guard = new ComplianceOfficerGuard();
      expect(() => guard.canActivate(createMockContext(undefined))).toThrow(ForbiddenException);
    });

    it("exposes preview, enforce, and verify retention endpoints on AuditLogController", async () => {
      const expectedReport: RetentionReport = {
        cutoff: RETENTION_CUTOFF,
        scanned: 1,
        eligible: 1,
        protected: 0,
        affectedIds: ["log-1"],
        protectedIds: [],
        verifiedDeletedCount: 1,
        unverifiedIds: [],
        verificationPassed: true,
      };

      const expectedVerification = {
        verified: true,
        scannedCount: 1,
        verifiedDeletedCount: 1,
        remainingIds: [],
        verificationPassed: true,
      };

      const mockService = {
        previewRetention: jest.fn().mockResolvedValue(expectedReport),
        enforceRetention: jest.fn().mockResolvedValue(expectedReport),
        verifyDeletion: jest.fn().mockResolvedValue(expectedVerification),
      };

      const controller = new AuditLogController(mockService as any);

      const preview = await controller.previewRetention();
      expect(preview).toEqual(expectedReport);
      expect(mockService.previewRetention).toHaveBeenCalledTimes(1);

      const enforcement = await controller.enforceRetention();
      expect(enforcement).toEqual(expectedReport);
      expect(mockService.enforceRetention).toHaveBeenCalledTimes(1);

      const verification = await controller.verifyDeletion({ ids: ["log-1"] });
      expect(verification).toEqual(expectedVerification);
      expect(mockService.verifyDeletion).toHaveBeenCalledWith(["log-1"]);
    });
  });

  describe("Deletion Verification Path", () => {
    it("confirms all eligible records are verified deleted and reports verificationPassed = true", async () => {
      const oldDate = new Date("2010-01-01");
      const eligible1 = { id: "log-del-1", createdAt: oldDate, metadata: null };
      const eligible2 = { id: "log-del-2", createdAt: oldDate, metadata: null };
      const protectedItem = {
        id: "log-del-protected",
        createdAt: oldDate,
        metadata: { retentionHold: true },
      };

      let activeRecords = [eligible1, eligible2, protectedItem];
      const repo = {
        find: jest.fn().mockImplementation((query) => {
          if (query?.where?.id) {
            // Verification query: return only records in activeRecords that match query
            return Promise.resolve(activeRecords.filter((r) => r.id === "log-del-1" || r.id === "log-del-2"));
          }
          return Promise.resolve([...activeRecords]);
        }),
        remove: jest.fn().mockImplementation(async (toRemove: any[]) => {
          activeRecords = activeRecords.filter((r) => !toRemove.some((rem) => rem.id === r.id));
        }),
      };
      const service = new AuditLogService(repo as any, {} as any, {} as any);

      const report = await service.enforceRetention(RETENTION_CUTOFF);
      expect(report.scanned).toBe(3);
      expect(report.eligible).toBe(2);
      expect(report.protected).toBe(1);
      expect(report.affectedIds).toEqual(["log-del-1", "log-del-2"]);
      expect(report.verifiedDeletedCount).toBe(2);
      expect(report.unverifiedIds).toEqual([]);
      expect(report.verificationPassed).toBe(true);
    });

    it("detects unverified records when database silently fails to delete records", async () => {
      const remainingRecord = { id: "stuck-record-1", createdAt: new Date("2010-01-01"), metadata: null };
      const repo = {
        find: jest.fn().mockResolvedValue([remainingRecord]),
      };
      const service = new AuditLogService(repo as any, {} as any, {} as any);

      const result = await service.verifyDeletion(["stuck-record-1", "deleted-record-2"]);
      expect(result.verified).toBe(false);
      expect(result.verificationPassed).toBe(false);
      expect(result.scannedCount).toBe(2);
      expect(result.verifiedDeletedCount).toBe(1);
      expect(result.remainingIds).toEqual(["stuck-record-1"]);
    });

    it("retries deletion verification transient errors with exponential backoff and succeeds", async () => {
      const repo = {
        find: jest
          .fn()
          .mockRejectedValueOnce(new Error("Transient connection timeout"))
          .mockResolvedValueOnce([]),
      };
      const service = new AuditLogService(repo as any, {} as any, {} as any);

      const result = await service.verifyDeletionWithRetry(["verified-1"], 3, 10);
      expect(result.verified).toBe(true);
      expect(result.verificationPassed).toBe(true);
      expect(result.verifiedDeletedCount).toBe(1);
      expect(repo.find).toHaveBeenCalledTimes(2);
    });

    it("returns verified = true with zero count when empty ID list is passed", async () => {
      const service = new AuditLogService({} as any, {} as any, {} as any);
      const result = await service.verifyDeletion([]);
      expect(result.verified).toBe(true);
      expect(result.scannedCount).toBe(0);
      expect(result.verifiedDeletedCount).toBe(0);
      expect(result.remainingIds).toEqual([]);
    });
  });
});

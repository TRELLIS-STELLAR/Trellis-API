import { RollbackVerificationService } from "./rollback-verifier.service";

describe("RollbackVerificationService", () => {
  let service: RollbackVerificationService;

  beforeEach(() => {
    service = new RollbackVerificationService();
  });

  describe("Successful Rollback Verification", () => {
    it("should return VERIFIED when all schema, data, and connectivity invariants pass", async () => {
      const report = await service.verifyRollback({
        targetMigration: "1727000000000-InitialCoreSchema.ts",
      });

      expect(report.overallStatus).toBe("VERIFIED");
      expect(report.canResumeTraffic).toBe(true);
      expect(report.discrepancies).toHaveLength(0);
      expect(report.remediationGuidance).toHaveLength(0);
      expect(report.checks.length).toBeGreaterThanOrEqual(5);

      for (const check of report.checks) {
        expect(check.status).toBe("PASSED");
      }
    });
  });

  describe("Failure Detection & Traffic Blocking", () => {
    it("should fail verification and block traffic if migration locks remain acquired", async () => {
      const report = await service.verifyRollback({
        targetMigration: "1727000000000-InitialCoreSchema.ts",
        mockFailures: { migrationLock: true },
      });

      expect(report.overallStatus).toBe("FAILED");
      expect(report.canResumeTraffic).toBe(false);
      expect(report.discrepancies.some((d) => d.includes("lock table"))).toBe(true);
      expect(report.remediationGuidance.some((r) => r.includes("RELEASE_LOCK"))).toBe(true);
    });

    it("should fail verification and report discrepancies if core tables are missing", async () => {
      const report = await service.verifyRollback({
        targetMigration: "1727000000000-InitialCoreSchema.ts",
        mockFailures: { missingTables: ["wallets", "reconciliation_invoices"] },
      });

      expect(report.overallStatus).toBe("FAILED");
      expect(report.canResumeTraffic).toBe(false);
      expect(report.discrepancies.some((d) => d.includes("Missing core tables"))).toBe(true);
      expect(report.remediationGuidance.some((r) => r.includes("pg_dump"))).toBe(true);
    });

    it("should fail verification if database smoke query fails", async () => {
      const report = await service.verifyRollback({
        targetMigration: "1727000000000-InitialCoreSchema.ts",
        mockFailures: { smokeQueryFailure: true },
      });

      expect(report.overallStatus).toBe("FAILED");
      expect(report.canResumeTraffic).toBe(false);
      expect(report.discrepancies.some((d) => d.includes("Smoke query"))).toBe(true);
    });
  });

  describe("Warning Thresholds & Non-Fatal Inconsistencies", () => {
    it("should return WARNING and permit traffic with guidance on minor referential integrity discrepancies", async () => {
      const report = await service.verifyRollback({
        targetMigration: "1727000000000-InitialCoreSchema.ts",
        mockFailures: { referentialIntegrityViolations: 3 },
      });

      expect(report.overallStatus).toBe("WARNING");
      expect(report.canResumeTraffic).toBe(true);
      expect(report.discrepancies.some((d) => d.includes("Referential integrity warnings"))).toBe(true);
      expect(report.remediationGuidance.some((r) => r.includes("orphaned foreign key audit"))).toBe(true);
    });
  });
});

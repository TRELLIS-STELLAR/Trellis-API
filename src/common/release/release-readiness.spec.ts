import {
  analyzeMigrationFile,
  verifyMigrationReadiness,
  executeSmokeTestsWithRetry,
  verifyRollbackSafety,
} from "./release-readiness.checker";
import { ReleaseChecklistService } from "./release-checklist.service";
import { ReleaseChecklistController } from "./release-checklist.controller";
import { CheckStatus, CheckSeverity } from "./release-checklist";
import { BadRequestException, ForbiddenException } from "@nestjs/common";

describe("Release Readiness Verification", () => {
  describe("Migration Readiness Checks", () => {
    it("passes a clean, reversible migration with down() and concurrent indexes", () => {
      const content = `
        import { MigrationInterface, QueryRunner } from "typeorm";
        export class SafeMigration implements MigrationInterface {
          name = "SafeMigration123";
          public async up(queryRunner: QueryRunner): Promise<void> {
            await queryRunner.query('CREATE TABLE "test" ("id" serial PRIMARY KEY, "name" varchar(100))');
            await queryRunner.query('CREATE INDEX CONCURRENTLY "IDX_test_name" ON "test" ("name")');
          }
          public async down(queryRunner: QueryRunner): Promise<void> {
            await queryRunner.query('DROP TABLE "test"');
          }
        }
      `;

      const spec = analyzeMigrationFile("123-safe-migration.ts", content);
      expect(spec.hasDownMethod).toBe(true);
      expect(spec.hasExclusiveLock).toBe(false);
      expect(spec.createsIndexConcurrently).toBe(true);
      expect(spec.hasUnsafeNotNullAdd).toBe(false);
      expect(spec.issues).toHaveLength(0);

      const report = verifyMigrationReadiness([{ filename: "123-safe-migration.ts", content }]);
      expect(report.isReady).toBe(true);
      expect(report.reversibleCount).toBe(1);
    });

    it("fails when migration lacks a down() method", () => {
      const content = `
        export class OneWayMigration {
          public async up(queryRunner: any): Promise<void> {
            await queryRunner.query('ALTER TABLE "users" ADD COLUMN "active" boolean');
          }
        }
      `;
      const spec = analyzeMigrationFile("no-down.ts", content);
      expect(spec.hasDownMethod).toBe(false);
      expect(spec.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("does not implement a down() method")]),
      );

      const report = verifyMigrationReadiness([{ filename: "no-down.ts", content }]);
      expect(report.isReady).toBe(false);
    });

    it("fails when down() declares irreversible operations", () => {
      const content = `
        export class IrreversibleMigration {
          public async up(queryRunner: any): Promise<void> {
            await queryRunner.query('DROP TABLE "legacy_data"');
          }
          public async down(queryRunner: any): Promise<void> {
            throw new Error("This migration is irreversible");
          }
        }
      `;
      const spec = analyzeMigrationFile("irreversible.ts", content);
      expect(spec.hasDownMethod).toBe(false);
      expect(spec.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("explicitly declares down() as irreversible")]),
      );
    });

    it("detects dangerous table locks and non-concurrent indexes", () => {
      const content = `
        export class LockingMigration {
          public async up(queryRunner: any): Promise<void> {
            await queryRunner.query('LOCK TABLE "orders" IN ACCESS EXCLUSIVE MODE');
            await queryRunner.query('CREATE INDEX "IDX_orders_total" ON "orders" ("total")');
          }
          public async down(queryRunner: any): Promise<void> {
            await queryRunner.query('DROP INDEX "IDX_orders_total"');
          }
        }
      `;
      const spec = analyzeMigrationFile("locking.ts", content);
      expect(spec.hasExclusiveLock).toBe(true);
      expect(spec.createsIndexConcurrently).toBe(false);
      expect(spec.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("explicit LOCK TABLE")]),
      );
      expect(spec.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("without CONCURRENTLY")]),
      );
    });

    it("detects unsafe NOT NULL column additions without DEFAULT value", () => {
      const content = `
        export class UnsafeColumnMigration {
          public async up(queryRunner: any): Promise<void> {
            await queryRunner.query('ALTER TABLE "users" ADD COLUMN "tier" varchar NOT NULL');
          }
          public async down(queryRunner: any): Promise<void> {
            await queryRunner.query('ALTER TABLE "users" DROP COLUMN "tier"');
          }
        }
      `;
      const spec = analyzeMigrationFile("unsafe-col.ts", content);
      expect(spec.hasUnsafeNotNullAdd).toBe(true);
      expect(spec.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("adds a NOT NULL column without a DEFAULT")]),
      );
    });
  });

  describe("Smoke Tests with Retry & Backoff", () => {
    it("passes immediately on first attempt when probe succeeds", async () => {
      const probeFn = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      const report = await executeSmokeTestsWithRetry([
        { name: "health-check", probeFn, required: true },
      ]);

      expect(report.allPassed).toBe(true);
      expect(report.passedProbes).toBe(1);
      expect(report.failedProbes).toBe(0);
      expect(report.results[0].attempts).toBe(1);
      expect(report.results[0].status).toBe("PASSED");
      expect(probeFn).toHaveBeenCalledTimes(1);
    });

    it("retries on transient failure and succeeds after backoff", async () => {
      const probeFn = jest
        .fn()
        .mockRejectedValueOnce(new Error("Connection reset by peer"))
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const onRetry = jest.fn();
      const report = await executeSmokeTestsWithRetry(
        [{ name: "auth-preflight", probeFn, required: true }],
        { maxAttempts: 3, backoffMs: 10, onRetry },
      );

      expect(report.allPassed).toBe(true);
      expect(report.passedProbes).toBe(1);
      expect(report.results[0].attempts).toBe(2);
      expect(report.results[0].status).toBe("PASSED");
      expect(report.results[0].detail).toContain("recovered and succeeded on retry attempt 2");
      expect(probeFn).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith("auth-preflight", 1, "Connection reset by peer");
    });

    it("fails when all retry attempts are exhausted on critical probe", async () => {
      const probeFn = jest.fn().mockResolvedValue({ ok: false, status: 503, error: "Service Unavailable" });
      const report = await executeSmokeTestsWithRetry(
        [{ name: "database-ping", probeFn, required: true }],
        { maxAttempts: 3, backoffMs: 5 },
      );

      expect(report.allPassed).toBe(false);
      expect(report.failedProbes).toBe(1);
      expect(report.results[0].attempts).toBe(3);
      expect(report.results[0].status).toBe("FAILED");
      expect(report.results[0].error).toContain("Service Unavailable");
      expect(probeFn).toHaveBeenCalledTimes(3);
    });

    it("warns without blocking when optional probe fails", async () => {
      const probeFn = jest.fn().mockResolvedValue({ ok: false, status: 504, error: "Gateway Timeout" });
      const report = await executeSmokeTestsWithRetry(
        [{ name: "external-analytics-ping", probeFn, required: false }],
        { maxAttempts: 2, backoffMs: 5 },
      );

      expect(report.allPassed).toBe(true);
      expect(report.warnedProbes).toBe(1);
      expect(report.failedProbes).toBe(0);
      expect(report.results[0].status).toBe("WARN");
    });
  });

  describe("Rollback Safety Verification", () => {
    it("confirms safe zero-downtime rollback for nullable or defaulted columns", () => {
      const report = verifyRollbackSafety([
        { table: "users", column: "avatarUrl", isNew: true, isNullable: true, hasDefault: false },
        { table: "orders", column: "discountRate", isNew: true, isNullable: false, hasDefault: true },
      ]);

      expect(report.safeForZeroDowntimeRollback).toBe(true);
      expect(report.backwardCompatible).toBe(true);
      expect(report.breakingChanges).toHaveLength(0);
    });

    it("flags breaking changes when new column is NOT NULL without DEFAULT", () => {
      const report = verifyRollbackSafety([
        { table: "subscriptions", column: "planId", isNew: true, isNullable: false, hasDefault: false },
      ]);

      expect(report.safeForZeroDowntimeRollback).toBe(false);
      expect(report.backwardCompatible).toBe(false);
      expect(report.breakingChanges).toEqual(
        expect.arrayContaining([expect.stringContaining("is NOT NULL and lacks a DEFAULT")]),
      );
    });

    it("flags breaking changes when a column is dropped", () => {
      const report = verifyRollbackSafety([
        { table: "users", column: "legacyToken", isNew: false, isNullable: true, hasDefault: false, isDropped: true },
      ]);

      expect(report.safeForZeroDowntimeRollback).toBe(false);
      expect(report.breakingChanges).toEqual(
        expect.arrayContaining([expect.stringContaining("was dropped")]),
      );
    });

    it("flags non-reversible down migrations as unsafe for automatic rollback", () => {
      const report = verifyRollbackSafety([], false);
      expect(report.safeForZeroDowntimeRollback).toBe(false);
      expect(report.breakingChanges).toEqual(
        expect.arrayContaining([expect.stringContaining("irreversible operations")]),
      );
    });
  });

  describe("ReleaseChecklistService", () => {
    let service: ReleaseChecklistService;

    beforeEach(() => {
      service = new ReleaseChecklistService();
    });

    it("creates checklist and classifies critical changes correctly", () => {
      const critical = service.createChecklist("101", "Add database migration", ["src/migrations/1.ts"]);
      expect(critical.isCriticalChange).toBe(true);
      expect(critical.checks.length).toBeGreaterThan(10);
      expect(critical.overallStatus).toBe("NEEDS_ATTENTION");

      const nonCritical = service.createChecklist("102", "Fix typo in readme", ["README.md"]);
      expect(nonCritical.isCriticalChange).toBe(false);
      expect(nonCritical.checks.every((c) => c.severity === CheckSeverity.CRITICAL)).toBe(true);
    });

    it("updates check result and recalculates overall status", () => {
      const checklist = service.createChecklist("103", "Test PR", []);
      service.updateCheckResult(checklist, "test_unit_coverage", CheckStatus.PASSED, {
        notes: "85% coverage achieved",
      });

      expect(checklist.results.get("test_unit_coverage")?.status).toBe(CheckStatus.PASSED);
      expect(checklist.results.get("test_unit_coverage")?.passedAt).toBeInstanceOf(Date);
    });

    it("enforces waiver rules with minimum justification and tracks audit history", () => {
      const checklist = service.createChecklist("104", "Waiver PR", []);

      // Reject empty or short reason
      expect(() => {
        service.waiveCheck(checklist, "migration_locking", "short", "lead@trellis.com");
      }).toThrow(BadRequestException);

      // Reject missing approver
      expect(() => {
        service.waiveCheck(checklist, "migration_locking", "Valid detailed justification for test", "");
      }).toThrow(BadRequestException);

      // Valid waiver
      service.waiveCheck(
        checklist,
        "migration_locking",
        "Low traffic table during scheduled maintenance window",
        "lead@trellis.com",
      );

      const result = checklist.results.get("migration_locking");
      expect(result?.status).toBe(CheckStatus.WAIVED);
      expect(result?.waiverApprovedBy).toBe("lead@trellis.com");

      const audit = service.getAuditHistory("104");
      expect(audit.some((a) => a.action === "WAIVE")).toBe(true);
    });

    it("blocks release approval when critical checks are not passed or waived", () => {
      const checklist = service.createChecklist("105", "Blocked PR", ["src/auth/service.ts"]);
      const check = service.canApproveRelease(checklist);
      expect(check.canApprove).toBe(false);
      expect(check.reason).toContain("Critical check not completed");

      const approved = service.approveRelease(checklist, "admin@trellis.com");
      expect(approved).toBe(false);
      expect(checklist.approvedBy).toBeUndefined();
    });

    it("allows release approval when all critical checks pass or are waived", () => {
      const checklist = service.createChecklist("106", "Ready PR", ["README.md"]);
      const criticalChecks = checklist.checks.filter((c) => c.severity === CheckSeverity.CRITICAL);

      for (const c of criticalChecks) {
        service.updateCheckResult(checklist, c.id, CheckStatus.PASSED);
      }

      const check = service.canApproveRelease(checklist);
      expect(check.canApprove).toBe(true);

      const approved = service.approveRelease(checklist, "maintainer@trellis.com");
      expect(approved).toBe(true);
      expect(checklist.approvedBy).toBe("maintainer@trellis.com");
      expect(checklist.approvedAt).toBeInstanceOf(Date);
    });

    it("executes automated verification for migrations, smoke tests, and rollback", async () => {
      const safeMigration = `
        export class GoodMig {
          async up(q: any) { await q.query('CREATE TABLE "x" ("id" int)'); }
          async down(q: any) { await q.query('DROP TABLE "x"'); }
        }
      `;

      const result = await service.runAutomatedVerification("107", {
        migrations: [{ filename: "good.ts", content: safeMigration }],
        smokeProbes: [{ name: "api-health", probeFn: async () => ({ ok: true, status: 200 }) }],
        schemaChanges: [{ table: "x", column: "extra", isNew: true, isNullable: true, hasDefault: false }],
      });

      expect(result.migrationReport?.isReady).toBe(true);
      expect(result.smokeTestReport?.allPassed).toBe(true);
      expect(result.rollbackReport?.safeForZeroDowntimeRollback).toBe(true);

      const checklist = service.getChecklist("107")!;
      expect(checklist.results.get("migration_reversibility")?.status).toBe(CheckStatus.PASSED);
      expect(checklist.results.get("migration_locking")?.status).toBe(CheckStatus.PASSED);
      expect(checklist.results.get("test_integration")?.status).toBe(CheckStatus.PASSED);
      expect(checklist.results.get("rollback_data_safety")?.status).toBe(CheckStatus.PASSED);
    });
  });

  describe("ReleaseChecklistController", () => {
    let service: ReleaseChecklistService;
    let controller: ReleaseChecklistController;

    beforeEach(() => {
      service = new ReleaseChecklistService();
      controller = new ReleaseChecklistController(service);
    });

    it("creates, retrieves, and lists checklists", () => {
      const createRes = controller.createChecklist(
        { prNumber: "201", title: "Add indexing", files: ["src/migrations/idx.ts"] },
        { user: { email: "admin@trellis.com" } },
      );

      expect(createRes.checklist.prNumber).toBe("201");
      expect(createRes.summary.total).toBeGreaterThan(0);

      const getRes = controller.getChecklistStatus("201");
      expect(getRes.checklist).toBeDefined();
      expect(getRes.markdown).toContain("Release Readiness Checklist");

      const listRes = controller.listChecklists();
      expect(listRes.count).toBe(1);
    });

    it("executes automated verification through the controller endpoint", async () => {
      controller.createChecklist({ prNumber: "202", title: "Auto PR", files: [] });

      const verifyRes = await controller.verifyReadiness("202", {
        smokeProbes: [{ name: "quick-ping", probeFn: async () => ({ ok: true, status: 200 }) }],
      });

      expect(verifyRes.smokeTestReport.allPassed).toBe(true);
      const statusRes = controller.getChecklistStatus("202");
      expect(statusRes.checklist.results.get("test_integration")?.status).toBe(CheckStatus.PASSED);
    });

    it("updates and waives checks via controller", () => {
      controller.createChecklist({ prNumber: "203", title: "Update PR", files: [] });

      controller.updateCheck("203", "test_unit_coverage", {
        status: CheckStatus.PASSED,
        notes: "Coverage verified",
      });

      const statusRes = controller.getChecklistStatus("203");
      expect(statusRes.checklist.results.get("test_unit_coverage")?.status).toBe(CheckStatus.PASSED);

      controller.waiveCheck("203", "migration_backfill", {
        reason: "No historical data exists in this environment",
        approvedBy: "security-lead@trellis.com",
      });

      const waivedRes = controller.getChecklistStatus("203");
      expect(waivedRes.checklist.results.get("migration_backfill")?.status).toBe(CheckStatus.WAIVED);
    });

    it("rejects approval when critical checks are incomplete", () => {
      controller.createChecklist({
        prNumber: "204",
        title: "Critical PR",
        files: ["src/migrations/1.ts"],
      });

      expect(() => {
        controller.approveRelease("204", { approvedBy: "admin@trellis.com" });
      }).toThrow(ForbiddenException);
    });
  });
});

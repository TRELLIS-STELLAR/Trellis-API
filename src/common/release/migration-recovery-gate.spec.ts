/**
 * Automated tests for Migration and Recovery Evidence Release Gate — Issue #569
 *
 * Covers:
 *  • Normal path: reversible migrations with compliant recovery drill pass gate
 *  • Failure path: missing evidence, failed drill, RPO/RTO breaches, dirty invariants, irreversible migrations
 *  • Retry path: resolving failed drill on subsequent submission transitions gate from BLOCKED to PASS
 *  • Authorization path: ADMIN waiver unblocks recovery gate; non-admin/short reason rejected
 *  • Edge cases: zero-schema releases, schema-changes without migrations, missing URLs, age limits
 */

import { ReleaseChecklistService } from "./release-checklist.service";
import { ReleaseChecklistController } from "./release-checklist.controller";
import { CheckStatus } from "./release-checklist";
import { RecoveryEvidence } from "./release-gate";
import { Role } from "../guard/roles.enum";

const NOW = new Date("2026-10-18T12:00:00Z");

const SAFE_MIGRATION = {
  filename: "1-create-users-table.ts",
  content: `
    export class CreateUsersTable {
      async up(queryRunner) {
        await queryRunner.query('CREATE TABLE "users" ("id" serial PRIMARY KEY, "name" varchar(255))');
      }
      async down(queryRunner) {
        await queryRunner.query('DROP TABLE "users"');
      }
    }
  `,
};

const IRREVERSIBLE_MIGRATION = {
  filename: "2-destructive-migration.ts",
  content: `
    export class DestructiveMigration {
      async up(queryRunner) {
        await queryRunner.query('DROP TABLE "legacy_data"');
      }
    }
  `,
};

const VALID_RECOVERY_EVIDENCE: RecoveryEvidence = {
  backupVerifiedAt: "2026-10-10T10:00:00Z",
  restoreDrillAt: "2026-10-12T10:00:00Z",
  restoreOutcome: "passed",
  targetRpoMinutes: 15,
  targetRtoMinutes: 60,
  measuredRpoMinutes: 5,
  measuredRtoMinutes: 40,
  invariantsConsistent: true,
  criticalFailures: 0,
  evidenceUrl: "https://trellis.internal/dr/drills/2026-10-12",
};

describe("Migration & Recovery Evidence Release Gate (#569)", () => {
  let service: ReleaseChecklistService;
  let controller: ReleaseChecklistController;

  const adminReq = { user: { email: "admin@trellis.com", roles: [Role.ADMIN] } };

  beforeEach(() => {
    service = new ReleaseChecklistService();
    controller = new ReleaseChecklistController(service);
  });

  // ── Normal path ────────────────────────────────────────────────────────────

  describe("Normal path", () => {
    it("passes the release gate when migrations are reversible and recovery evidence is compliant", async () => {
      const result = await service.runAutomatedVerification(
        "569-1",
        {
          migrations: [SAFE_MIGRATION],
          recovery: VALID_RECOVERY_EVIDENCE,
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(true);
      expect(result.blockingReasons).toHaveLength(0);
      expect(result.migrationRecoveryGate?.decision).toBe("PASS");
      expect(result.migrationRecoveryGate?.recoveryStatus).toBe("PASSED");
      expect(result.migrationRecoveryGate?.migrationStatus).toBe("PASSED");

      const checklist = service.getChecklist("569-1")!;
      const recoveryCheck = checklist.results.get("migration_recovery_evidence");
      expect(recoveryCheck?.status).toBe(CheckStatus.PASSED);
      expect(recoveryCheck?.notes).toContain("Verified recovery evidence");
    });

    it("evaluates gate directly via evaluateMigrationAndRecoveryGate", () => {
      const res = service.evaluateMigrationAndRecoveryGate(
        "569-2",
        {
          migrations: [SAFE_MIGRATION],
          recovery: VALID_RECOVERY_EVIDENCE,
        },
        { now: NOW },
        "admin@trellis.com",
      );

      expect(res.decision.decision).toBe("PASS");
      expect(res.blockingReasons).toHaveLength(0);
      const checklist = service.getChecklist("569-2")!;
      expect(checklist.results.get("migration_recovery_evidence")?.status).toBe(CheckStatus.PASSED);
    });

    it("controller endpoint evaluates gate successfully for admin", () => {
      const response = controller.evaluateReleaseGate(
        "569-ctrl-1",
        {
          migrations: [SAFE_MIGRATION],
          recovery: VALID_RECOVERY_EVIDENCE,
          options: { now: NOW },
        },
        adminReq,
      );

      expect(response.decision.decision).toBe("PASS");
      expect(response.blockingReasons).toHaveLength(0);
    });
  });

  // ── Failure path ───────────────────────────────────────────────────────────

  describe("Failure path", () => {
    it("blocks when migrations are present without recovery evidence", async () => {
      const result = await service.runAutomatedVerification(
        "569-fail-1",
        {
          migrations: [SAFE_MIGRATION],
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(false);
      expect(result.migrationRecoveryGate?.decision).toBe("BLOCKED");
      expect(result.migrationRecoveryGate?.recoveryStatus).toBe("BLOCKED");
      expect(result.blockingReasons.some((r) => r.includes("require recorded recovery evidence"))).toBe(true);

      const checklist = service.getChecklist("569-fail-1")!;
      expect(checklist.results.get("migration_recovery_evidence")?.status).toBe(CheckStatus.FAILED);
    });

    it("blocks when restore drill did not pass", async () => {
      const failedRecovery: RecoveryEvidence = {
        ...VALID_RECOVERY_EVIDENCE,
        restoreOutcome: "failed",
      };

      const result = await service.runAutomatedVerification(
        "569-fail-2",
        {
          migrations: [SAFE_MIGRATION],
          recovery: failedRecovery,
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes("The restore drill did not pass"))).toBe(true);
    });

    it("blocks when measured RPO or RTO exceeds the target threshold", async () => {
      const breachRecovery: RecoveryEvidence = {
        ...VALID_RECOVERY_EVIDENCE,
        measuredRpoMinutes: 20, // target is 15
        measuredRtoMinutes: 75, // target is 60
      };

      const result = await service.runAutomatedVerification(
        "569-fail-3",
        {
          migrations: [SAFE_MIGRATION],
          recovery: breachRecovery,
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes("Measured RPO 20m exceeds the 15m target"))).toBe(true);
      expect(result.blockingReasons.some((r) => r.includes("Measured RTO 75m exceeds the 60m target"))).toBe(true);
    });

    it("blocks when disaster recovery invariant report is inconsistent or has critical failures", async () => {
      const dirtyRecovery: RecoveryEvidence = {
        ...VALID_RECOVERY_EVIDENCE,
        invariantsConsistent: false,
        criticalFailures: 3,
      };

      const result = await service.runAutomatedVerification(
        "569-fail-4",
        {
          migrations: [SAFE_MIGRATION],
          recovery: dirtyRecovery,
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes("3 critical failure(s)"))).toBe(true);
    });

    it("blocks when backup verification or restore drill is stale or future-dated", async () => {
      const staleRecovery: RecoveryEvidence = {
        ...VALID_RECOVERY_EVIDENCE,
        backupVerifiedAt: "2026-08-01T00:00:00Z", // > 30 days before NOW
      };

      const result = await service.runAutomatedVerification(
        "569-fail-5",
        {
          migrations: [SAFE_MIGRATION],
          recovery: staleRecovery,
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes("older than 30 days"))).toBe(true);
    });

    it("blocks when migrations are irreversible even if recovery evidence passes", async () => {
      const result = await service.runAutomatedVerification(
        "569-fail-6",
        {
          migrations: [IRREVERSIBLE_MIGRATION],
          recovery: VALID_RECOVERY_EVIDENCE,
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(false);
      expect(result.migrationRecoveryGate?.migrationStatus).toBe("BLOCKED");
      expect(result.migrationRecoveryGate?.decision).toBe("BLOCKED");
    });
  });

  // ── Retry path ─────────────────────────────────────────────────────────────

  describe("Retry path", () => {
    it("transitions gate from BLOCKED to PASS when fresh compliant drill is resubmitted", async () => {
      // 1. Initial attempt fails due to RPO target breach
      const failingRecovery: RecoveryEvidence = {
        ...VALID_RECOVERY_EVIDENCE,
        measuredRpoMinutes: 25,
      };

      const firstAttempt = await service.runAutomatedVerification(
        "569-retry-1",
        {
          migrations: [SAFE_MIGRATION],
          recovery: failingRecovery,
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(firstAttempt.overallReady).toBe(false);
      expect(firstAttempt.migrationRecoveryGate?.decision).toBe("BLOCKED");

      // 2. Retry attempt with updated drill within RPO SLA
      const successfulRecovery: RecoveryEvidence = {
        ...VALID_RECOVERY_EVIDENCE,
        measuredRpoMinutes: 8,
      };

      const retryAttempt = await service.runAutomatedVerification(
        "569-retry-1",
        {
          migrations: [SAFE_MIGRATION],
          recovery: successfulRecovery,
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(retryAttempt.overallReady).toBe(true);
      expect(retryAttempt.migrationRecoveryGate?.decision).toBe("PASS");
      expect(retryAttempt.migrationRecoveryGate?.recoveryStatus).toBe("PASSED");

      const checklist = service.getChecklist("569-retry-1")!;
      expect(checklist.results.get("migration_recovery_evidence")?.status).toBe(CheckStatus.PASSED);
    });

    it("handles retried smoke tests with warning while allowing gate to pass", async () => {
      const result = await service.runAutomatedVerification(
        "569-retry-2",
        {
          migrations: [SAFE_MIGRATION],
          recovery: VALID_RECOVERY_EVIDENCE,
          tests: {
            requiredSuites: ["smoke"],
            suites: [{ name: "smoke", passed: 10, failed: 0, retries: 2 }],
          },
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(true);
      expect(result.migrationRecoveryGate?.decision).toBe("PASS");
    });
  });

  // ── Authorization path ─────────────────────────────────────────────────────

  describe("Authorization path", () => {
    it("allows ADMIN waiver to unblock a missing recovery evidence gate", async () => {
      const result = await service.runAutomatedVerification(
        "569-auth-1",
        {
          migrations: [SAFE_MIGRATION],
          waivers: [
            {
              gate: "recovery",
              reason: "Pre-approved staging disaster recovery exemption by CTO",
              approvedBy: "admin@trellis.com",
              approverRole: Role.ADMIN,
            },
          ],
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(true);
      expect(result.migrationRecoveryGate?.recoveryStatus).toBe("WAIVED");
      const checklist = service.getChecklist("569-auth-1")!;
      expect(checklist.results.get("migration_recovery_evidence")?.status).toBe(CheckStatus.WAIVED);
    });

    it("rejects waiver when approver is not an ADMIN", async () => {
      const result = await service.runAutomatedVerification(
        "569-auth-2",
        {
          migrations: [SAFE_MIGRATION],
          waivers: [
            {
              gate: "recovery",
              reason: "Attempted waiver by non-admin member",
              approvedBy: "user@trellis.com",
              approverRole: Role.USER,
            },
          ],
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes("approver is not an ADMIN"))).toBe(true);
    });

    it("rejects waiver with reason shorter than 10 characters", async () => {
      const result = await service.runAutomatedVerification(
        "569-auth-3",
        {
          migrations: [SAFE_MIGRATION],
          waivers: [
            {
              gate: "recovery",
              reason: "Too short",
              approvedBy: "admin@trellis.com",
              approverRole: Role.ADMIN,
            },
          ],
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes("at least 10 characters"))).toBe(true);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("releases without migrations or schema changes automatically pass recovery gate", async () => {
      const result = await service.runAutomatedVerification(
        "569-edge-1",
        {
          migrations: [],
          schemaChanges: [],
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(true);
      expect(result.migrationRecoveryGate).toBeUndefined();
    });

    it("schema changes without explicit migration files still enforce recovery evidence requirement", async () => {
      const result = await service.runAutomatedVerification(
        "569-edge-2",
        {
          schemaChanges: [
            {
              table: "accounts",
              column: "tier",
              isNew: true,
              isNullable: true,
              hasDefault: true,
            },
          ],
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes("require recorded recovery evidence"))).toBe(true);
    });

    it("missing evidenceUrl warns without blocking the gate", async () => {
      const noUrlRecovery: RecoveryEvidence = {
        ...VALID_RECOVERY_EVIDENCE,
        evidenceUrl: undefined,
      };

      const result = await service.runAutomatedVerification(
        "569-edge-3",
        {
          migrations: [SAFE_MIGRATION],
          recovery: noUrlRecovery,
          releaseGateOptions: { now: NOW },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(true);
      expect(result.migrationRecoveryGate?.warnings.some((w) => w.includes("evidenceUrl"))).toBe(true);
    });

    it("honours custom maximum recovery age days", async () => {
      const result = await service.runAutomatedVerification(
        "569-edge-4",
        {
          migrations: [SAFE_MIGRATION],
          recovery: VALID_RECOVERY_EVIDENCE, // 6-8 days old relative to NOW
          releaseGateOptions: { now: NOW, maxRecoveryAgeDays: 3 },
        },
        "admin@trellis.com",
      );

      expect(result.overallReady).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes("older than 3 days"))).toBe(true);
    });
  });
});

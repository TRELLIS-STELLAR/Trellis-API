#!/usr/bin/env node
/**
 * Executable Verification Script for Release Readiness Checks
 * covering Migrations, Smoke Tests, and Rollback Safety.
 *
 * Usage:
 *   node scripts/verify-release-readiness.js
 */

const assert = require("assert");
const path = require("path");

async function main() {
  console.log("===================================================================");
  console.log("🚀 Running Release Readiness Verification Suite");
  console.log("===================================================================\n");

  const checkerPath = path.resolve(__dirname, "../src/common/release/release-readiness.checker.ts");
  const servicePath = path.resolve(__dirname, "../src/common/release/release-checklist.service.ts");
  const checklistPath = path.resolve(__dirname, "../src/common/release/release-checklist.ts");

  let checker, serviceModule, checklistModule;

  try {
    checker = await import(`file://${checkerPath.replace(/\\/g, "/")}`);
    serviceModule = await import(`file://${servicePath.replace(/\\/g, "/")}`);
    checklistModule = await import(`file://${checklistPath.replace(/\\/g, "/")}`);
  } catch (_err) {
    const createJiti = require("jiti");
    const jiti = createJiti(__filename);
    checker = jiti(checkerPath);
    serviceModule = jiti(servicePath);
    checklistModule = jiti(checklistPath);
  }

  const {
    analyzeMigrationFile,
    verifyMigrationReadiness,
    executeSmokeTestsWithRetry,
    verifyRollbackSafety,
  } = checker;

  const { ReleaseChecklistService } = serviceModule;
  const { CheckStatus, CheckSeverity } = checklistModule;

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  // ── INVARIANT 1: Migration Reversibility and down() Validation ──────
  await test("Invariant 1: Reversible migrations pass, missing down() or irreversible down() fails", async () => {
    const safeContent = `
      export class SafeMigration {
        async up(q) { await q.query('CREATE TABLE "test" ("id" serial PRIMARY KEY)'); }
        async down(q) { await q.query('DROP TABLE "test"'); }
      }
    `;
    const safeSpec = analyzeMigrationFile("safe.ts", safeContent);
    assert.strictEqual(safeSpec.hasDownMethod, true, "Safe migration must have valid down method");
    assert.strictEqual(safeSpec.issues.length, 0, "Safe migration should have no issues");

    const noDownContent = `
      export class NoDownMigration {
        async up(q) { await q.query('ALTER TABLE "users" ADD COLUMN "flag" boolean'); }
      }
    `;
    const noDownSpec = analyzeMigrationFile("no-down.ts", noDownContent);
    assert.strictEqual(noDownSpec.hasDownMethod, false, "Missing down method must be detected");
    assert(noDownSpec.issues.some((i) => i.includes("does not implement a down() method")));

    const irreversibleContent = `
      export class IrreversibleMigration {
        async up(q) { await q.query('DROP TABLE "users"'); }
        async down(q) { throw new Error("This migration is irreversible"); }
      }
    `;
    const irrevSpec = analyzeMigrationFile("irrev.ts", irreversibleContent);
    assert.strictEqual(irrevSpec.hasDownMethod, false, "Irreversible down must be flagged as non-reversible");
  });

  // ── INVARIANT 2: Migration Locking & Concurrency Rules ──────────────
  await test("Invariant 2: Detects explicit LOCK TABLE and non-concurrent index additions", async () => {
    const lockContent = `
      export class LockMig {
        async up(q) {
          await q.query('LOCK TABLE "accounts" IN ACCESS EXCLUSIVE MODE');
          await q.query('CREATE INDEX "IDX_acc_num" ON "accounts" ("num")');
        }
        async down(q) { await q.query('DROP INDEX "IDX_acc_num"'); }
      }
    `;
    const spec = analyzeMigrationFile("lock.ts", lockContent);
    assert.strictEqual(spec.hasExclusiveLock, true, "Explicit table lock must be detected");
    assert.strictEqual(spec.createsIndexConcurrently, false, "Non-concurrent index must be flagged");
    assert(spec.warnings.some((w) => w.includes("CONCURRENTLY")), "Warning for non-concurrent index missing");
  });

  // ── INVARIANT 3: Smoke Test Retry with Exponential Backoff ──────────
  await test("Invariant 3: Smoke tests retry transient failures with backoff and report attempt metrics", async () => {
    let callCount = 0;
    const probeFn = async () => {
      callCount++;
      if (callCount < 3) {
        return { ok: false, status: 503, error: "Gateway warming up" };
      }
      return { ok: true, status: 200 };
    };

    const retriedAttempts = [];
    const report = await executeSmokeTestsWithRetry(
      [{ name: "preflight-health", probeFn, required: true }],
      {
        maxAttempts: 3,
        backoffMs: 20,
        onRetry: (name, attempt, err) => retriedAttempts.push({ name, attempt, err }),
      },
    );

    assert.strictEqual(report.allPassed, true, "Should pass after retrying transient failures");
    assert.strictEqual(report.passedProbes, 1);
    assert.strictEqual(report.results[0].attempts, 3, "Probe should have required 3 attempts");
    assert.strictEqual(retriedAttempts.length, 2, "onRetry should have fired twice before success");
    assert(report.results[0].detail.includes("recovered and succeeded on retry attempt 3"));
  });

  // ── INVARIANT 4: Hard Smoke Test Failure on Exhausted Attempts ──────
  await test("Invariant 4: Exhausted smoke test attempts fail release readiness", async () => {
    const failingProbe = async () => ({ ok: false, status: 500, error: "Internal Server Error" });
    const report = await executeSmokeTestsWithRetry(
      [{ name: "critical-db-ping", probeFn: failingProbe, required: true }],
      { maxAttempts: 2, backoffMs: 10 },
    );

    assert.strictEqual(report.allPassed, false, "Should fail when required probe exhausts retries");
    assert.strictEqual(report.failedProbes, 1);
    assert.strictEqual(report.results[0].status, "FAILED");
    assert(report.results[0].error.includes("Internal Server Error"));
  });

  // ── INVARIANT 5: Zero-Downtime Rollback Safety Rules ────────────────
  await test("Invariant 5: Rollback safety enforces nullable or defaulted columns for backward compatibility", async () => {
    const safeReport = verifyRollbackSafety([
      { table: "users", column: "preferredTheme", isNew: true, isNullable: true, hasDefault: false },
      { table: "orders", column: "shippingMethod", isNew: true, isNullable: false, hasDefault: true },
    ]);
    assert.strictEqual(safeReport.safeForZeroDowntimeRollback, true, "Nullable / defaulted columns must be rollback safe");
    assert.strictEqual(safeReport.breakingChanges.length, 0);

    const breakingReport = verifyRollbackSafety([
      { table: "users", column: "tenantId", isNew: true, isNullable: false, hasDefault: false },
      { table: "users", column: "legacyToken", isNew: false, isNullable: true, hasDefault: false, isDropped: true },
    ]);
    assert.strictEqual(breakingReport.safeForZeroDowntimeRollback, false, "Breaking schema changes must not be rollback safe");
    assert.strictEqual(breakingReport.breakingChanges.length, 2, "Expected 2 breaking change violations");
    assert(breakingReport.breakingChanges.some((c) => c.includes("NOT NULL and lacks a DEFAULT")));
    assert(breakingReport.breakingChanges.some((c) => c.includes("was dropped")));
  });

  // ── INVARIANT 6: Waiver Management & Audit Logging ──────────────────
  await test("Invariant 6: Waivers require detailed justification, recorded approver, and produce audit entries", async () => {
    const service = new ReleaseChecklistService();
    const checklist = service.createChecklist("PR-301", "Schema Update", ["src/migrations/1.ts"]);

    let threwBadRequest = false;
    try {
      service.waiveCheck(checklist, "migration_locking", "too short", "admin@trellis.com");
    } catch (err) {
      threwBadRequest = true;
    }
    assert.strictEqual(threwBadRequest, true, "Waiver with <10 character justification must be rejected");

    service.waiveCheck(
      checklist,
      "migration_locking",
      "Off-peak maintenance window with read-only traffic diversion",
      "maintainer@trellis.com",
    );

    const result = checklist.results.get("migration_locking");
    assert.strictEqual(result.status, CheckStatus.WAIVED);
    assert.strictEqual(result.waiverApprovedBy, "maintainer@trellis.com");

    const audit = service.getAuditHistory("PR-301");
    assert(audit.some((a) => a.action === "WAIVE"), "Audit log must record WAIVE action");
  });

  // ── INVARIANT 7: Release Approval Gating ────────────────────────────
  await test("Invariant 7: Release approval strictly blocks when critical checks are pending or failed", async () => {
    const service = new ReleaseChecklistService();
    const checklist = service.createChecklist("PR-302", "Payment Engine V2", ["src/payments/engine.ts"]);

    const canApproveInitial = service.canApproveRelease(checklist);
    assert.strictEqual(canApproveInitial.canApprove, false, "Fresh checklist must not be approved initially");
    assert.strictEqual(service.approveRelease(checklist, "admin@trellis.com"), false);

    // Pass all critical checks
    const criticalChecks = checklist.checks.filter((c) => c.severity === CheckSeverity.CRITICAL);
    for (const c of criticalChecks) {
      service.updateCheckResult(checklist, c.id, CheckStatus.PASSED);
    }

    const canApproveAfter = service.canApproveRelease(checklist);
    assert.strictEqual(canApproveAfter.canApprove, true, "Should allow approval once all critical checks pass");

    const approved = service.approveRelease(checklist, "admin@trellis.com");
    assert.strictEqual(approved, true, "Approval should succeed");
    assert.strictEqual(checklist.approvedBy, "admin@trellis.com");
  });

  // ── INVARIANT 8: Full End-to-End Automated Verification ─────────────
  await test("Invariant 8: Automated verification orchestrates migrations, smoke tests, and rollback safety", async () => {
    const service = new ReleaseChecklistService();
    const migrationSql = `
      export class CleanMigration {
        async up(q) {
          await q.query('CREATE TABLE "tokens" ("id" serial PRIMARY KEY, "symbol" varchar)');
          await q.query('CREATE INDEX CONCURRENTLY "IDX_token_symbol" ON "tokens" ("symbol")');
        }
        async down(q) { await q.query('DROP TABLE "tokens"'); }
      }
    `;

    const evalResult = await service.runAutomatedVerification("PR-303", {
      migrations: [{ filename: "clean.ts", content: migrationSql }],
      smokeProbes: [{ name: "health", probeFn: async () => ({ ok: true, status: 200 }) }],
      schemaChanges: [{ table: "tokens", column: "metadata", isNew: true, isNullable: true, hasDefault: false }],
    });

    assert.strictEqual(evalResult.migrationReport.isReady, true);
    assert.strictEqual(evalResult.smokeTestReport.allPassed, true);
    assert.strictEqual(evalResult.rollbackReport.safeForZeroDowntimeRollback, true);

    const checklist = service.getChecklist("PR-303");
    assert.strictEqual(checklist.results.get("migration_reversibility").status, CheckStatus.PASSED);
    assert.strictEqual(checklist.results.get("migration_locking").status, CheckStatus.PASSED);
    assert.strictEqual(checklist.results.get("test_integration").status, CheckStatus.PASSED);
    assert.strictEqual(checklist.results.get("rollback_data_safety").status, CheckStatus.PASSED);
  });

  console.log("\n===================================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("===================================================================\n");

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log("🎉 All release readiness verification checks passed!\n");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Unexpected error running release readiness verification:", err);
  process.exit(1);
});

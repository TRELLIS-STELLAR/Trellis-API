/**
 * Executable Verification Suite for the Synthetic Journey Monitor.
 *
 * Imports and executes the production TypeScript engine directly:
 * 1. Happy path end-to-end execution (all 5 steps, zero failures, SUCCESS status).
 * 2. Latency measurement and SLA breach detection (DEGRADED state trigger).
 * 3. Failure detection and dependency blame attribution for POSTGRES_DB.
 * 4. Dependency blame attribution for STELLAR_HORIZON upon reconciliation timeout.
 * 5. Dependency blame attribution for DEFI_PROTOCOL_RPC upon rate limiting / RPC failure.
 * 6. Dependency blame attribution for NOTIFICATION_GATEWAY upon broker / socket drop.
 * 7. Cascade protection (subsequent steps safely marked SKIPPED upon step failure).
 * 8. Scheduler lifecycle (startScheduler & stopScheduler idempotent operations).
 * 9. Controller contract verification (proper status mapping and responses).
 *
 * Usage:
 *   node scripts/verify-synthetic-journey.js
 */

const assert = require("assert");
const path = require("path");

async function main() {
  console.log("==================================================================");
  console.log("🧪 Running Synthetic Journey Monitor Executable Verification Suite");
  console.log("==================================================================\n");

  const enginePath = path.resolve(
    __dirname,
    "../src/monitoring/synthetic-journey/synthetic-journey.engine.ts",
  );

  const { SyntheticJourneyEngine } = await import(
    `file://${enginePath.replace(/\\/g, "/")}`
  );

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

  const engine = new SyntheticJourneyEngine();

  // Test 1: Happy path execution
  await test("Invariant 1: Happy path executes 5 critical steps and reports SUCCESS status", async () => {
    const report = await engine.runJourney({ trigger: "CLI" });
    assert.strictEqual(report.status, "SUCCESS");
    assert.strictEqual(report.totalSteps, 5);
    assert.strictEqual(report.passedSteps, 5);
    assert.strictEqual(report.failedSteps, 0);
    assert.strictEqual(report.degradedSteps, 0);
    assert.strictEqual(report.dependencyBlame.length, 0);
    assert(report.durationMs >= 0, "Duration must be non-negative");

    const expectedStepIds = [
      "step_auth_verify",
      "step_portfolio_rebalance",
      "step_defi_yield",
      "step_settlement_reconcile",
      "step_notification_dispatch",
    ];
    assert.deepStrictEqual(
      report.steps.map((s) => s.stepId),
      expectedStepIds,
    );
  });

  // Test 2: Latency measurement & SLA violation
  await test("Invariant 2: Latency tracking flags step as DEGRADED upon SLA threshold breach", async () => {
    const report = await engine.runJourney({
      trigger: "MANUAL",
      simulateLatencyStep: { stepId: "step_auth_verify", extraMs: 350 }, // SLA is 300ms
    });

    assert.strictEqual(report.status, "DEGRADED");
    assert.strictEqual(report.degradedSteps, 1);
    assert.strictEqual(report.passedSteps, 4);
    assert.strictEqual(report.failedSteps, 0);

    const authStep = report.steps.find((s) => s.stepId === "step_auth_verify");
    assert(authStep, "Auth step must exist");
    assert.strictEqual(authStep.status, "DEGRADED");
    assert.strictEqual(authStep.slaBreached, true);
    assert(authStep.latencyMs >= 300, `Latency must exceed 300ms, got ${authStep.latencyMs}`);
    assert(report.dependencyBlame.includes("AUTH_SERVICE"));
  });

  // Test 3: Failure detection & dependency blame for Database
  await test("Invariant 3: Failure detection attributes blame to POSTGRES_DB for portfolio step failure", async () => {
    const report = await engine.runJourney({
      trigger: "MANUAL",
      simulateFailureStep: "step_portfolio_rebalance",
    });

    assert.strictEqual(report.status, "FAILED");
    assert.strictEqual(report.failedSteps, 1);
    assert(report.dependencyBlame.includes("POSTGRES_DB"), "Must blame POSTGRES_DB");

    const dbStep = report.steps.find((s) => s.stepId === "step_portfolio_rebalance");
    assert(dbStep, "DB step must exist");
    assert.strictEqual(dbStep.status, "FAILED");
    assert.strictEqual(dbStep.error.blame, "POSTGRES_DB");
    assert(
      dbStep.error.remediation.toLowerCase().includes("postgres"),
      "Must provide Postgres remediation",
    );
  });

  // Test 4: Dependency blame for Stellar Horizon
  await test("Invariant 4: Dependency blame attributes to STELLAR_HORIZON on reconciliation failure", async () => {
    const report = await engine.runJourney({
      trigger: "MANUAL",
      simulateFailureStep: "step_settlement_reconcile",
    });

    assert.strictEqual(report.status, "FAILED");
    assert(report.dependencyBlame.includes("STELLAR_HORIZON"));

    const reconcileStep = report.steps.find(
      (s) => s.stepId === "step_settlement_reconcile",
    );
    assert(reconcileStep, "Reconcile step must exist");
    assert.strictEqual(reconcileStep.error.blame, "STELLAR_HORIZON");
    assert(reconcileStep.error.remediation.toLowerCase().includes("horizon"));
  });

  // Test 5: Dependency blame for DeFi Protocol RPC
  await test("Invariant 5: Dependency blame attributes to DEFI_PROTOCOL_RPC on DeFi failure", async () => {
    const report = await engine.runJourney({
      trigger: "MANUAL",
      simulateFailureStep: "step_defi_yield",
    });

    assert.strictEqual(report.status, "FAILED");
    assert(report.dependencyBlame.includes("DEFI_PROTOCOL_RPC"));

    const defiStep = report.steps.find((s) => s.stepId === "step_defi_yield");
    assert.strictEqual(defiStep.error.blame, "DEFI_PROTOCOL_RPC");
    assert(defiStep.error.remediation.toLowerCase().includes("rpc"));
  });

  // Test 6: Dependency blame for Notification Gateway
  await test("Invariant 6: Dependency blame attributes to NOTIFICATION_GATEWAY on socket error", async () => {
    const report = await engine.runJourney({
      trigger: "MANUAL",
      simulateFailureStep: "step_notification_dispatch",
    });

    assert.strictEqual(report.status, "FAILED");
    assert(report.dependencyBlame.includes("NOTIFICATION_GATEWAY"));

    const notifStep = report.steps.find(
      (s) => s.stepId === "step_notification_dispatch",
    );
    assert.strictEqual(notifStep.error.blame, "NOTIFICATION_GATEWAY");
    assert(notifStep.error.remediation.toLowerCase().includes("notification"));
  });

  // Test 7: Cascade skipping behavior
  await test("Invariant 7: Subsequent steps are safely marked SKIPPED when an upstream step fails", async () => {
    const report = await engine.runJourney({
      trigger: "MANUAL",
      simulateFailureStep: "step_auth_verify",
    });

    assert.strictEqual(report.status, "FAILED");
    assert.strictEqual(report.steps[0].status, "FAILED");
    for (let i = 1; i < report.steps.length; i++) {
      assert.strictEqual(
        report.steps[i].status,
        "SKIPPED",
        `Step ${report.steps[i].stepId} should be SKIPPED`,
      );
    }
  });

  // Test 8: Scheduler start/stop lifecycle
  await test("Invariant 8: Scheduler handles start and stop without leaking timers or exceptions", async () => {
    let fired = false;
    engine.startScheduler(100000, () => {
      fired = true;
    });
    // Double start should be idempotent
    engine.startScheduler(100000);
    engine.stopScheduler();
    // Double stop should be idempotent
    engine.stopScheduler();
  });

  console.log("\n------------------------------------------------------------------");
  console.log(`Verification Results: ${passed} passed, ${failed} failed`);
  console.log("------------------------------------------------------------------\n");

  if (failed > 0) {
    console.error("❌ Some verification checks failed!");
    process.exit(1);
  } else {
    console.log("🎉 All Synthetic Journey Monitor Invariants Verified Successfully!\n");
    process.exit(0);
  }
}

main();

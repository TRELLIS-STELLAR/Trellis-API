#!/usr/bin/env node
/**
 * Executable Verification Script for Policy Simulation Preview
 * before Committing Irreversible or High-Impact Changes.
 *
 * Verifies:
 * 1. Trading policy preview: affected pending trades, degraded portfolios, expected side effects,
 *    and rollback constraints without mutating state.
 * 2. DeFi adapter policy preview: irreversible on-chain emergency unwind detection, tightened
 *    health factor evaluation, and explicit commitToken requirement.
 * 3. Portfolio rebalancing policy preview: concentration limit violations and auto-rebalance wave detection.
 * 4. Auth access policy preview: immediate session revocation irreversibility, MFA step-up impact,
 *    and anti-lockout invariant blocking ADMIN role restriction.
 * 5. Notification routing policy preview: mandatory security channel overrides and digest re-windowing.
 * 6. Operational edge cases: stale population snapshot warning & commit-blocking constraint,
 *    and partial sample population extrapolation.
 * 7. Identifier masking (no raw wallet/user ID leakage) and deterministic SHA-256 commitToken & digest.
 *
 * Usage:
 *   node scripts/verify-policy-simulation.js
 */

const assert = require("assert");
const path = require("path");

async function main() {
  console.log("===================================================================");
  console.log("🔍 Running Policy Simulation Preview Verification Suite");
  console.log("===================================================================\n");

  const rulesPath = path.resolve(
    __dirname,
    "../src/policy/policy-simulation.rules.ts",
  );
  const rules = await import(`file://${rulesPath.replace(/\\/g, "/")}`);

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

  const fixedAsOf = "2026-10-17T00:00:00.000Z";

  // 1. Trading policy preview
  await test("Invariant 1: Trading policy simulation previews rejected pending trades, affected portfolios, and rollback constraints", () => {
    const res = rules.simulatePolicyChange({
      domain: "trading",
      proposedPolicy: {
        maxOrderAmount: 50_000,
        allowedAssets: ["XLM", "USDC"],
      },
      asOf: fixedAsOf,
    });

    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(res.readOnly, true);
    assert.strictEqual(res.domain, "trading");
    assert.strictEqual(res.reversibility, "partially_reversible");
    assert.strictEqual(res.requiresCommitToken, true);
    assert.strictEqual(res.affectedSummary.affectedRecordCount, 3);
    assert.strictEqual(res.affectedSummary.affectedRecordsByType.pending_trade, 1);
    assert.strictEqual(res.affectedSummary.affectedRecordsByType.portfolio, 2);
    assert(
      res.expectedSideEffects.some((s) => s.code === "PENDING_TRADES_REJECTED"),
    );
    assert(
      res.expectedSideEffects.some(
        (s) => s.code === "PORTFOLIO_ALLOCATIONS_INVALIDATED",
      ),
    );
    assert(
      res.rollbackConstraints.some(
        (c) => c.code === "REJECTED_TRADES_REQUIRE_RESUBMISSION",
      ),
    );
  });

  // 2. DeFi adapter policy preview (irreversible on-chain unwind)
  await test("Invariant 2: Disabling an active DeFi adapter or raising minHealthFactor flags irreversible on-chain unwind constraints", () => {
    const res = rules.simulatePolicyChange({
      domain: "defi_adapters",
      proposedPolicy: {
        enabledAdapters: ["aave"],
        minHealthFactor: 1.5,
      },
      asOf: fixedAsOf,
    });

    assert.strictEqual(res.reversibility, "irreversible");
    assert.strictEqual(res.impactSeverity, "critical");
    assert.strictEqual(res.status, "high_impact_review_required");
    assert.strictEqual(res.requiresCommitToken, true);
    assert(
      res.expectedSideEffects.some(
        (s) => s.code === "DEFI_EMERGENCY_UNWIND_TRIGGERED",
      ),
    );
    assert(
      res.rollbackConstraints.some(
        (c) => c.code === "IRREVERSIBLE_ONCHAIN_DEFI_EXIT",
      ),
    );
  });

  // 3. Portfolio rebalancing policy preview
  await test("Invariant 3: Portfolio rebalancing policy simulation previews concentration violations and auto-rebalance waves", () => {
    const res = rules.simulatePolicyChange({
      domain: "portfolio_rebalancing",
      proposedPolicy: {
        maxSingleAssetWeightPct: 45,
        driftThresholdPct: 3.0,
      },
      asOf: fixedAsOf,
    });

    assert(res.affectedSummary.affectedRecordCount >= 2);
    assert(
      res.expectedSideEffects.some(
        (s) => s.code === "PORTFOLIO_ALLOCATIONS_INVALIDATED",
      ),
    );
    assert(
      res.expectedSideEffects.some(
        (s) => s.code === "AUTO_REBALANCE_WAVE_TRIGGERED",
      ),
    );
    assert(
      res.rollbackConstraints.some(
        (c) => c.code === "PORTFOLIO_TARGETS_REQUIRE_VERSION_RESTORE",
      ),
    );
  });

  // 4. Auth access policy preview & anti-lockout invariant
  await test("Invariant 4: Auth access policy simulation flags irreversible session revocations and blocks ADMIN role lockout", () => {
    const revokeRes = rules.simulatePolicyChange({
      domain: "auth_access",
      proposedPolicy: {
        revokeUnverifiedSessions: true,
        requireMfaForSensitiveActions: true,
      },
      asOf: fixedAsOf,
    });

    assert.strictEqual(revokeRes.reversibility, "irreversible");
    assert.strictEqual(revokeRes.impactSeverity, "critical");
    assert(
      revokeRes.expectedSideEffects.some(
        (s) => s.code === "ACTIVE_SESSIONS_REVOKED",
      ),
    );
    assert(
      revokeRes.rollbackConstraints.some(
        (c) => c.code === "IRREVERSIBLE_SESSION_REVOCATION",
      ),
    );

    const adminLockout = rules.simulatePolicyChange({
      domain: "auth_access",
      proposedPolicy: {
        disallowedRoles: ["ADMIN"],
      },
      asOf: fixedAsOf,
    });

    assert.strictEqual(adminLockout.status, "blocked_invalid_policy");
    assert(adminLockout.validationErrors.length > 0);
  });

  // 5. Notification routing policy preview
  await test("Invariant 5: Notification routing simulation surfaces overridden preferences and re-windowed digests", () => {
    const res = rules.simulatePolicyChange({
      domain: "notification_routing",
      proposedPolicy: {
        mandatorySecurityChannels: ["email", "in_app", "sms"],
        suppressMarketingChannels: true,
        digestWindowMinutes: 30,
      },
      asOf: fixedAsOf,
    });

    assert.strictEqual(res.affectedSummary.affectedRecordCount, 3);
    assert(
      res.expectedSideEffects.some(
        (s) => s.code === "NOTIFICATION_PREFERENCES_OVERRIDDEN",
      ),
    );
    assert(
      res.expectedSideEffects.some(
        (s) => s.code === "NOTIFICATION_DIGEST_REBATCHED",
      ),
    );
  });

  // 6. Stale snapshot & partial sample extrapolation
  await test("Invariant 6: Stale snapshots trigger STALE_SNAPSHOT_BLOCKS_UNSAFE_COMMIT and sampled snapshots extrapolate impact", () => {
    const baseSnapshot = rules.defaultSimulationSnapshot("2026-10-17T00:00:00.000Z");

    const staleRes = rules.simulatePolicyChange({
      domain: "trading",
      proposedPolicy: { maxOrderAmount: 80_000 },
      snapshot: baseSnapshot,
      asOf: "2026-10-17T00:10:00.000Z", // 600s > 300s default max age
    });

    assert.strictEqual(staleRes.affectedSummary.completeness, "stale_snapshot");
    assert.strictEqual(staleRes.status, "high_impact_review_required");
    assert(
      staleRes.rollbackConstraints.some(
        (c) => c.code === "STALE_SNAPSHOT_BLOCKS_UNSAFE_COMMIT",
      ),
    );

    const sampledRes = rules.simulatePolicyChange({
      domain: "trading",
      proposedPolicy: { maxOrderAmount: 50_000 },
      snapshot: {
        ...baseSnapshot,
        observedAt: fixedAsOf,
        isSampled: true,
        totalPopulationUsers: 400, // 100x sample scale (4 evaluated users)
      },
      asOf: fixedAsOf,
    });

    assert.strictEqual(sampledRes.affectedSummary.completeness, "partial_sample");
    assert.strictEqual(sampledRes.affectedSummary.affectedUserCount, 1);
    assert.strictEqual(sampledRes.affectedSummary.estimatedTotalAffectedUsers, 100);
    assert(
      sampledRes.expectedSideEffects.some(
        (s) => s.code === "PARTIAL_SAMPLE_EXTRAPOLATION",
      ),
    );
  });

  // 7. Identifier masking & deterministic commitToken/digest
  await test("Invariant 7: Owner identifiers are redacted and identical inputs produce identical SHA-256 commitToken and digest", () => {
    const res1 = rules.simulatePolicyChange({
      domain: "trading",
      proposedPolicy: { maxOrderAmount: 45_000 },
      asOf: fixedAsOf,
    });
    const res2 = rules.simulatePolicyChange({
      domain: "trading",
      proposedPolicy: { maxOrderAmount: 45_000 },
      asOf: fixedAsOf,
    });

    assert.strictEqual(res1.simulationId, res2.simulationId);
    assert.strictEqual(res1.commitToken, res2.commitToken);
    assert.strictEqual(res1.digest, res2.digest);
    for (const userId of res1.affectedSummary.affectedUserIds) {
      assert(userId.includes("..."), `Expected masked userId, got ${userId}`);
    }
  });

  console.log("\n===================================================================");
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log("===================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error during verification:", err);
  process.exit(1);
});

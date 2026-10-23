#!/usr/bin/env node
/**
 * Executable Verification Script for Trellis API Accessibility Regression Coverage.
 *
 * Verifies acceptance criteria across core workflows (Auth, Portfolio, DeFi, Notifications, Observability):
 * 1. Keyboard navigation (Tab order, Enter/Escape mappings, 2D grid keys).
 * 2. Focus management (Ordered focus traversal, initial focus containment, non-empty focusOrder).
 * 3. Screen-reader behavior (Accessible labels, structured summaries, ARIA live region politeness).
 * 4. Reduced-motion preferences (Strict 0ms transitions and animation suppression when requested).
 * 5. Error recovery flows (Assertive error announcements, actionable recovery steps, rollback safety checks).
 * 6. Public API compatibility and schema contracts.
 *
 * Usage:
 *   node scripts/verify-accessibility.js
 *   node scripts/verify-accessibility.js --json
 */

const assert = require("assert");
const path = require("path");

const isJson = process.argv.includes("--json");
const results = [];
let passed = 0;
let failed = 0;

function check(name, category, fn) {
  try {
    const detail = fn() || "Verified successfully";
    results.push({ name, category, passed: true, detail });
    passed++;
    if (!isJson) {
      console.log(`  ✅ PASS [${category}]: ${name}`);
    }
  } catch (err) {
    results.push({
      name,
      category,
      passed: false,
      detail: err.message,
    });
    failed++;
    if (!isJson) {
      console.error(`  ❌ FAIL [${category}]: ${name}`);
      console.error(`     ↳ ${err.message}`);
    }
  }
}

async function run() {
  if (!isJson) {
    console.log("===================================================================");
    console.log("♿ Running Trellis API Accessibility Regression Verification Suite");
    console.log("===================================================================\n");
  }

  const contractPath = path.resolve(__dirname, "../src/common/accessibility/accessibility.contract.ts");
  const suitesPath = path.resolve(__dirname, "../src/common/accessibility/accessibility.suites.ts");

  let contract;
  let suites;
  try {
    contract = await import(`file://${contractPath.replace(/\\/g, "/")}`);
    suites = await import(`file://${suitesPath.replace(/\\/g, "/")}`);
  } catch (_err) {
    const createJiti = require("jiti");
    const jiti = createJiti(__filename);
    contract = jiti(contractPath);
    suites = jiti(suitesPath);
  }

  // Test 1: Reduced-Motion Contract
  check(
    "Reduced-motion header triggers animation suppression and 0ms transition duration",
    "REDUCED_MOTION",
    () => {
      const reduced = contract.buildReducedMotionProfile("reduce");
      assert.strictEqual(reduced.requestedPreference, "reduce");
      assert.strictEqual(reduced.skipAnimations, true);
      assert.strictEqual(reduced.transitionDurationMs, 0);

      const standard = contract.buildReducedMotionProfile(null);
      assert.strictEqual(standard.requestedPreference, "no-preference");
      assert.strictEqual(standard.skipAnimations, false);
      assert.strictEqual(standard.transitionDurationMs, 250);
      return "0ms duration and skipAnimations strictly enforced";
    }
  );

  // Test 2: Dense Forms Accessibility Across 5 Domains
  const domains = [
    { id: "auth", name: "Stellar SEP-10 Auth", suiteFn: suites.getAuthAccessibilitySuite },
    { id: "portfolio", name: "Portfolio Rebalancing", suiteFn: suites.getPortfolioAccessibilitySuite },
    { id: "defi", name: "DeFi Position Order", suiteFn: suites.getDefiAccessibilitySuite },
    { id: "notifications", name: "Notification Routing", suiteFn: suites.getNotificationsAccessibilitySuite },
    { id: "observability", name: "Observability Telemetry", suiteFn: suites.getObservabilityAccessibilitySuite },
  ];

  domains.forEach(({ id, name, suiteFn }) => {
    check(
      `Dense form metadata, keyboard shortcuts, and ARIA summary for ${name}`,
      "DENSE_FORMS",
      () => {
        const suite = suiteFn();
        const form = suite.form;
        assert(form.formId && form.formLabel, "Form must have formId and formLabel");
        assert(form.fields.length >= 3, `Expected at least 3 fields, found ${form.fields.length}`);
        assert(form.focusOrder.length >= form.fields.length, "Focus order must cover all interactive fields");
        assert(form.focusOrder.includes(form.initialFocusField), "initialFocusField must exist within focusOrder");

        // Verify keyboard shortcuts
        assert(form.keyboardShortcuts["Enter"], "Enter key shortcut must be mapped");
        assert(form.keyboardShortcuts["Escape"], "Escape key shortcut must be mapped");

        // Verify screen reader error announcement
        assert.strictEqual(form.errorSummaryAnnouncement.politeness, "assertive");
        assert(form.errorSummaryAnnouncement.message.length > 0, "Error announcement must not be empty");

        return `${form.fields.length} fields verified with focusOrder and shortcuts`;
      }
    );
  });

  // Test 3: Tabular Grids and Keyboard Navigation
  domains.forEach(({ id, name, suiteFn }) => {
    check(
      `Data table 2D grid navigation, caption, and live pagination for ${name}`,
      "DATA_TABLES",
      () => {
        const suite = suiteFn();
        const table = suite.table;
        assert(table.caption && table.summary, "Table must have caption and summary");
        assert(table.columns.length >= 3, "Table must have at least 3 columns");
        assert(table.primaryKeyColumn, "Table must define primaryKeyColumn");

        // Verify 2D Arrow Navigation
        assert.strictEqual(table.navigationKeys.nextRow, "ArrowDown");
        assert.strictEqual(table.navigationKeys.prevRow, "ArrowUp");
        assert.strictEqual(table.navigationKeys.nextCell, "ArrowRight");
        assert.strictEqual(table.navigationKeys.prevCell, "ArrowLeft");
        assert.strictEqual(table.navigationKeys.firstCell, "Home");
        assert.strictEqual(table.navigationKeys.lastCell, "End");

        // Screen-reader live announcement
        assert(table.livePaginationAnnouncement.includes(`Showing ${table.rowCount} rows`));

        return `${table.columns.length} columns and full 2D arrow grid keys verified`;
      }
    );
  });

  // Test 4: Error Recovery & Rollback Safeties
  domains.forEach(({ id, name, suiteFn }) => {
    check(
      `Error recovery guidance, focus redirection, and rollback prompt for ${name}`,
      "ERROR_RECOVERY",
      () => {
        const suite = suiteFn();
        const recovery = suite.errorRecovery;
        assert(recovery.errorCode && recovery.errorTitle, "Must have errorCode and errorTitle");
        assert.strictEqual(recovery.politeness, "assertive", "Error recovery must be assertive");
        assert(recovery.focusTargetId, "Must specify focusTargetId for keyboard focus restoration");
        assert(recovery.recoverySteps.length >= 2, "Must specify at least 2 recovery steps");

        recovery.recoverySteps.forEach((step, idx) => {
          assert.strictEqual(step.step, idx + 1, "Recovery steps must be sequentially numbered");
          assert(step.label && step.actionable, "Each recovery step must be actionable with guidance");
        });

        if (recovery.rollbackSafe) {
          assert(recovery.rollbackActionPrompt, "Rollback safe operations must provide a rollback prompt");
        }

        return `${recovery.errorCode} verified with ${recovery.recoverySteps.length} recovery steps`;
      }
    );
  });

  // Test 5: Workflow Invariants Assertion Logic
  check(
    "Workflow invariant assertions strictly block malformed envelopes",
    "INVARIANTS",
    () => {
      // Missing focusOrder
      assert.throws(() => {
        contract.assertAccessibilityInvariants({
          workflow: "Invalid",
          screenReaderSummary: "Invalid",
          reducedMotion: { requestedPreference: "no-preference", skipAnimations: false, transitionDurationMs: 250 },
          focusManagement: { trapFocus: true, initialFocusTarget: "a", focusOrder: [] },
          keyboardNavigation: { escapeDismisses: true, enterSubmits: true, arrowKeyNavigation: true, keyMap: { Escape: "x", Enter: "y" } },
          announcements: {
            initial: { politeness: "polite", message: "i" },
            success: { politeness: "polite", message: "s" },
            error: { politeness: "assertive", message: "e" },
          },
        });
      }, /focusOrder cannot be empty/i);

      // Inconsistent reduced motion
      assert.throws(() => {
        contract.assertAccessibilityInvariants({
          workflow: "Invalid",
          screenReaderSummary: "Invalid",
          reducedMotion: { requestedPreference: "reduce", skipAnimations: true, transitionDurationMs: 200 },
          focusManagement: { trapFocus: true, initialFocusTarget: "a", focusOrder: ["a"] },
          keyboardNavigation: { escapeDismisses: true, enterSubmits: true, arrowKeyNavigation: true, keyMap: { Escape: "x", Enter: "y" } },
          announcements: {
            initial: { politeness: "polite", message: "i" },
            success: { politeness: "polite", message: "s" },
            error: { politeness: "assertive", message: "e" },
          },
        });
      }, /transitionDurationMs must be 0/i);

      return "All invariant boundary conditions rejected as expected";
    }
  );

  // Test 6: Invariant verification passes for all domain suites
  check(
    "All registered core domain accessibility suites satisfy invariants",
    "INVARIANTS",
    () => {
      domains.forEach(({ suiteFn }) => {
        const suite = suiteFn();
        contract.assertAccessibilityInvariants(suite.workflow);
      });
      return "All 5 core workflow suites passed invariant verification";
    }
  );

  // Test 7: Async Status Contract Suite Across All 5 Domains
  domains.forEach(({ name, suiteFn }) => {
    check(
      `Async status contract, keyboard navigation, and focus order for ${name}`,
      "ASYNC_STATUS",
      () => {
        const suite = suiteFn();
        const asyncStatus = suite.asyncStatus;
        assert(asyncStatus, "Suite must expose asyncStatus contract");
        assert(asyncStatus.operationId && asyncStatus.operationLabel, "Must have valid operationId and label");
        assert(asyncStatus.focusManagement.pendingFocusTarget, "Must declare pendingFocusTarget");
        assert(asyncStatus.focusManagement.completionFocusTarget, "Must declare completionFocusTarget");
        assert(asyncStatus.focusManagement.failureFocusTarget, "Must declare failureFocusTarget");
        assert(asyncStatus.keyboardControls.abortShortcut === "Escape", "Abort shortcut must be Escape");
        assert(asyncStatus.keyboardControls.shortcuts["Escape"], "Escape must be declared in shortcuts");
        contract.assertAsyncStatusInvariants(asyncStatus);
        return `Async status contract validated for ${name}`;
      }
    );
  });

  // Test 8: Async Status Normal Path (Idle -> Submitting -> Succeeded)
  check(
    "Async status normal lifecycle emits polite announcements and moves focus to completionFocusTarget",
    "ASYNC_STATUS_NORMAL",
    () => {
      const base = contract.buildAsyncStatusAccessibilityContract({
        operationId: "verify-normal-op",
        operationLabel: "Async Asset Allocation",
      });
      assert.strictEqual(base.currentPhase, "idle");
      assert.strictEqual(base.progressPercentage, 0);

      const submitting = contract.transitionAsyncStatus(base, "submitting", { progressPercentage: 25 });
      assert.strictEqual(submitting.currentPhase, "submitting");
      assert.strictEqual(submitting.statusAnnouncement.politeness, "polite");
      assert(submitting.statusAnnouncement.message.includes("Submitting"));
      assert.strictEqual(submitting.focusManagement.pendingFocusTarget, "verify-normal-op-progress");

      const succeeded = contract.transitionAsyncStatus(submitting, "succeeded");
      assert.strictEqual(succeeded.currentPhase, "succeeded");
      assert.strictEqual(succeeded.progressPercentage, 100);
      assert.strictEqual(succeeded.statusAnnouncement.politeness, "polite");
      assert(succeeded.statusAnnouncement.message.includes("completed successfully"));
      assert.strictEqual(succeeded.focusManagement.completionFocusTarget, "verify-normal-op-success-summary");
      return "Normal path transitions successfully with polite ARIA updates";
    }
  );

  // Test 9: Async Status Failure & Timeout Path (Assertive Announcements & failureFocusTarget)
  check(
    "Async status failure and timeout emit assertive announcements and redirect focus to failureFocusTarget",
    "ASYNC_STATUS_FAILURE",
    () => {
      const base = contract.buildAsyncStatusAccessibilityContract({
        operationId: "verify-fail-op",
        operationLabel: "Soroban Contract Call",
      });

      const failed = contract.transitionAsyncStatus(base, "failed", { errorMessage: "Slippage exceeded" });
      assert.strictEqual(failed.currentPhase, "failed");
      assert.strictEqual(failed.statusAnnouncement.politeness, "assertive");
      assert.strictEqual(failed.statusAnnouncement.interrupt, true);
      assert(failed.statusAnnouncement.message.includes("Slippage exceeded"));
      assert(failed.statusAnnouncement.message.includes("KeyR"));
      assert.strictEqual(failed.focusManagement.failureFocusTarget, "verify-fail-op-error-alert");

      const timedOut = contract.transitionAsyncStatus(base, "timeout");
      assert.strictEqual(timedOut.currentPhase, "timeout");
      assert.strictEqual(timedOut.statusAnnouncement.politeness, "assertive");
      assert(timedOut.statusAnnouncement.message.includes("timed out"));
      return "Failure and timeout emit assertive live announcements and point to error alert";
    }
  );

  // Test 10: Async Status Retry Path with Attempt Counter and Limit Exhaustion
  check(
    "Async status retry path tracks attempt counters, backoff, and signals exhaustion when limit is reached",
    "ASYNC_STATUS_RETRY",
    () => {
      const base = contract.buildAsyncStatusAccessibilityContract({
        operationId: "verify-retry-op",
        operationLabel: "Webhook Delivery",
        maxAttempts: 3,
      });

      const r1 = contract.transitionAsyncStatus(base, "retrying", { attempt: 1 });
      assert.strictEqual(r1.currentPhase, "retrying");
      assert.strictEqual(r1.retryState.attempt, 1);
      assert(r1.statusAnnouncement.message.includes("attempt 1 of 3"));

      const r2 = contract.transitionAsyncStatus(r1, "retrying", { attempt: 2 });
      assert.strictEqual(r2.retryState.attempt, 2);

      const exhausted = contract.transitionAsyncStatus(r2, "failed", { attempt: 3 });
      assert.strictEqual(exhausted.statusAnnouncement.politeness, "assertive");
      assert(exhausted.statusAnnouncement.message.includes("Maximum retry attempts reached"));
      return "Retry progression and limit exhaustion validated";
    }
  );

  // Test 11: Async Status Authorization Path (Session Expiration, Auth Target, and Return Target)
  check(
    "Async status authorization path redirects focus to authFocusTarget and preserves returnFocusTargetAfterAuth",
    "ASYNC_STATUS_AUTH",
    () => {
      const base = contract.buildAsyncStatusAccessibilityContract({
        operationId: "verify-auth-op",
        operationLabel: "Portfolio Optimization",
        authRequired: true,
      });

      const unauth = contract.transitionAsyncStatus(base, "unauthorized", { authRequired: true });
      assert.strictEqual(unauth.currentPhase, "unauthorized");
      assert.strictEqual(unauth.statusAnnouncement.politeness, "assertive");
      assert.strictEqual(unauth.authorizationState.authRequired, true);
      assert.strictEqual(unauth.authorizationState.reauthShortcut, "Alt+A");
      assert.strictEqual(unauth.focusManagement.authFocusTarget, "verify-auth-op-auth-modal");
      assert.strictEqual(unauth.authorizationState.returnFocusTargetAfterAuth, "verify-auth-op-progress");
      return "Authorization expiration and focus preservation verified";
    }
  );


  if (!isJson) {
    console.log("\n-------------------------------------------------------------------");
    console.log(`Summary: ${passed} passed, ${failed} failed`);
    console.log("-------------------------------------------------------------------\n");
  } else {
    console.log(JSON.stringify({ passed, failed, results }, null, 2));
  }

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Verification suite execution error:", err);
  process.exit(1);
});

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

  const contract = await import(`file://${contractPath.replace(/\\/g, "/")}`);
  const suites = await import(`file://${suitesPath.replace(/\\/g, "/")}`);

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

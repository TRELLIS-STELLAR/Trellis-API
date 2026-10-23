import {
  getAuthAccessibilitySuite,
  getPortfolioAccessibilitySuite,
  getDefiAccessibilitySuite,
  getNotificationsAccessibilitySuite,
  getObservabilityAccessibilitySuite,
} from "./accessibility.suites";
import {
  buildReducedMotionProfile,
  buildFormAccessibilityContract,
  buildTableAccessibilityContract,
  buildErrorRecoveryContract,
  buildWorkflowAccessibilityEnvelope,
  assertAccessibilityInvariants,
  buildAsyncStatusAccessibilityContract,
  transitionAsyncStatus,
  assertAsyncStatusInvariants,
} from "./accessibility.contract";

describe("Accessibility Regression Coverage Suite", () => {
  describe("Reduced Motion Behavior", () => {
    it("configures 0ms transitions and disables animations when reduced motion is preferred", () => {
      const reduced = buildReducedMotionProfile("reduce");
      expect(reduced.requestedPreference).toBe("reduce");
      expect(reduced.skipAnimations).toBe(true);
      expect(reduced.transitionDurationMs).toBe(0);

      const altReduced = buildReducedMotionProfile("true");
      expect(altReduced.skipAnimations).toBe(true);
      expect(altReduced.transitionDurationMs).toBe(0);
    });

    it("preserves standard transitions when reduced motion is not requested", () => {
      const standard = buildReducedMotionProfile(undefined);
      expect(standard.requestedPreference).toBe("no-preference");
      expect(standard.skipAnimations).toBe(false);
      expect(standard.transitionDurationMs).toBe(250);
    });
  });

  describe("Dense Forms Accessibility Contract", () => {
    const suites = [
      { name: "Auth (SEP-10 Wallet)", suite: getAuthAccessibilitySuite() },
      { name: "Portfolio Rebalancing", suite: getPortfolioAccessibilitySuite() },
      { name: "DeFi Position Order", suite: getDefiAccessibilitySuite() },
      { name: "Notification Routing", suite: getNotificationsAccessibilitySuite() },
      { name: "Observability Telemetry", suite: getObservabilityAccessibilitySuite() },
    ];

    suites.forEach(({ name, suite }) => {
      describe(`${name} Form`, () => {
        it("defines an accessible form label and non-empty form ID", () => {
          expect(suite.form.formId).toBeTruthy();
          expect(suite.form.formLabel).toBeTruthy();
        });

        it("ensures all form fields have screen-reader labels and help text", () => {
          expect(suite.form.fields.length).toBeGreaterThan(0);
          for (const field of suite.form.fields) {
            expect(field.field).toBeTruthy();
            expect(field.label).toBeTruthy();
            expect(field.helpText).toBeTruthy();
            expect(field.errorAnnouncement).toBeTruthy();
          }
        });

        it("defines a coherent focusOrder containing the initialFocusField", () => {
          expect(suite.form.focusOrder.length).toBeGreaterThan(0);
          expect(suite.form.initialFocusField).toBeTruthy();
          expect(suite.form.focusOrder).toContain(suite.form.initialFocusField);
        });

        it("declares standard keyboard shortcuts (Enter and Escape)", () => {
          expect(suite.form.keyboardShortcuts["Enter"]).toBeTruthy();
          expect(suite.form.keyboardShortcuts["Escape"]).toBeTruthy();
        });

        it("provides assertive ARIA live announcement for error summaries", () => {
          expect(suite.form.errorSummaryAnnouncement.politeness).toBe("assertive");
          expect(suite.form.errorSummaryAnnouncement.message).toMatch(/validation errors|contain/i);
          expect(suite.form.errorSummaryAnnouncement.interrupt).toBe(true);
        });
      });
    });
  });

  describe("Data Tables Accessibility Contract", () => {
    const suites = [
      { name: "Auth Sessions Table", suite: getAuthAccessibilitySuite() },
      { name: "Portfolio Holdings Grid", suite: getPortfolioAccessibilitySuite() },
      { name: "DeFi Positions Table", suite: getDefiAccessibilitySuite() },
      { name: "Notification History Table", suite: getNotificationsAccessibilitySuite() },
      { name: "Observability Regressions Table", suite: getObservabilityAccessibilitySuite() },
    ];

    suites.forEach(({ name, suite }) => {
      describe(`${name}`, () => {
        it("exposes non-empty caption, summary, and primaryKeyColumn", () => {
          expect(suite.table.caption.length).toBeGreaterThan(0);
          expect(suite.table.summary.length).toBeGreaterThan(0);
          expect(suite.table.primaryKeyColumn.length).toBeGreaterThan(0);
        });

        it("declares column headers with proper keys", () => {
          expect(suite.table.columns.length).toBeGreaterThan(0);
          for (const col of suite.table.columns) {
            expect(col.key).toBeTruthy();
            expect(col.header).toBeTruthy();
          }
        });

        it("defines 2D grid keyboard navigation keys (Arrow keys, Home, End)", () => {
          expect(suite.table.navigationKeys.nextRow).toBe("ArrowDown");
          expect(suite.table.navigationKeys.prevRow).toBe("ArrowUp");
          expect(suite.table.navigationKeys.nextCell).toBe("ArrowRight");
          expect(suite.table.navigationKeys.prevCell).toBe("ArrowLeft");
          expect(suite.table.navigationKeys.firstCell).toBe("Home");
          expect(suite.table.navigationKeys.lastCell).toBe("End");
        });

        it("provides a live region pagination announcement for screen readers", () => {
          expect(suite.table.livePaginationAnnouncement).toMatch(/Showing \d+ rows/i);
        });
      });
    });
  });

  describe("Error Recovery Flows & Rollback Invariants", () => {
    const suites = [
      { name: "Auth Signature Error", suite: getAuthAccessibilitySuite() },
      { name: "Portfolio Concentration Invariant", suite: getPortfolioAccessibilitySuite() },
      { name: "DeFi Health Factor Deficit", suite: getDefiAccessibilitySuite() },
      { name: "Notification Webhook Failure", suite: getNotificationsAccessibilitySuite() },
      { name: "Observability Baseline Error", suite: getObservabilityAccessibilitySuite() },
    ];

    suites.forEach(({ name, suite }) => {
      describe(`${name}`, () => {
        it("provides assertive ARIA live error announcements", () => {
          expect(suite.errorRecovery.politeness).toBe("assertive");
          expect(suite.errorRecovery.announcement).toContain(suite.errorRecovery.errorTitle);
        });

        it("sets a target field/heading to receive keyboard focus on error", () => {
          expect(suite.errorRecovery.focusTargetId.length).toBeGreaterThan(0);
        });

        it("provides ordered, actionable recovery steps", () => {
          expect(suite.errorRecovery.recoverySteps.length).toBeGreaterThan(0);
          suite.errorRecovery.recoverySteps.forEach((step, idx) => {
            expect(step.step).toBe(idx + 1);
            expect(step.label.length).toBeGreaterThan(0);
            expect(step.actionable).toBe(true);
          });
        });

        it("documents rollback capability and prompts if rollbackSafe", () => {
          if (suite.errorRecovery.rollbackSafe) {
            expect(suite.errorRecovery.rollbackActionPrompt).toBeTruthy();
          }
        });
      });
    });
  });

  describe("Workflow Invariant Verification", () => {
    it("fails assertion when focusOrder is empty", () => {
      const envelope = buildWorkflowAccessibilityEnvelope({
        workflow: "Test Invalid",
        screenReaderSummary: "Invalid",
        focusOrder: [],
      });
      expect(() => assertAccessibilityInvariants(envelope)).toThrow(/focusOrder cannot be empty/i);
    });

    it("fails assertion when initialFocusTarget is not in focusOrder", () => {
      const envelope = buildWorkflowAccessibilityEnvelope({
        workflow: "Test Missing Initial Focus",
        screenReaderSummary: "Invalid",
        focusOrder: ["fieldA", "fieldB"],
        initialFocusTarget: "fieldC",
      });
      expect(() => assertAccessibilityInvariants(envelope)).toThrow(/must be in focusOrder/i);
    });

    it("fails assertion when reduced motion skipAnimations is true but transition duration is non-zero", () => {
      const envelope = buildWorkflowAccessibilityEnvelope({
        workflow: "Test Reduced Motion Invariant",
        screenReaderSummary: "Invalid",
        focusOrder: ["fieldA"],
      });
      envelope.reducedMotion.skipAnimations = true;
      envelope.reducedMotion.transitionDurationMs = 200;
      expect(() => assertAccessibilityInvariants(envelope)).toThrow(/transitionDurationMs must be 0/i);
    });

    it("passes assertion for all 5 core domain workflow suites", () => {
      expect(() => assertAccessibilityInvariants(getAuthAccessibilitySuite().workflow)).not.toThrow();
      expect(() => assertAccessibilityInvariants(getPortfolioAccessibilitySuite().workflow)).not.toThrow();
      expect(() => assertAccessibilityInvariants(getDefiAccessibilitySuite().workflow)).not.toThrow();
      expect(() => assertAccessibilityInvariants(getNotificationsAccessibilitySuite().workflow)).not.toThrow();
      expect(() => assertAccessibilityInvariants(getObservabilityAccessibilitySuite().workflow)).not.toThrow();
    });
  });

  describe("Async Status States & Keyboard/Focus Coverage", () => {
    const suites = [
      { name: "Auth (SEP-10 Challenge)", suite: getAuthAccessibilitySuite() },
      { name: "Portfolio (Rebalance Execution)", suite: getPortfolioAccessibilitySuite() },
      { name: "DeFi (Liquidity Order)", suite: getDefiAccessibilitySuite() },
      { name: "Notifications (Batch Dispatch)", suite: getNotificationsAccessibilitySuite() },
      { name: "Observability (Baseline Recalculation)", suite: getObservabilityAccessibilitySuite() },
    ];

    describe("Domain Async Status Suite Contracts", () => {
      suites.forEach(({ name, suite }) => {
        it(`${name} exposes valid asyncStatus contract and passes invariants`, () => {
          expect(suite.asyncStatus).toBeDefined();
          expect(suite.asyncStatus.operationId).toBeTruthy();
          expect(suite.asyncStatus.operationLabel).toBeTruthy();
          expect(suite.asyncStatus.focusManagement.pendingFocusTarget).toBeTruthy();
          expect(suite.asyncStatus.keyboardControls.shortcuts["Escape"]).toBeTruthy();
          expect(() => assertAsyncStatusInvariants(suite.asyncStatus)).not.toThrow();
        });
      });
    });

    describe("Normal Path (Idle -> Submitting -> Succeeded)", () => {
      it("transitions smoothly with polite announcements and completion focus target", () => {
        const contract = buildAsyncStatusAccessibilityContract({
          operationId: "test-normal-op",
          operationLabel: "Portfolio Transfer",
        });

        expect(contract.currentPhase).toBe("idle");
        expect(contract.progressPercentage).toBe(0);

        // Step 1: Submitting
        const submitting = transitionAsyncStatus(contract, "submitting", { progressPercentage: 20 });
        expect(submitting.currentPhase).toBe("submitting");
        expect(submitting.statusAnnouncement.politeness).toBe("polite");
        expect(submitting.statusAnnouncement.message).toMatch(/Submitting/i);
        expect(submitting.progressPercentage).toBe(20);
        expect(submitting.focusManagement.pendingFocusTarget).toBe("test-normal-op-progress");

        // Step 2: Polling progress
        const polling = transitionAsyncStatus(submitting, "polling", { progressPercentage: 65 });
        expect(polling.currentPhase).toBe("polling");
        expect(polling.statusAnnouncement.message).toContain("65%");

        // Step 3: Success completion
        const succeeded = transitionAsyncStatus(polling, "succeeded");
        expect(succeeded.currentPhase).toBe("succeeded");
        expect(succeeded.progressPercentage).toBe(100);
        expect(succeeded.statusAnnouncement.politeness).toBe("polite");
        expect(succeeded.statusAnnouncement.message).toMatch(/completed successfully/i);
        expect(succeeded.focusManagement.completionFocusTarget).toBe("test-normal-op-success-summary");
      });
    });

    describe("Failure & Timeout Path (Submitting -> Failed / Timeout)", () => {
      it("emits assertive announcements and redirects focus to failureFocusTarget", () => {
        const contract = buildAsyncStatusAccessibilityContract({
          operationId: "test-failure-op",
          operationLabel: "DeFi Borrow Execution",
        });

        const failed = transitionAsyncStatus(contract, "failed", {
          errorMessage: "Insufficient collateral ratio",
        });

        expect(failed.currentPhase).toBe("failed");
        expect(failed.statusAnnouncement.politeness).toBe("assertive");
        expect(failed.statusAnnouncement.interrupt).toBe(true);
        expect(failed.statusAnnouncement.message).toMatch(/Insufficient collateral ratio/i);
        expect(failed.statusAnnouncement.message).toMatch(/Press KeyR to retry or Escape to cancel/i);
        expect(failed.focusManagement.failureFocusTarget).toBe("test-failure-op-error-alert");
        expect(() => assertAsyncStatusInvariants(failed)).not.toThrow();

        // Timeout transition
        const timedOut = transitionAsyncStatus(contract, "timeout");
        expect(timedOut.currentPhase).toBe("timeout");
        expect(timedOut.statusAnnouncement.politeness).toBe("assertive");
        expect(timedOut.statusAnnouncement.message).toMatch(/timed out/i);
        expect(() => assertAsyncStatusInvariants(timedOut)).not.toThrow();
      });
    });

    describe("Retry Path (Failed -> Retrying with Backoff & Exhaustion)", () => {
      it("tracks retry attempts, emits backoff progress, and asserts exhaustion on limit", () => {
        const contract = buildAsyncStatusAccessibilityContract({
          operationId: "test-retry-op",
          operationLabel: "Payment Sync",
          maxAttempts: 3,
          backoffMs: 1000,
        });

        // Attempt 1
        const retry1 = transitionAsyncStatus(contract, "retrying", { attempt: 1 });
        expect(retry1.currentPhase).toBe("retrying");
        expect(retry1.retryState?.attempt).toBe(1);
        expect(retry1.statusAnnouncement.message).toMatch(/attempt 1 of 3/i);
        expect(() => assertAsyncStatusInvariants(retry1)).not.toThrow();

        // Attempt 2
        const retry2 = transitionAsyncStatus(retry1, "retrying", { attempt: 2 });
        expect(retry2.retryState?.attempt).toBe(2);

        // Attempt 3: Exhausted limit
        const exhausted = transitionAsyncStatus(retry2, "failed", { attempt: 3 });
        expect(exhausted.statusAnnouncement.politeness).toBe("assertive");
        expect(exhausted.statusAnnouncement.message).toMatch(/Maximum retry attempts reached/i);
      });
    });

    describe("Authorization Path (Session Expiry & Re-Authentication)", () => {
      it("captures unauthorized phase, targets auth modal, and preserves returnFocusTarget", () => {
        const contract = buildAsyncStatusAccessibilityContract({
          operationId: "test-auth-op",
          operationLabel: "SEP-10 Rebalance",
          authRequired: true,
          authScope: "portfolio:write",
        });

        const unauthorized = transitionAsyncStatus(contract, "unauthorized", {
          authRequired: true,
          authScope: "portfolio:write",
        });

        expect(unauthorized.currentPhase).toBe("unauthorized");
        expect(unauthorized.statusAnnouncement.politeness).toBe("assertive");
        expect(unauthorized.statusAnnouncement.interrupt).toBe(true);
        expect(unauthorized.statusAnnouncement.message).toMatch(/Session authorization expired/i);
        expect(unauthorized.authorizationState?.authRequired).toBe(true);
        expect(unauthorized.authorizationState?.reauthShortcut).toBe("Alt+A");
        expect(unauthorized.focusManagement.authFocusTarget).toBe("test-auth-op-auth-modal");
        expect(unauthorized.authorizationState?.returnFocusTargetAfterAuth).toBe("test-auth-op-progress");
        expect(() => assertAsyncStatusInvariants(unauthorized)).not.toThrow();
      });
    });

    describe("Abort & Rollback Path", () => {
      it("aborts pending operation, emits polite cancellation announcement, and directs focus to abort target", () => {
        const contract = buildAsyncStatusAccessibilityContract({
          operationId: "test-abort-op",
          operationLabel: "DeFi Position Unwind",
          rollbackOnAbort: true,
          rollbackActionPrompt: "Restore prior position state",
        });

        const submitting = transitionAsyncStatus(contract, "submitting");
        const aborted = transitionAsyncStatus(submitting, "aborted");

        expect(aborted.currentPhase).toBe("aborted");
        expect(aborted.progressPercentage).toBe(0);
        expect(aborted.statusAnnouncement.politeness).toBe("polite");
        expect(aborted.statusAnnouncement.message).toMatch(/was aborted\. Reverting pending changes/i);
        expect(aborted.focusManagement.abortFocusTarget).toBe("test-abort-op-trigger");
        expect(aborted.rollbackOnAbort).toBe(true);
      });
    });

    describe("Async Status Invariant Assertions", () => {
      it("throws when operationId or operationLabel is empty", () => {
        const invalid = buildAsyncStatusAccessibilityContract({
          operationId: "",
          operationLabel: "",
        });
        expect(() => assertAsyncStatusInvariants(invalid)).toThrow(/operationId and operationLabel must not be empty/i);
      });

      it("throws when abortShortcut is not defined in shortcuts map", () => {
        const contract = buildAsyncStatusAccessibilityContract({
          operationId: "op-1",
          operationLabel: "Valid Operation",
        });
        (contract.keyboardControls as any).shortcuts = {};
        expect(() => assertAsyncStatusInvariants(contract)).toThrow(/abortShortcut must be declared/i);
      });

      it("throws when failed state has non-assertive ARIA politeness", () => {
        const contract = buildAsyncStatusAccessibilityContract({
          operationId: "op-1",
          operationLabel: "Valid Operation",
          initialPhase: "failed",
        });
        contract.statusAnnouncement.politeness = "polite";
        expect(() => assertAsyncStatusInvariants(contract)).toThrow(/failure and timeout states must have assertive ARIA politeness/i);
      });

      it("throws when unauthorized phase has authRequired === false", () => {
        const contract = buildAsyncStatusAccessibilityContract({
          operationId: "op-1",
          operationLabel: "Valid Operation",
          initialPhase: "unauthorized",
        });
        contract.authorizationState!.authRequired = false;
        expect(() => assertAsyncStatusInvariants(contract)).toThrow(/authorizationState\.authRequired must be true/i);
      });

      it("throws when retrying phase has attempt < 1", () => {
        const contract = buildAsyncStatusAccessibilityContract({
          operationId: "op-1",
          operationLabel: "Valid Operation",
          initialPhase: "retrying",
        });
        contract.retryState!.attempt = 0;
        expect(() => assertAsyncStatusInvariants(contract)).toThrow(/retryState\.attempt must be at least 1/i);
      });
    });
  });
});


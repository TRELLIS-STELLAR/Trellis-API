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
});

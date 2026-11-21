import {
  buildAsyncErrorRecoveryContract,
  transitionToSubmitting,
  transitionToPolling,
  transitionToSucceeded,
  transitionToFailure,
  transitionToRetry,
  transitionToUnauthorized,
  transitionToTimeout,
  transitionToAborted,
  resolveRecovery,
} from "./async-error-recovery.contract";
import { assertAsyncStatusInvariants } from "./accessibility.contract";

describe("Accessibility Coverage for Async Error Recovery", () => {
  const baseOptions = {
    operationId: "op-defi-swap",
    operationLabel: "Soroban DeFi Token Swap",
    maxAttempts: 3,
    authRequired: true,
    authScope: "trade:execute",
    rollbackOnAbort: true,
    pendingFocusTarget: "swap-progress-spinner",
    completionFocusTarget: "swap-success-summary",
    failureFocusTarget: "swap-error-alert",
    authFocusTarget: "auth-modal-dialog",
    abortFocusTarget: "swap-cancel-button",
  };

  describe("Normal Path", () => {
    it("transitions smoothly from idle -> submitting -> polling -> succeeded with polite announcements and correct focus", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions);
      expect(contract.asyncStatus.currentPhase).toBe("idle");
      expect(contract.activeFocusTarget).toBe("swap-progress-spinner");

      // 1. Submitting
      contract = transitionToSubmitting(contract);
      expect(contract.asyncStatus.currentPhase).toBe("submitting");
      expect(contract.lastAnnouncement.politeness).toBe("polite");
      expect(contract.activeFocusTarget).toBe("swap-progress-spinner");

      // 2. Polling progress
      contract = transitionToPolling(contract, 65);
      expect(contract.asyncStatus.currentPhase).toBe("polling");
      expect(contract.asyncStatus.progressPercentage).toBe(65);
      expect(contract.lastAnnouncement.politeness).toBe("polite");

      // 3. Succeeded
      contract = transitionToSucceeded(contract);
      expect(contract.asyncStatus.currentPhase).toBe("succeeded");
      expect(contract.asyncStatus.progressPercentage).toBe(100);
      expect(contract.lastAnnouncement.politeness).toBe("polite");
      expect(contract.lastAnnouncement.message).toContain("completed successfully");
      expect(contract.activeFocusTarget).toBe("swap-success-summary");
      expect(contract.errorRecovery).toBeUndefined();
    });
  });

  describe("Failure Path", () => {
    it("emits an assertive ARIA announcement, directs focus to failureFocusTarget, and populates recovery steps", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions);
      contract = transitionToSubmitting(contract);

      contract = transitionToFailure(contract, {
        errorCode: "SLIPPAGE_EXCEEDED",
        errorTitle: "Price Slippage Limit Exceeded",
        errorMessage: "Observed market execution rate deviates by > 1.5% from expected quote.",
        rollbackSafe: true,
      });

      expect(contract.asyncStatus.currentPhase).toBe("failed");
      expect(contract.lastAnnouncement.politeness).toBe("assertive");
      expect(contract.lastAnnouncement.interrupt).toBe(true);
      expect(contract.lastAnnouncement.message).toContain("Price Slippage Limit Exceeded");
      expect(contract.activeFocusTarget).toBe("swap-error-alert");

      // Error recovery contract inspection
      expect(contract.errorRecovery).toBeDefined();
      expect(contract.errorRecovery?.errorCode).toBe("SLIPPAGE_EXCEEDED");
      expect(contract.errorRecovery?.focusTargetId).toBe("swap-error-alert");
      expect(contract.errorRecovery?.recoverySteps.length).toBeGreaterThanOrEqual(2);
      expect(contract.errorRecovery?.rollbackSafe).toBe(true);
      expect(contract.errorRecovery?.recoverySteps.some((s) => s.actionType === "retry")).toBe(true);
      expect(contract.errorRecovery?.recoverySteps.some((s) => s.actionType === "rollback")).toBe(true);
    });

    it("handles non-rollbackSafe failures without generating rollback action steps", () => {
      let contract = buildAsyncErrorRecoveryContract({ ...baseOptions, rollbackOnAbort: false });
      contract = transitionToFailure(contract, {
        errorCode: "ON_CHAIN_SETTLED_WITH_WARNING",
        errorTitle: "On-Chain Transaction Confirmed",
        errorMessage: "Transaction finalized on ledger; compensation requires manual dispute.",
        rollbackSafe: false,
      });

      expect(contract.errorRecovery?.rollbackSafe).toBe(false);
      expect(contract.errorRecovery?.recoverySteps.some((s) => s.actionType === "rollback")).toBe(false);
    });
  });

  describe("Retry Path", () => {
    it("tracks retry attempts and emits polite progress until max attempts are exhausted", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions);

      // Attempt 1
      contract = transitionToRetry(contract, { attempt: 1 });
      expect(contract.asyncStatus.currentPhase).toBe("retrying");
      expect(contract.asyncStatus.retryState?.attempt).toBe(1);
      expect(contract.lastAnnouncement.politeness).toBe("polite");
      expect(contract.lastAnnouncement.message).toContain("attempt 1 of 3");

      // Attempt 2
      contract = transitionToRetry(contract, { attempt: 2 });
      expect(contract.asyncStatus.retryState?.attempt).toBe(2);

      // Attempt 3 (exhaustion threshold)
      contract = transitionToRetry(contract, { attempt: 3 });
      expect(contract.asyncStatus.currentPhase).toBe("failed");
      expect(contract.lastAnnouncement.politeness).toBe("assertive");
      expect(contract.lastAnnouncement.message).toContain("Maximum Retries Reached");
      expect(contract.errorRecovery?.errorCode).toBe("RETRY_LIMIT_EXHAUSTED");
      expect(contract.activeFocusTarget).toBe("swap-error-alert");
    });
  });

  describe("Authorization Path", () => {
    it("transitions to unauthorized, points focus to auth modal, maps Alt+A shortcut, and preserves return focus", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions);
      contract = transitionToSubmitting(contract);

      contract = transitionToUnauthorized(contract, {
        authScope: "trade:execute",
        returnFocusTargetAfterAuth: "swap-progress-spinner",
      });

      expect(contract.asyncStatus.currentPhase).toBe("unauthorized");
      expect(contract.lastAnnouncement.politeness).toBe("assertive");
      expect(contract.lastAnnouncement.message).toContain("Authentication required");
      expect(contract.activeFocusTarget).toBe("auth-modal-dialog");

      const authState = contract.asyncStatus.authorizationState;
      expect(authState?.authRequired).toBe(true);
      expect(authState?.reauthShortcut).toBe("Alt+A");
      expect(authState?.returnFocusTargetAfterAuth).toBe("swap-progress-spinner");

      // Test recovery after re-auth
      contract = resolveRecovery(contract);
      expect(contract.activeFocusTarget).toBe("swap-progress-spinner");
      expect(contract.lastAnnouncement.politeness).toBe("polite");
      expect(contract.lastAnnouncement.message).toContain("Recovery resolved");
    });
  });

  describe("Timeout, Abort, and Rollback", () => {
    it("transitions to timeout and redirects focus to failure focus target", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions);
      contract = transitionToPolling(contract, 40);

      contract = transitionToTimeout(contract);
      expect(contract.asyncStatus.currentPhase).toBe("timeout");
      expect(contract.lastAnnouncement.politeness).toBe("assertive");
      expect(contract.activeFocusTarget).toBe("swap-error-alert");
    });

    it("aborts safely and directs focus to abortFocusTarget with rollback announcement", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions);
      contract = transitionToSubmitting(contract);

      contract = transitionToAborted(contract);
      expect(contract.asyncStatus.currentPhase).toBe("aborted");
      expect(contract.lastAnnouncement.politeness).toBe("assertive");
      expect(contract.lastAnnouncement.message).toContain("safely rolled back");
      expect(contract.activeFocusTarget).toBe("swap-cancel-button");
    });
  });

  describe("Recovery edge cases from the documented state machine", () => {
    it("clears stale error details when a failed operation is retried (Failed -> Retrying)", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions);
      contract = transitionToFailure(contract, {
        errorCode: "RPC_UNAVAILABLE",
        errorTitle: "RPC Unavailable",
        errorMessage: "Horizon did not respond.",
      });
      expect(contract.errorRecovery).toBeDefined();

      contract = transitionToRetry(contract, { attempt: 1 });
      expect(contract.asyncStatus.currentPhase).toBe("retrying");
      expect(contract.errorRecovery).toBeUndefined();
      expect(contract.activeFocusTarget).toBe("swap-progress-spinner");

      contract = transitionToSucceeded(contract);
      expect(contract.errorRecovery).toBeUndefined();
      expect(contract.activeFocusTarget).toBe("swap-success-summary");
    });

    it("clears the authorization-era error state when re-authentication resumes submission (Unauthorized -> Submitting)", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions);
      contract = transitionToFailure(contract, {
        errorCode: "SESSION_EXPIRED",
        errorTitle: "Session Expired",
        errorMessage: "Token rejected.",
      });
      contract = transitionToUnauthorized(contract);
      contract = resolveRecovery(contract);
      contract = transitionToSubmitting(contract);

      expect(contract.asyncStatus.currentPhase).toBe("submitting");
      expect(contract.errorRecovery).toBeUndefined();
      expect(contract.activeFocusTarget).toBe("swap-progress-spinner");
    });

    it("enables the unauthorized phase even when the contract was built with authRequired=false", () => {
      let contract = buildAsyncErrorRecoveryContract({
        ...baseOptions,
        authRequired: false,
        authScope: undefined,
      });
      expect(contract.asyncStatus.authorizationState?.authRequired).toBe(false);

      contract = transitionToUnauthorized(contract);
      expect(contract.asyncStatus.authorizationState?.authRequired).toBe(true);
      expect(() =>
        assertAsyncStatusInvariants(contract.asyncStatus),
      ).not.toThrow();
    });

    it("falls back to the pending focus target for re-auth return when none is supplied", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions);
      contract = transitionToUnauthorized(contract);
      expect(
        contract.asyncStatus.authorizationState?.returnFocusTargetAfterAuth,
      ).toBe("swap-progress-spinner");
      contract = resolveRecovery(contract, "swap-amount-input");
      expect(contract.activeFocusTarget).toBe("swap-amount-input");
    });

    it("warns that manual compensation may be required when aborting a non-rollback-safe operation", () => {
      let contract = buildAsyncErrorRecoveryContract({
        ...baseOptions,
        rollbackOnAbort: false,
      });
      contract = transitionToSubmitting(contract);
      contract = transitionToAborted(contract);

      expect(contract.isRollbackSafe).toBe(false);
      expect(contract.lastAnnouncement.message).toContain(
        "Manual compensation may be required",
      );
      expect(contract.lastAnnouncement.message).not.toContain(
        "safely rolled back",
      );
      expect(contract.activeFocusTarget).toBe("swap-cancel-button");
    });

    it("keeps retry exhaustion free of rollback steps for a non-rollback-safe operation", () => {
      let contract = buildAsyncErrorRecoveryContract({
        ...baseOptions,
        rollbackOnAbort: false,
      });
      contract = transitionToRetry(contract, { attempt: 3 });

      expect(contract.asyncStatus.currentPhase).toBe("failed");
      expect(contract.errorRecovery?.errorCode).toBe("RETRY_LIMIT_EXHAUSTED");
      expect(contract.errorRecovery?.rollbackSafe).toBe(false);
      expect(
        contract.errorRecovery?.recoverySteps.some(
          (s) => s.actionType === "rollback",
        ),
      ).toBe(false);
    });

    it("honours a per-call maxAttempts override when deciding retry exhaustion", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions); // contract max is 3
      contract = transitionToRetry(contract, { attempt: 2, maxAttempts: 2 });
      expect(contract.asyncStatus.currentPhase).toBe("failed");
      expect(contract.errorRecovery?.errorCode).toBe("RETRY_LIMIT_EXHAUSTED");
    });

    it("derives default focus targets from the operation id when none are given", () => {
      const contract = buildAsyncErrorRecoveryContract({
        operationId: "op-default",
        operationLabel: "Default Targets",
      });
      const failed = transitionToFailure(contract, {
        errorCode: "E",
        errorTitle: "T",
        errorMessage: "M",
      });
      expect(contract.activeFocusTarget).toBe("op-default-progress");
      expect(failed.activeFocusTarget).toBe("op-default-error-alert");
      expect(transitionToUnauthorized(contract).activeFocusTarget).toBe(
        "op-default-auth-modal",
      );
      expect(transitionToAborted(contract).activeFocusTarget).toBe(
        "op-default-trigger",
      );
    });

    it("recovers from a timeout via retry and keeps every phase within the async status invariants", () => {
      let contract = buildAsyncErrorRecoveryContract(baseOptions);
      const check = () => assertAsyncStatusInvariants(contract.asyncStatus);

      contract = transitionToSubmitting(contract);
      check();
      contract = transitionToTimeout(contract);
      check();
      expect(contract.lastAnnouncement.message).toContain("KeyR");
      contract = transitionToRetry(contract, { attempt: 1 });
      check();
      contract = transitionToUnauthorized(contract);
      check();
      contract = transitionToFailure(contract, {
        errorCode: "E",
        errorTitle: "T",
        errorMessage: "M",
      });
      check();
      contract = transitionToAborted(contract);
      check();
    });
  });
});

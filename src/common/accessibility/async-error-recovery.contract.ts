import {
  AriaAnnouncement,
  AsyncStatusAccessibilityContract,
  AsyncStatusPhase,
  ErrorRecoveryAccessibilityContract,
  ErrorRecoveryStep,
} from "./accessibility.types";
import {
  buildAsyncStatusAccessibilityContract,
  transitionAsyncStatus,
} from "./accessibility.contract";

/**
 * Unified accessibility contract for async operations that encounter errors,
 * retries, authorization pauses, and rollback workflows.
 */
export interface AsyncErrorRecoveryContract {
  asyncStatus: AsyncStatusAccessibilityContract;
  errorRecovery?: ErrorRecoveryAccessibilityContract;
  activeFocusTarget: string;
  isRollbackSafe: boolean;
  rollbackActionPrompt?: string;
  lastAnnouncement: AriaAnnouncement;
}

export interface BuildAsyncErrorRecoveryOptions {
  operationId: string;
  operationLabel: string;
  maxAttempts?: number;
  authRequired?: boolean;
  authScope?: string;
  rollbackOnAbort?: boolean;
  rollbackActionPrompt?: string;
  pendingFocusTarget?: string;
  completionFocusTarget?: string;
  failureFocusTarget?: string;
  authFocusTarget?: string;
  abortFocusTarget?: string;
}

export interface ErrorTransitionOptions {
  errorCode: string;
  errorTitle: string;
  errorMessage: string;
  recoverySteps?: ErrorRecoveryStep[];
  rollbackSafe?: boolean;
  rollbackActionPrompt?: string;
  /** False when no retry is possible (e.g. retries exhausted): KeyR is not offered. Defaults to true. */
  retryable?: boolean;
}

export interface RetryTransitionOptions {
  attempt: number;
  maxAttempts?: number;
  backoffMs?: number;
  retryShortcut?: string;
}

export interface AuthTransitionOptions {
  authScope?: string;
  reauthActionPrompt?: string;
  returnFocusTargetAfterAuth?: string;
}

/**
 * Creates an initial AsyncErrorRecoveryContract in 'idle' phase.
 */
export function buildAsyncErrorRecoveryContract(
  options: BuildAsyncErrorRecoveryOptions,
): AsyncErrorRecoveryContract {
  const asyncStatus = buildAsyncStatusAccessibilityContract({
    operationId: options.operationId,
    operationLabel: options.operationLabel,
    maxAttempts: options.maxAttempts ?? 3,
    authRequired: options.authRequired ?? false,
    authScope: options.authScope,
    rollbackOnAbort: options.rollbackOnAbort ?? true,
    rollbackActionPrompt:
      options.rollbackActionPrompt ??
      "Press Escape or select Cancel to abort and undo pending changes.",
    pendingFocusTarget: options.pendingFocusTarget,
    completionFocusTarget: options.completionFocusTarget,
    failureFocusTarget: options.failureFocusTarget,
    authFocusTarget: options.authFocusTarget,
    abortFocusTarget: options.abortFocusTarget,
  });

  return {
    asyncStatus,
    activeFocusTarget: asyncStatus.focusManagement.pendingFocusTarget,
    isRollbackSafe: asyncStatus.rollbackOnAbort,
    rollbackActionPrompt: asyncStatus.rollbackActionPrompt,
    lastAnnouncement: asyncStatus.statusAnnouncement,
  };
}

/**
 * Transitions contract to 'submitting' phase.
 */
export function transitionToSubmitting(
  contract: AsyncErrorRecoveryContract,
  customMessage?: string,
): AsyncErrorRecoveryContract {
  const updatedStatus = transitionAsyncStatus(contract.asyncStatus, "submitting", {
    customMessage,
  });
  return {
    ...contract,
    asyncStatus: updatedStatus,
    errorRecovery: undefined,
    activeFocusTarget: updatedStatus.focusManagement.pendingFocusTarget,
    lastAnnouncement: updatedStatus.statusAnnouncement,
  };
}

/**
 * Transitions contract to 'polling' phase with updated progress.
 */
export function transitionToPolling(
  contract: AsyncErrorRecoveryContract,
  progressPercentage: number,
  customMessage?: string,
): AsyncErrorRecoveryContract {
  const updatedStatus = transitionAsyncStatus(contract.asyncStatus, "polling", {
    progressPercentage,
    customMessage,
  });
  return {
    ...contract,
    asyncStatus: updatedStatus,
    activeFocusTarget: updatedStatus.focusManagement.pendingFocusTarget,
    lastAnnouncement: updatedStatus.statusAnnouncement,
  };
}

/**
 * Transitions contract to 'succeeded' phase with polite announcement and focus shift.
 */
export function transitionToSucceeded(
  contract: AsyncErrorRecoveryContract,
  customMessage?: string,
): AsyncErrorRecoveryContract {
  const updatedStatus = transitionAsyncStatus(contract.asyncStatus, "succeeded", {
    customMessage,
  });
  return {
    ...contract,
    asyncStatus: updatedStatus,
    activeFocusTarget: updatedStatus.focusManagement.completionFocusTarget,
    errorRecovery: undefined,
    lastAnnouncement: updatedStatus.statusAnnouncement,
  };
}

/**
 * Transitions contract to 'failed' phase with assertive ARIA announcement,
 * focus moved to error summary, and actionable recovery steps.
 */
export function transitionToFailure(
  contract: AsyncErrorRecoveryContract,
  options: ErrorTransitionOptions,
): AsyncErrorRecoveryContract {
  const rollbackSafe = options.rollbackSafe ?? contract.isRollbackSafe;
  const retryable = options.retryable ?? true;

  const defaultRecoverySteps: ErrorRecoveryStep[] = [
    {
      step: 1,
      label: "Inspect error details and constraints",
      actionable: true,
      actionTarget: contract.asyncStatus.focusManagement.failureFocusTarget,
      actionType: "review",
    },
  ];

  if (retryable) {
    defaultRecoverySteps.push({
      step: 2,
      label: "Retry operation using keyboard shortcut KeyR",
      actionable: true,
      actionTarget: contract.asyncStatus.focusManagement.failureFocusTarget,
      actionType: "retry",
    });
  }

  if (rollbackSafe) {
    defaultRecoverySteps.push({
      step: defaultRecoverySteps.length + 1,
      label: "Rollback operation and restore previous state",
      actionable: true,
      actionTarget: contract.asyncStatus.focusManagement.abortFocusTarget,
      actionType: "rollback",
    });
  }

  const recoverySteps = options.recoverySteps ?? defaultRecoverySteps;

  const errorRecovery: ErrorRecoveryAccessibilityContract = {
    errorCode: options.errorCode,
    errorTitle: options.errorTitle,
    plainLanguageSummary: options.errorMessage,
    politeness: "assertive",
    announcement: `Error in ${contract.asyncStatus.operationLabel}: ${options.errorTitle}. ${options.errorMessage}. ${
      retryable
        ? "Use KeyR to retry or Escape to abort."
        : "Press Escape to abort."
    }`,
    focusTargetId: contract.asyncStatus.focusManagement.failureFocusTarget,
    recoverySteps,
    rollbackSafe,
    rollbackActionPrompt: options.rollbackActionPrompt ?? contract.rollbackActionPrompt,
  };

  const updatedStatus = transitionAsyncStatus(contract.asyncStatus, "failed", {
    errorMessage: `${options.errorTitle}: ${options.errorMessage}`,
  });

  const lastAnnouncement: AriaAnnouncement = {
    politeness: "assertive",
    message: errorRecovery.announcement,
    interrupt: true,
  };

  return {
    ...contract,
    // The status live region must not keep offering KeyR once retry is impossible.
    asyncStatus: retryable
      ? updatedStatus
      : { ...updatedStatus, statusAnnouncement: lastAnnouncement },
    errorRecovery,
    activeFocusTarget: updatedStatus.focusManagement.failureFocusTarget,
    isRollbackSafe: rollbackSafe,
    rollbackActionPrompt: errorRecovery.rollbackActionPrompt,
    lastAnnouncement,
  };
}

/**
 * Transitions contract to 'retrying' phase.
 * If max attempts are reached, transitions to failure with exhaustion announcement.
 */
export function transitionToRetry(
  contract: AsyncErrorRecoveryContract,
  options: RetryTransitionOptions,
): AsyncErrorRecoveryContract {
  const maxAttempts = options.maxAttempts ?? contract.asyncStatus.retryState?.maxAttempts ?? 3;
  const attempt = options.attempt;

  if (attempt >= maxAttempts) {
    // Retry exhausted: transition to terminal failed with assertive notice
    return transitionToFailure(contract, {
      errorCode: "RETRY_LIMIT_EXHAUSTED",
      errorTitle: "Maximum Retries Reached",
      errorMessage: `Operation '${contract.asyncStatus.operationLabel}' failed after ${attempt} retry attempts. Please review logs or abort.`,
      rollbackSafe: contract.isRollbackSafe,
      retryable: false,
    });
  }

  const updatedStatus = transitionAsyncStatus(contract.asyncStatus, "retrying", {
    attempt,
  });

  return {
    ...contract,
    asyncStatus: updatedStatus,
    errorRecovery: undefined,
    activeFocusTarget: updatedStatus.focusManagement.pendingFocusTarget,
    lastAnnouncement: updatedStatus.statusAnnouncement,
  };
}

/**
 * Transitions contract to 'unauthorized' phase.
 * Directs focus to authFocusTarget and preserves returnFocusTargetAfterAuth.
 */
export function transitionToUnauthorized(
  contract: AsyncErrorRecoveryContract,
  options: AuthTransitionOptions = {},
): AsyncErrorRecoveryContract {
  const updatedStatus = transitionAsyncStatus(contract.asyncStatus, "unauthorized", {
    authRequired: true,
  });

  const authState = updatedStatus.authorizationState;
  const returnTarget =
    options.returnFocusTargetAfterAuth ??
    authState?.returnFocusTargetAfterAuth ??
    contract.asyncStatus.focusManagement.pendingFocusTarget;

  const announcement: AriaAnnouncement = {
    politeness: "assertive",
    message: `Authentication required for ${contract.asyncStatus.operationLabel}. Press Alt+A to authenticate. Focus will return automatically.`,
    interrupt: true,
  };

  return {
    ...contract,
    asyncStatus: {
      ...updatedStatus,
      statusAnnouncement: announcement,
      authorizationState: authState
        ? {
            ...authState,
            returnFocusTargetAfterAuth: returnTarget,
            reauthActionPrompt: options.reauthActionPrompt ?? authState.reauthActionPrompt,
          }
        : undefined,
    },
    activeFocusTarget: updatedStatus.focusManagement.authFocusTarget,
    lastAnnouncement: announcement,
  };
}

/**
 * Transitions contract to 'timeout' phase.
 */
export function transitionToTimeout(
  contract: AsyncErrorRecoveryContract,
  customMessage?: string,
): AsyncErrorRecoveryContract {
  const updatedStatus = transitionAsyncStatus(contract.asyncStatus, "timeout", {
    customMessage,
  });

  return {
    ...contract,
    asyncStatus: updatedStatus,
    activeFocusTarget: updatedStatus.focusManagement.failureFocusTarget,
    lastAnnouncement: updatedStatus.statusAnnouncement,
  };
}

/**
 * Transitions contract to 'aborted' phase and guides focus to abortFocusTarget.
 */
export function transitionToAborted(
  contract: AsyncErrorRecoveryContract,
  customMessage?: string,
): AsyncErrorRecoveryContract {
  const updatedStatus = transitionAsyncStatus(contract.asyncStatus, "aborted", {
    customMessage,
  });

  const announcement: AriaAnnouncement = {
    politeness: "assertive",
    message:
      customMessage ??
      `Operation '${contract.asyncStatus.operationLabel}' was aborted. ${
        contract.isRollbackSafe ? "All changes have been safely rolled back." : "Manual compensation may be required."
      }`,
    interrupt: true,
  };

  return {
    ...contract,
    asyncStatus: {
      ...updatedStatus,
      statusAnnouncement: announcement,
    },
    activeFocusTarget: updatedStatus.focusManagement.abortFocusTarget,
    lastAnnouncement: announcement,
  };
}

/**
 * Resolves error recovery and returns focus back to normal pending or return target.
 */
export function resolveRecovery(
  contract: AsyncErrorRecoveryContract,
  returnTarget?: string,
): AsyncErrorRecoveryContract {
  const target =
    returnTarget ??
    contract.asyncStatus.authorizationState?.returnFocusTargetAfterAuth ??
    contract.asyncStatus.focusManagement.pendingFocusTarget;

  const announcement: AriaAnnouncement = {
    politeness: "polite",
    message: `Recovery resolved. Resuming ${contract.asyncStatus.operationLabel}.`,
  };

  return {
    ...contract,
    errorRecovery: undefined,
    activeFocusTarget: target,
    lastAnnouncement: announcement,
  };
}

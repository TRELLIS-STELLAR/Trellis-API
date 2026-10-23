import type {
  AccessibilityWorkflowEnvelope,
  AccessibleTableContract,
  AriaAnnouncement,
  DenseFormAccessibilityContract,
  ErrorRecoveryAccessibilityContract,
  ReducedMotionPreference,
  AsyncStatusPhase,
  AsyncStatusRetryState,
  AsyncStatusAuthorizationState,
  AsyncStatusFocusManagement,
  AsyncStatusKeyboardControls,
  AsyncStatusAccessibilityContract,
} from "./accessibility.types";

/**
 * Pure generator and assertion functions for accessibility regression coverage.
 * Ensures consistent keyboard, focus order, screen-reader, reduced-motion, and error-announcement
 * semantics across core workflows (Auth, Portfolio, DeFi Adapters, Notifications, Observability).
 */

export function buildReducedMotionProfile(preference?: string | null): {
  requestedPreference: ReducedMotionPreference;
  skipAnimations: boolean;
  transitionDurationMs: number;
} {
  const isReduced = preference === "reduce" || preference === "1" || preference === "true";
  return {
    requestedPreference: isReduced ? "reduce" : "no-preference",
    skipAnimations: isReduced,
    transitionDurationMs: isReduced ? 0 : 250,
  };
}

export function buildFormAccessibilityContract(params: {
  formId: string;
  formLabel: string;
  fields: Array<{
    field: string;
    label: string;
    required?: boolean;
    inputMode?: any;
    helpText?: string;
    keyboardShortcut?: string;
  }>;
  initialFocusField?: string;
  submitShortcut?: string;
}): DenseFormAccessibilityContract {
  const fields = params.fields.map((f) => ({
    field: f.field,
    label: f.label,
    required: f.required ?? true,
    inputMode: f.inputMode ?? "text",
    helpText: f.helpText ?? `Enter ${f.label.toLowerCase()}`,
    keyboardShortcut: f.keyboardShortcut,
    errorAnnouncement: `${f.label} is invalid or required.`,
  }));

  const focusOrder = fields.map((f) => f.field);
  const initialFocusField = params.initialFocusField || focusOrder[0];

  const shortcuts: Record<string, string> = {
    "Enter": "Submit form",
    "Escape": "Cancel or reset form",
  };
  if (params.submitShortcut) {
    shortcuts[params.submitShortcut] = "Submit form";
  }
  for (const f of fields) {
    if (f.keyboardShortcut) {
      shortcuts[f.keyboardShortcut] = `Focus ${f.label}`;
    }
  }

  return {
    formId: params.formId,
    formLabel: params.formLabel,
    fields,
    focusOrder,
    initialFocusField,
    keyboardShortcuts: shortcuts,
    submissionAnnouncement: {
      politeness: "polite",
      message: `Submitting ${params.formLabel}. Please wait.`,
    },
    errorSummaryAnnouncement: {
      politeness: "assertive",
      message: `The ${params.formLabel} contains validation errors. Please review highlighted fields.`,
      interrupt: true,
    },
  };
}

export function buildTableAccessibilityContract(params: {
  tableId: string;
  caption: string;
  summary: string;
  columns: Array<{
    key: string;
    header: string;
    sortable?: boolean;
    align?: "left" | "center" | "right";
  }>;
  rowCount: number;
  primaryKeyColumn: string;
  initialSortColumn?: string;
}): AccessibleTableContract {
  return {
    tableId: params.tableId,
    caption: params.caption,
    summary: params.summary,
    rowCount: params.rowCount,
    columns: params.columns.map((c) => ({
      key: c.key,
      header: c.header,
      sortable: c.sortable ?? false,
      align: c.align ?? "left",
    })),
    primaryKeyColumn: params.primaryKeyColumn,
    initialSort: params.initialSortColumn
      ? { column: params.initialSortColumn, direction: "asc" }
      : undefined,
    navigationKeys: {
      nextRow: "ArrowDown",
      prevRow: "ArrowUp",
      nextCell: "ArrowRight",
      prevCell: "ArrowLeft",
      firstCell: "Home",
      lastCell: "End",
    },
    livePaginationAnnouncement: `Showing ${params.rowCount} rows for ${params.caption}. Use arrow keys to navigate table cells.`,
  };
}

export function buildErrorRecoveryContract(params: {
  errorCode: string;
  errorTitle: string;
  plainLanguageSummary: string;
  focusTargetId?: string;
  recoverySteps?: Array<{
    step: number;
    label: string;
    actionable?: boolean;
    actionTarget?: string;
    actionType?: "retry" | "rollback" | "review" | "contact_support" | "reauth";
  }>;
  rollbackSafe?: boolean;
  rollbackActionPrompt?: string;
}): ErrorRecoveryAccessibilityContract {
  const defaultSteps = [
    {
      step: 1,
      label: "Review the input parameters for mistakes or missing credentials.",
      actionable: true,
      actionType: "review" as const,
    },
    {
      step: 2,
      label: "Retry the request or action.",
      actionable: true,
      actionType: "retry" as const,
    },
  ];

  return {
    errorCode: params.errorCode,
    errorTitle: params.errorTitle,
    plainLanguageSummary: params.plainLanguageSummary,
    politeness: "assertive",
    announcement: `Error: ${params.errorTitle}. ${params.plainLanguageSummary}`,
    focusTargetId: params.focusTargetId || "error-recovery-heading",
    recoverySteps: (params.recoverySteps || defaultSteps).map((s) => ({
      ...s,
      actionable: s.actionable ?? true,
    })),
    rollbackSafe: params.rollbackSafe ?? false,
    rollbackActionPrompt: params.rollbackActionPrompt,
  };
}

export function buildWorkflowAccessibilityEnvelope(params: {
  workflow: string;
  screenReaderSummary: string;
  reducedMotionHeader?: string | null;
  focusOrder: string[];
  initialFocusTarget?: string;
  returnFocusTarget?: string;
  announcements?: {
    initial?: string;
    success?: string;
    error?: string;
  };
}): AccessibilityWorkflowEnvelope {
  const reducedMotion = buildReducedMotionProfile(params.reducedMotionHeader);
  const initialFocus = params.initialFocusTarget || params.focusOrder[0];

  return {
    workflow: params.workflow,
    screenReaderSummary: params.screenReaderSummary,
    reducedMotion,
    focusManagement: {
      trapFocus: true,
      initialFocusTarget: initialFocus,
      returnFocusTarget: params.returnFocusTarget,
      focusOrder: params.focusOrder,
    },
    keyboardNavigation: {
      escapeDismisses: true,
      enterSubmits: true,
      arrowKeyNavigation: true,
      keyMap: {
        "Escape": "Close or cancel workflow",
        "Enter": "Confirm or advance step",
        "Tab": "Move to next interactive field",
        "Shift+Tab": "Move to previous interactive field",
      },
    },
    announcements: {
      initial: {
        politeness: "polite",
        message: params.announcements?.initial || `Started ${params.workflow}.`,
      },
      success: {
        politeness: "polite",
        message: params.announcements?.success || `Successfully completed ${params.workflow}.`,
      },
      error: {
        politeness: "assertive",
        message: params.announcements?.error || `Failed executing ${params.workflow}. Review recovery steps.`,
        interrupt: true,
      },
    },
  };
}

/**
 * Invariants checker enforcing accessibility guarantees.
 * Throws explicit descriptive errors on regressions.
 */
export function assertAccessibilityInvariants(envelope: AccessibilityWorkflowEnvelope): void {
  if (!envelope.workflow || !envelope.screenReaderSummary) {
    throw new Error("Accessibility contract invariant violation: Workflow name and screenReaderSummary must be provided.");
  }

  // Focus invariants
  if (!envelope.focusManagement.focusOrder || envelope.focusManagement.focusOrder.length === 0) {
    throw new Error(`Accessibility invariant violation for '${envelope.workflow}': focusOrder cannot be empty.`);
  }

  if (!envelope.focusManagement.focusOrder.includes(envelope.focusManagement.initialFocusTarget)) {
    throw new Error(
      `Accessibility invariant violation for '${envelope.workflow}': initialFocusTarget '${envelope.focusManagement.initialFocusTarget}' must be in focusOrder.`,
    );
  }

  // Reduced motion invariant
  if (envelope.reducedMotion.skipAnimations && envelope.reducedMotion.transitionDurationMs !== 0) {
    throw new Error(
      `Accessibility invariant violation for '${envelope.workflow}': When skipAnimations is true, transitionDurationMs must be 0.`,
    );
  }

  // Screen reader / ARIA live announcement invariants
  if (!envelope.announcements.error.message || envelope.announcements.error.politeness !== "assertive") {
    throw new Error(
      `Accessibility invariant violation for '${envelope.workflow}': Error announcements must have politeness='assertive' for immediate screen-reader feedback.`,
    );
  }

  // Keyboard navigation invariant
  if (!envelope.keyboardNavigation.keyMap["Escape"] || !envelope.keyboardNavigation.keyMap["Enter"]) {
    throw new Error(
      `Accessibility invariant violation for '${envelope.workflow}': Key map must provide Escape and Enter handlers.`,
    );
  }
}

/**
 * Builds an accessible async status contract covering keyboard navigation, focus management,
 * ARIA live region announcements, retry mechanics, and authorization states.
 */
export function buildAsyncStatusAccessibilityContract(params: {
  operationId: string;
  operationLabel: string;
  initialPhase?: AsyncStatusPhase;
  pendingFocusTarget?: string;
  completionFocusTarget?: string;
  failureFocusTarget?: string;
  authFocusTarget?: string;
  abortFocusTarget?: string;
  containFocusWhilePending?: boolean;
  abortShortcut?: string;
  retryShortcut?: string;
  reauthShortcut?: string;
  customShortcuts?: Record<string, string>;
  maxAttempts?: number;
  backoffMs?: number;
  retryable?: boolean;
  authRequired?: boolean;
  authScope?: string;
  rollbackOnAbort?: boolean;
  rollbackActionPrompt?: string;
}): AsyncStatusAccessibilityContract {
  const currentPhase = params.initialPhase ?? "idle";
  const abortShortcut = params.abortShortcut ?? "Escape";
  const retryShortcut = params.retryShortcut ?? "KeyR";
  const reauthShortcut = params.reauthShortcut ?? "Alt+A";

  const shortcuts: Record<string, string> = {
    [abortShortcut]: `Cancel or abort ${params.operationLabel}`,
    [retryShortcut]: `Retry ${params.operationLabel}`,
    [reauthShortcut]: `Re-authenticate session`,
    ...(params.customShortcuts || {}),
  };

  const focusManagement: AsyncStatusFocusManagement = {
    containFocusWhilePending: params.containFocusWhilePending ?? true,
    pendingFocusTarget: params.pendingFocusTarget ?? `${params.operationId}-progress`,
    completionFocusTarget: params.completionFocusTarget ?? `${params.operationId}-success-summary`,
    failureFocusTarget: params.failureFocusTarget ?? `${params.operationId}-error-alert`,
    authFocusTarget: params.authFocusTarget ?? `${params.operationId}-auth-modal`,
    abortFocusTarget: params.abortFocusTarget ?? `${params.operationId}-trigger`,
  };

  const keyboardControls: AsyncStatusKeyboardControls = {
    abortShortcut,
    retryShortcut,
    reauthShortcut,
    shortcuts,
  };

  let statusAnnouncement: AriaAnnouncement;
  switch (currentPhase) {
    case "submitting":
      statusAnnouncement = {
        politeness: "polite",
        message: `Submitting ${params.operationLabel}. Please wait.`,
      };
      break;
    case "polling":
      statusAnnouncement = {
        politeness: "polite",
        message: `Processing ${params.operationLabel} in background. Checking status.`,
      };
      break;
    case "retrying":
      statusAnnouncement = {
        politeness: "polite",
        message: `Retrying ${params.operationLabel} (attempt 1).`,
      };
      break;
    case "succeeded":
      statusAnnouncement = {
        politeness: "polite",
        message: `${params.operationLabel} completed successfully.`,
      };
      break;
    case "failed":
      statusAnnouncement = {
        politeness: "assertive",
        message: `${params.operationLabel} failed. Press ${retryShortcut} to retry or ${abortShortcut} to cancel.`,
        interrupt: true,
      };
      break;
    case "timeout":
      statusAnnouncement = {
        politeness: "assertive",
        message: `${params.operationLabel} timed out. Press ${retryShortcut} to retry.`,
        interrupt: true,
      };
      break;
    case "unauthorized":
      statusAnnouncement = {
        politeness: "assertive",
        message: `Session authorization required for ${params.operationLabel}. Press ${reauthShortcut} to authenticate.`,
        interrupt: true,
      };
      break;
    case "aborted":
      statusAnnouncement = {
        politeness: "polite",
        message: `${params.operationLabel} was cancelled.`,
      };
      break;
    case "idle":
    default:
      statusAnnouncement = {
        politeness: "off",
        message: `${params.operationLabel} is ready.`,
      };
      break;
  }

  const retryState: AsyncStatusRetryState = {
    attempt: 0,
    maxAttempts: params.maxAttempts ?? 3,
    backoffMs: params.backoffMs ?? 1000,
    retryable: params.retryable ?? true,
    retryShortcut,
    exhaustedAnnouncement: {
      politeness: "assertive",
      message: `Maximum retry attempts reached for ${params.operationLabel}. Please check system status or contact support.`,
      interrupt: true,
    },
  };

  const authorizationState: AsyncStatusAuthorizationState = {
    authRequired: params.authRequired ?? false,
    authScope: params.authScope,
    reauthShortcut,
    reauthActionPrompt: `Re-authenticate via ${reauthShortcut} to continue ${params.operationLabel}`,
    returnFocusTargetAfterAuth: focusManagement.pendingFocusTarget,
  };

  return {
    operationId: params.operationId,
    operationLabel: params.operationLabel,
    currentPhase,
    statusAnnouncement,
    progressPercentage:
      currentPhase === "succeeded" ? 100 : currentPhase === "submitting" ? 10 : 0,
    keyboardControls,
    focusManagement,
    retryState,
    authorizationState,
    rollbackOnAbort: params.rollbackOnAbort ?? false,
    rollbackActionPrompt: params.rollbackActionPrompt,
  };
}

/**
 * Transitions an accessible async status contract to a new phase, producing updated
 * screen reader announcements, retry metrics, and focus targets.
 */
export function transitionAsyncStatus(
  contract: AsyncStatusAccessibilityContract,
  nextPhase: AsyncStatusPhase,
  options?: {
    errorMessage?: string;
    progressPercentage?: number;
    attempt?: number;
    retryCountdownSeconds?: number;
    authRequired?: boolean;
    authScope?: string;
  },
): AsyncStatusAccessibilityContract {
  const updatedRetry: AsyncStatusRetryState | undefined = contract.retryState
    ? {
        ...contract.retryState,
        attempt: options?.attempt ?? (nextPhase === "retrying" ? contract.retryState.attempt + 1 : contract.retryState.attempt),
        retryCountdownSeconds: options?.retryCountdownSeconds,
      }
    : undefined;

  let announcement: AriaAnnouncement;
  let progress = options?.progressPercentage ?? contract.progressPercentage ?? 0;

  switch (nextPhase) {
    case "submitting":
      announcement = {
        politeness: "polite",
        message: `Submitting ${contract.operationLabel}. Please wait.`,
      };
      progress = options?.progressPercentage ?? 15;
      break;
    case "polling":
      announcement = {
        politeness: "polite",
        message: `Processing ${contract.operationLabel} (${progress}% complete).`,
      };
      break;
    case "retrying": {
      const currentAttempt = updatedRetry?.attempt ?? 1;
      const maxAttempts = updatedRetry?.maxAttempts ?? 3;
      announcement = {
        politeness: "polite",
        message: `Retrying ${contract.operationLabel}: attempt ${currentAttempt} of ${maxAttempts}...`,
      };
      break;
    }
    case "succeeded":
      announcement = {
        politeness: "polite",
        message: `${contract.operationLabel} completed successfully.`,
      };
      progress = 100;
      break;
    case "failed": {
      const isExhausted =
        updatedRetry && updatedRetry.attempt >= updatedRetry.maxAttempts;
      const errorMsg = options?.errorMessage ? `: ${options.errorMessage}` : "";
      announcement = isExhausted && updatedRetry?.exhaustedAnnouncement
        ? updatedRetry.exhaustedAnnouncement
        : {
            politeness: "assertive",
            message: `${contract.operationLabel} failed${errorMsg}. Press ${contract.keyboardControls.retryShortcut} to retry or ${contract.keyboardControls.abortShortcut} to cancel.`,
            interrupt: true,
          };
      break;
    }
    case "timeout":
      announcement = {
        politeness: "assertive",
        message: `${contract.operationLabel} timed out. Press ${contract.keyboardControls.retryShortcut} to retry.`,
        interrupt: true,
      };
      break;
    case "unauthorized":
      announcement = {
        politeness: "assertive",
        message: `Session authorization expired for ${contract.operationLabel}. Press ${contract.keyboardControls.reauthShortcut} to re-authenticate.`,
        interrupt: true,
      };
      break;
    case "aborted":
      announcement = {
        politeness: "polite",
        message: `${contract.operationLabel} was aborted. Reverting pending changes.`,
      };
      progress = 0;
      break;
    case "idle":
    default:
      announcement = {
        politeness: "off",
        message: `${contract.operationLabel} is idle.`,
      };
      progress = 0;
      break;
  }

  const updatedAuth: AsyncStatusAuthorizationState | undefined = contract.authorizationState
    ? {
        ...contract.authorizationState,
        authRequired: options?.authRequired ?? (nextPhase === "unauthorized" ? true : contract.authorizationState.authRequired),
        authScope: options?.authScope ?? contract.authorizationState.authScope,
      }
    : undefined;

  return {
    ...contract,
    currentPhase: nextPhase,
    statusAnnouncement: announcement,
    progressPercentage: progress,
    retryState: updatedRetry,
    authorizationState: updatedAuth,
  };
}

/**
 * Asserts accessibility invariants on an async status contract.
 */
export function assertAsyncStatusInvariants(
  contract: AsyncStatusAccessibilityContract,
): void {
  if (!contract.operationId || !contract.operationLabel) {
    throw new Error(
      "Accessibility invariant violation: operationId and operationLabel must not be empty.",
    );
  }

  // Keyboard navigation shortcuts
  if (!contract.keyboardControls.abortShortcut || !contract.keyboardControls.shortcuts[contract.keyboardControls.abortShortcut]) {
    throw new Error(
      `Accessibility invariant violation for '${contract.operationLabel}': abortShortcut must be declared in shortcuts map.`,
    );
  }

  // Focus targets
  if (!contract.focusManagement.pendingFocusTarget) {
    throw new Error(
      `Accessibility invariant violation for '${contract.operationLabel}': pendingFocusTarget must be specified.`,
    );
  }

  if (contract.currentPhase === "failed" || contract.currentPhase === "timeout") {
    if (contract.statusAnnouncement.politeness !== "assertive") {
      throw new Error(
        `Accessibility invariant violation for '${contract.operationLabel}': failure and timeout states must have assertive ARIA politeness.`,
      );
    }
    if (!contract.focusManagement.failureFocusTarget) {
      throw new Error(
        `Accessibility invariant violation for '${contract.operationLabel}': failureFocusTarget must be defined.`,
      );
    }
  }

  if (contract.currentPhase === "unauthorized") {
    if (contract.statusAnnouncement.politeness !== "assertive") {
      throw new Error(
        `Accessibility invariant violation for '${contract.operationLabel}': unauthorized state must have assertive ARIA politeness.`,
      );
    }
    if (!contract.authorizationState || !contract.authorizationState.authRequired) {
      throw new Error(
        `Accessibility invariant violation for '${contract.operationLabel}': authorizationState.authRequired must be true when in unauthorized phase.`,
      );
    }
    if (!contract.focusManagement.authFocusTarget) {
      throw new Error(
        `Accessibility invariant violation for '${contract.operationLabel}': authFocusTarget must be defined.`,
      );
    }
  }

  if (contract.currentPhase === "retrying") {
    if (!contract.retryState) {
      throw new Error(
        `Accessibility invariant violation for '${contract.operationLabel}': retryState must be defined when retrying.`,
      );
    }
    if (contract.retryState.attempt < 1) {
      throw new Error(
        `Accessibility invariant violation for '${contract.operationLabel}': retryState.attempt must be at least 1 when retrying.`,
      );
    }
  }
}


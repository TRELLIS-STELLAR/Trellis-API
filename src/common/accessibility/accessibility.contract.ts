import type {
  AccessibilityWorkflowEnvelope,
  AccessibleTableContract,
  AriaAnnouncement,
  DenseFormAccessibilityContract,
  ErrorRecoveryAccessibilityContract,
  ReducedMotionPreference,
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

/**
 * Accessibility Core Contracts & Types for Trellis API.
 *
 * Provides standardized models for client presentation envelopes,
 * dense forms, tabular data grids, error recovery flows, reduced-motion preferences,
 * and ARIA announcement behaviors across web, mobile, CLI, and assistive technologies.
 */

export type ReducedMotionPreference = 'reduce' | 'no-preference';

export type AriaLivePoliteness = 'off' | 'polite' | 'assertive';

export type InputMode = 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url';

export interface AriaAnnouncement {
  /** ARIA live politeness level */
  politeness: AriaLivePoliteness;
  /** Message to be announced to assistive tech */
  message: string;
  /** Optional delay in ms before triggering live region announce */
  delayMs?: number;
  /** Whether this announcement interrupts previous queued announcements */
  interrupt?: boolean;
}

export interface FocusOrderElement {
  /** Target field or control ID */
  targetId: string;
  /** Logical order index (1-based) */
  order: number;
  /** Explanatory label or accessibility landmark name */
  name: string;
  /** Whether element is autofocus candidate upon error/initiation */
  isInitialFocus?: boolean;
}

export interface DenseFormFieldMetadata {
  /** Stable field identifier matching DTO / form key */
  field: string;
  /** Screen reader friendly label */
  label: string;
  /** Keyboard shortcut or access key if applicable */
  keyboardShortcut?: string;
  /** Input mode hint for virtual keyboards (e.g., 'decimal' for crypto amounts) */
  inputMode?: InputMode;
  /** Autocomplete attribute for dense form efficiency */
  autoComplete?: string;
  /** Whether the field is required */
  required: boolean;
  /** Accessibility hint / description / help text */
  helpText?: string;
  /** Error announcement text when field has constraint violation */
  errorAnnouncement?: string;
}

export interface DenseFormAccessibilityContract {
  formId: string;
  formLabel: string;
  fields: DenseFormFieldMetadata[];
  focusOrder: string[];
  initialFocusField?: string;
  keyboardShortcuts: Record<string, string>;
  submissionAnnouncement: AriaAnnouncement;
  errorSummaryAnnouncement: AriaAnnouncement;
}

export interface AccessibleTableColumn {
  key: string;
  header: string;
  description?: string;
  sortable: boolean;
  align?: 'left' | 'center' | 'right';
  priority?: 'high' | 'medium' | 'low';
}

export interface AccessibleTableContract {
  tableId: string;
  caption: string;
  summary: string;
  rowCount: number;
  columns: AccessibleTableColumn[];
  primaryKeyColumn: string;
  initialSort?: {
    column: string;
    direction: 'asc' | 'desc';
  };
  navigationKeys: {
    nextRow: string;
    prevRow: string;
    nextCell: string;
    prevCell: string;
    firstCell: string;
    lastCell: string;
  };
  livePaginationAnnouncement: string;
}

export interface ErrorRecoveryStep {
  step: number;
  label: string;
  actionable: boolean;
  actionTarget?: string;
  actionType?: 'retry' | 'rollback' | 'review' | 'contact_support' | 'reauth';
}

export interface ErrorRecoveryAccessibilityContract {
  errorCode: string;
  errorTitle: string;
  plainLanguageSummary: string;
  politeness: AriaLivePoliteness;
  announcement: string;
  focusTargetId: string;
  recoverySteps: ErrorRecoveryStep[];
  rollbackSafe: boolean;
  rollbackActionPrompt?: string;
}

export interface AccessibilityWorkflowEnvelope {
  workflow: string;
  screenReaderSummary: string;
  reducedMotion: {
    requestedPreference: ReducedMotionPreference;
    skipAnimations: boolean;
    transitionDurationMs: number;
  };
  focusManagement: {
    trapFocus: boolean;
    initialFocusTarget: string;
    returnFocusTarget?: string;
    focusOrder: string[];
  };
  keyboardNavigation: {
    escapeDismisses: boolean;
    enterSubmits: boolean;
    arrowKeyNavigation: boolean;
    keyMap: Record<string, string>;
  };
  announcements: {
    initial: AriaAnnouncement;
    success: AriaAnnouncement;
    error: AriaAnnouncement;
  };
}

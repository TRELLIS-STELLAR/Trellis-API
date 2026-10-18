import type {
  DenseFormAccessibilityContract,
  AccessibleTableContract,
  ErrorRecoveryAccessibilityContract,
  AccessibilityWorkflowEnvelope,
} from "./accessibility.types";
import {
  buildFormAccessibilityContract,
  buildTableAccessibilityContract,
  buildErrorRecoveryContract,
  buildWorkflowAccessibilityEnvelope,
  assertAccessibilityInvariants,
} from "./accessibility.contract.ts";

/**
 * Registry of core accessible workflow definitions for regression testing and client envelopes.
 * Covers:
 * 1. Auth: Dense login / SEP-10 wallet challenge form & MFA error recovery
 * 2. Portfolio: Asset allocation rebalancing dense form, portfolio holdings data table & rebalance failure recovery
 * 3. DeFi Adapters: Liquidity provision / borrow supply dense form, protocol rate comparison table & transaction rollback recovery
 * 4. Notifications: Multi-channel preferences matrix table & delivery failure recovery
 * 5. Observability: System metrics and performance regression data table & incident triage recovery
 */

export interface DomainAccessibilitySuite {
  form: DenseFormAccessibilityContract;
  table: AccessibleTableContract;
  errorRecovery: ErrorRecoveryAccessibilityContract;
  workflow: AccessibilityWorkflowEnvelope;
}

export function getAuthAccessibilitySuite(reducedMotionHeader?: string | null): DomainAccessibilitySuite {
  const form = buildFormAccessibilityContract({
    formId: "auth-wallet-sep10-form",
    formLabel: "Stellar SEP-10 Non-Custodial Wallet Authentication",
    fields: [
      {
        field: "publicKey",
        label: "Stellar Public Address",
        required: true,
        inputMode: "text",
        helpText: "Enter 56-character Stellar public address starting with G",
        keyboardShortcut: "Alt+P",
      },
      {
        field: "clientDomain",
        label: "Client Domain",
        required: false,
        inputMode: "url",
        helpText: "Optional home domain verifying your application",
        keyboardShortcut: "Alt+D",
      },
      {
        field: "signature",
        label: "Cryptographic Challenge Signature",
        required: true,
        inputMode: "text",
        helpText: "Paste Ed25519 signature of the SEP-10 challenge transaction",
        keyboardShortcut: "Alt+S",
      },
    ],
    initialFocusField: "publicKey",
    submitShortcut: "Ctrl+Enter",
  });

  const table = buildTableAccessibilityContract({
    tableId: "auth-active-sessions-table",
    caption: "Active Authorized Sessions and Devices",
    summary: "Lists all current authenticated user sessions, devices, IP addresses, and expiration times.",
    columns: [
      { key: "sessionId", header: "Session ID", sortable: true },
      { key: "device", header: "Device & Browser", sortable: true },
      { key: "ipAddress", header: "IP Address", sortable: false },
      { key: "lastActive", header: "Last Active", sortable: true },
      { key: "expiresAt", header: "Expires At", sortable: true },
    ],
    rowCount: 3,
    primaryKeyColumn: "sessionId",
    initialSortColumn: "lastActive",
  });

  const errorRecovery = buildErrorRecoveryContract({
    errorCode: "AUTH_SEP10_SIGNATURE_INVALID",
    errorTitle: "Invalid Cryptographic Signature",
    plainLanguageSummary: "The challenge signature does not match your Stellar public key or the challenge has expired.",
    focusTargetId: "signature",
    recoverySteps: [
      {
        step: 1,
        label: "Request a fresh SEP-10 challenge transaction via POST /api/v1/auth/challenge.",
        actionable: true,
        actionType: "retry",
      },
      {
        step: 2,
        label: "Verify that your signing wallet holds the private key for the address provided.",
        actionable: true,
        actionType: "review",
      },
      {
        step: 3,
        label: "Ensure your device clock is synchronized to prevent timestamp validation expiration.",
        actionable: true,
        actionType: "review",
      },
    ],
    rollbackSafe: true,
    rollbackActionPrompt: "Reset auth flow to start a new authentication session.",
  });

  const workflow = buildWorkflowAccessibilityEnvelope({
    workflow: "Stellar Wallet Authentication",
    screenReaderSummary: "Two-step SEP-10 authentication flow requiring public key challenge and signed transaction response.",
    reducedMotionHeader,
    focusOrder: ["publicKey", "clientDomain", "signature", "auth-submit-btn", "auth-cancel-btn"],
    initialFocusTarget: "publicKey",
    returnFocusTarget: "auth-trigger-btn",
    announcements: {
      initial: "Stellar authentication dialog opened. Focus is on Stellar Public Address field.",
      success: "Wallet verified successfully. JWT session established.",
      error: "Authentication failed. Focus shifted to signature field with error details.",
    },
  });

  assertAccessibilityInvariants(workflow);

  return { form, table, errorRecovery, workflow };
}

export function getPortfolioAccessibilitySuite(reducedMotionHeader?: string | null): DomainAccessibilitySuite {
  const form = buildFormAccessibilityContract({
    formId: "portfolio-allocation-rebalance-form",
    formLabel: "Portfolio Asset Target Allocations",
    fields: [
      {
        field: "portfolioId",
        label: "Portfolio Identifier",
        required: true,
        inputMode: "text",
        helpText: "UUID of portfolio to rebalance",
      },
      {
        field: "xlmTargetPercent",
        label: "XLM Target Weight (%)",
        required: true,
        inputMode: "decimal",
        helpText: "Desired percentage allocation for Stellar Lumens (0 to 100)",
        keyboardShortcut: "Alt+X",
      },
      {
        field: "usdcTargetPercent",
        label: "USDC Target Weight (%)",
        required: true,
        inputMode: "decimal",
        helpText: "Desired percentage allocation for USD Coin (0 to 100)",
        keyboardShortcut: "Alt+U",
      },
      {
        field: "slippageToleranceBps",
        label: "Slippage Tolerance (BPS)",
        required: true,
        inputMode: "numeric",
        helpText: "Maximum acceptable slippage in basis points (e.g. 50 = 0.5%)",
        keyboardShortcut: "Alt+T",
      },
    ],
    initialFocusField: "xlmTargetPercent",
  });

  const table = buildTableAccessibilityContract({
    tableId: "portfolio-holdings-grid",
    caption: "Portfolio Asset Holdings & Current Valuations",
    summary: "Tabular summary of portfolio asset balances, 7-decimal stroop precision amounts, and deviation from target weights.",
    columns: [
      { key: "assetCode", header: "Asset", sortable: true },
      { key: "balance", header: "Balance", sortable: true, align: "right" },
      { key: "targetWeight", header: "Target %", sortable: true, align: "right" },
      { key: "currentWeight", header: "Current %", sortable: true, align: "right" },
      { key: "driftBps", header: "Drift (BPS)", sortable: true, align: "right" },
    ],
    rowCount: 5,
    primaryKeyColumn: "assetCode",
    initialSortColumn: "driftBps",
  });

  const errorRecovery = buildErrorRecoveryContract({
    errorCode: "PORTFOLIO_CONCENTRATION_LIMIT_EXCEEDED",
    errorTitle: "Target Allocation Exceeds Risk Invariant",
    plainLanguageSummary: "The requested allocation violates platform concentration safety rules (maximum single asset limit 70%).",
    focusTargetId: "xlmTargetPercent",
    recoverySteps: [
      {
        step: 1,
        label: "Adjust target allocations so no single asset exceeds the 70% threshold.",
        actionable: true,
        actionType: "review",
      },
      {
        step: 2,
        label: "Ensure the sum of all asset target allocations exactly equals 100%.",
        actionable: true,
        actionType: "review",
      },
      {
        step: 3,
        label: "Simulate proposed policy changes via POST /api/v1/policy/simulation before committing.",
        actionable: true,
        actionType: "retry",
      },
    ],
    rollbackSafe: true,
    rollbackActionPrompt: "Revert allocations to previous snapshot.",
  });

  const workflow = buildWorkflowAccessibilityEnvelope({
    workflow: "Portfolio Rebalancing",
    screenReaderSummary: "Dense configuration form adjusting multi-asset portfolio weighting and automated rebalance triggers.",
    reducedMotionHeader,
    focusOrder: ["xlmTargetPercent", "usdcTargetPercent", "slippageToleranceBps", "preview-rebalance-btn", "commit-rebalance-btn"],
    initialFocusTarget: "xlmTargetPercent",
    announcements: {
      initial: "Opened Portfolio Rebalancing editor. Review and adjust target allocations.",
      success: "Portfolio rebalance preview calculated with zero drift violations.",
      error: "Rebalance parameters rejected due to concentration risk rule violation.",
    },
  });

  assertAccessibilityInvariants(workflow);

  return { form, table, errorRecovery, workflow };
}

export function getDefiAccessibilitySuite(reducedMotionHeader?: string | null): DomainAccessibilitySuite {
  const form = buildFormAccessibilityContract({
    formId: "defi-adapter-order-form",
    formLabel: "DeFi Protocol Order Execution & Liquidity Supply",
    fields: [
      {
        field: "protocol",
        label: "DeFi Protocol Adapter",
        required: true,
        inputMode: "text",
        helpText: "Select supported protocol (e.g. Blend, Soroswap, Phoenix)",
        keyboardShortcut: "Alt+P",
      },
      {
        field: "assetCode",
        label: "Asset Code",
        required: true,
        inputMode: "text",
        helpText: "1 to 12 alphanumeric characters (e.g. XLM)",
      },
      {
        field: "amount",
        label: "Deposit Amount",
        required: true,
        inputMode: "decimal",
        helpText: "Decimal amount with up to 7 decimal places",
        keyboardShortcut: "Alt+A",
      },
      {
        field: "minHealthFactor",
        label: "Minimum Health Factor",
        required: true,
        inputMode: "decimal",
        helpText: "Safe collateral health factor floor (minimum 1.25)",
      },
    ],
    initialFocusField: "protocol",
  });

  const table = buildTableAccessibilityContract({
    tableId: "defi-positions-table",
    caption: "Open DeFi Protocol Positions & Health Metrics",
    summary: "Lists all deployed collateral, borrow debt, accrued yield APR, and liquidation risk thresholds.",
    columns: [
      { key: "protocol", header: "Protocol", sortable: true },
      { key: "suppliedAsset", header: "Supplied Asset", sortable: true },
      { key: "suppliedAmount", header: "Supplied Amount", sortable: true, align: "right" },
      { key: "borrowedAmount", header: "Borrowed Amount", sortable: true, align: "right" },
      { key: "healthFactor", header: "Health Factor", sortable: true, align: "right" },
    ],
    rowCount: 4,
    primaryKeyColumn: "protocol",
    initialSortColumn: "healthFactor",
  });

  const errorRecovery = buildErrorRecoveryContract({
    errorCode: "DEFI_HEALTH_FACTOR_DEFICIT",
    errorTitle: "Position Health Factor Below Liquidation Threshold",
    plainLanguageSummary: "Requested borrow or unwind operation would cause health factor to drop below the safety limit (1.25).",
    focusTargetId: "amount",
    recoverySteps: [
      {
        step: 1,
        label: "Deposit additional collateral or reduce the requested borrow amount.",
        actionable: true,
        actionType: "review",
      },
      {
        step: 2,
        label: "Trigger an emergency unwind or safe rollback using commitToken verification.",
        actionable: true,
        actionType: "rollback",
      },
    ],
    rollbackSafe: true,
    rollbackActionPrompt: "Execute atomic rollback to preserve initial collateral state.",
  });

  const workflow = buildWorkflowAccessibilityEnvelope({
    workflow: "DeFi Position Management",
    screenReaderSummary: "Executes automated yield aggregation and lending supply with real-time health factor monitoring.",
    reducedMotionHeader,
    focusOrder: ["protocol", "assetCode", "amount", "minHealthFactor", "submit-order-btn"],
    initialFocusTarget: "protocol",
    announcements: {
      initial: "DeFi order interface ready.",
      success: "Transaction submitted to Soroban host environment.",
      error: "Health factor deficit prevented transaction execution. Review recovery steps.",
    },
  });

  assertAccessibilityInvariants(workflow);

  return { form, table, errorRecovery, workflow };
}

export function getNotificationsAccessibilitySuite(reducedMotionHeader?: string | null): DomainAccessibilitySuite {
  const form = buildFormAccessibilityContract({
    formId: "notification-channel-config-form",
    formLabel: "Emergency Alert Notification Channel Preferences",
    fields: [
      {
        field: "channel",
        label: "Delivery Channel",
        required: true,
        inputMode: "text",
        helpText: "Select channel: email, webhook, sms, or in-app",
      },
      {
        field: "destination",
        label: "Destination URI or Endpoint",
        required: true,
        inputMode: "url",
        helpText: "Valid HTTPS webhook endpoint or email address",
      },
      {
        field: "digestWindowMinutes",
        label: "Digest Batch Window (Minutes)",
        required: true,
        inputMode: "numeric",
        helpText: "Batch notification window (0 for instant real-time dispatch)",
      },
    ],
    initialFocusField: "channel",
  });

  const table = buildTableAccessibilityContract({
    tableId: "notification-history-table",
    caption: "Notification Dispatch Audit Log",
    summary: "Time-series log of critical security alerts, rebalance digests, delivery statuses, and retry attempts.",
    columns: [
      { key: "id", header: "Alert ID", sortable: true },
      { key: "category", header: "Category", sortable: true },
      { key: "severity", header: "Severity", sortable: true },
      { key: "recipient", header: "Recipient", sortable: false },
      { key: "status", header: "Status", sortable: true },
      { key: "createdAt", header: "Timestamp", sortable: true },
    ],
    rowCount: 10,
    primaryKeyColumn: "id",
    initialSortColumn: "createdAt",
  });

  const errorRecovery = buildErrorRecoveryContract({
    errorCode: "NOTIFICATION_WEBHOOK_DELIVERY_FAILED",
    errorTitle: "Webhook Endpoint Delivery Failed",
    plainLanguageSummary: "Destination server returned HTTP 503 or failed HMAC signature verification after 3 retries.",
    focusTargetId: "destination",
    recoverySteps: [
      {
        step: 1,
        label: "Inspect webhook receiving endpoint logs and verify secret HMAC token.",
        actionable: true,
        actionType: "review",
      },
      {
        step: 2,
        label: "Trigger manual replay of undelivered notifications from recovery dead-letter queue.",
        actionable: true,
        actionType: "retry",
      },
    ],
    rollbackSafe: false,
    rollbackActionPrompt: "Notifications cannot be revoked once sent, but retry schedule can be paused.",
  });

  const workflow = buildWorkflowAccessibilityEnvelope({
    workflow: "Notification Preferences Setup",
    screenReaderSummary: "Configures real-time security alerts and batching windows for multi-channel dispatch.",
    reducedMotionHeader,
    focusOrder: ["channel", "destination", "digestWindowMinutes", "save-preferences-btn"],
    initialFocusTarget: "channel",
    announcements: {
      initial: "Configuring notification routing preferences.",
      success: "Preferences saved. Test notification dispatched.",
      error: "Webhook destination failed verification. Provide active HTTPS URL.",
    },
  });

  assertAccessibilityInvariants(workflow);

  return { form, table, errorRecovery, workflow };
}

export function getObservabilityAccessibilitySuite(reducedMotionHeader?: string | null): DomainAccessibilitySuite {
  const form = buildFormAccessibilityContract({
    formId: "observability-query-filter-form",
    formLabel: "Telemetry Metrics & Regression Audit Filter",
    fields: [
      {
        field: "route",
        label: "API Route Filter",
        required: false,
        inputMode: "text",
        helpText: "e.g. /api/v1/reconcile or /api/v1/auth",
      },
      {
        field: "regressionThresholdPercent",
        label: "Regression Latency Threshold (%)",
        required: true,
        inputMode: "numeric",
        helpText: "Percentage increase over baseline P95 that triggers alert (default 50%)",
      },
      {
        field: "timeRangeHours",
        label: "Lookback Window (Hours)",
        required: true,
        inputMode: "numeric",
        helpText: "Hours of historical telemetry to analyze (1 to 168)",
      },
    ],
    initialFocusField: "regressionThresholdPercent",
  });

  const table = buildTableAccessibilityContract({
    tableId: "observability-regressions-table",
    caption: "Detected Performance and Accessibility Regressions",
    summary: "Comprehensive register of identified regressions, p95 latency changes, affected routes, and baseline comparisons.",
    columns: [
      { key: "id", header: "Regression ID", sortable: true },
      { key: "route", header: "Route", sortable: true },
      { key: "baselineP95", header: "Baseline P95 (s)", sortable: true, align: "right" },
      { key: "currentP95", header: "Current P95 (s)", sortable: true, align: "right" },
      { key: "increasePercent", header: "% Slower", sortable: true, align: "right" },
      { key: "detectedAt", header: "Detected At", sortable: true },
    ],
    rowCount: 6,
    primaryKeyColumn: "id",
    initialSortColumn: "increasePercent",
  });

  const errorRecovery = buildErrorRecoveryContract({
    errorCode: "OBSERVABILITY_BASELINE_CORRUPTED",
    errorTitle: "Telemetry Baseline Data Inconsistency",
    plainLanguageSummary: "Calculated P95 latency is undefined due to missing warmup samples in the selected time window.",
    focusTargetId: "timeRangeHours",
    recoverySteps: [
      {
        step: 1,
        label: "Widen lookback time range to at least 24 hours.",
        actionable: true,
        actionType: "review",
      },
      {
        step: 2,
        label: "Trigger baseline reset via POST /api/v1/profiling/regressions/recalculate.",
        actionable: true,
        actionType: "retry",
      },
    ],
    rollbackSafe: true,
    rollbackActionPrompt: "Restore baseline to previous stable snapshot.",
  });

  const workflow = buildWorkflowAccessibilityEnvelope({
    workflow: "Observability Regression Triage",
    screenReaderSummary: "Evaluates API latency anomalies and telemetry deviations against historical baselines.",
    reducedMotionHeader,
    focusOrder: ["route", "regressionThresholdPercent", "timeRangeHours", "query-metrics-btn"],
    initialFocusTarget: "regressionThresholdPercent",
    announcements: {
      initial: "Observability triage console active.",
      success: "Regression telemetry updated.",
      error: "Failed to fetch baseline telemetry. Review recovery guidance.",
    },
  });

  assertAccessibilityInvariants(workflow);

  return { form, table, errorRecovery, workflow };
}

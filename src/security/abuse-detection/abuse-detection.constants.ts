import {
  AbuseDetectionThresholds,
  HighImpactOperationKind,
} from "./abuse-detection.types";

export const ABUSE_DETECTION_MODE_ENV = "ABUSE_DETECTION_MODE";
export const ABUSE_STEP_UP_THRESHOLD_ENV = "ABUSE_STEP_UP_SCORE_THRESHOLD";
export const ABUSE_MANUAL_REVIEW_THRESHOLD_ENV =
  "ABUSE_MANUAL_REVIEW_SCORE_THRESHOLD";
export const ABUSE_BLOCK_THRESHOLD_ENV = "ABUSE_BLOCK_SCORE_THRESHOLD";
export const ABUSE_VELOCITY_WINDOW_SECONDS_ENV =
  "ABUSE_VELOCITY_WINDOW_SECONDS";
export const ABUSE_MAX_OPS_PER_WINDOW_ENV = "ABUSE_MAX_OPS_PER_WINDOW";
export const ABUSE_HIGH_VALUE_AMOUNT_ENV = "ABUSE_HIGH_VALUE_AMOUNT_THRESHOLD";
export const ABUSE_AMOUNT_SPIKE_MULTIPLIER_ENV =
  "ABUSE_AMOUNT_SPIKE_MULTIPLIER";
export const ABUSE_MAX_DESTINATIONS_PER_WINDOW_ENV =
  "ABUSE_MAX_DESTINATIONS_PER_WINDOW";
export const ABUSE_CREDENTIAL_COOLING_MINUTES_ENV =
  "ABUSE_CREDENTIAL_COOLING_MINUTES";
export const ABUSE_HIGH_SLIPPAGE_BPS_ENV = "ABUSE_HIGH_SLIPPAGE_BPS_THRESHOLD";
export const ABUSE_MAX_FAILED_ATTEMPTS_ENV =
  "ABUSE_MAX_FAILED_ATTEMPTS_PER_WINDOW";
export const ABUSE_BULK_RECORD_THRESHOLD_ENV = "ABUSE_BULK_RECORD_THRESHOLD";

export const DEFAULT_ABUSE_THRESHOLDS: AbuseDetectionThresholds = {
  mode: "enforce",
  stepUpScoreThreshold: 35,
  manualReviewScoreThreshold: 70,
  blockScoreThreshold: 85,
  velocityWindowSeconds: 300,
  maxOperationsPerWindow: 5,
  highValueAmountThreshold: 50_000,
  amountSpikeMultiplier: 5,
  maxDistinctDestinationsPerWindow: 3,
  credentialCoolingPeriodMinutes: 30,
  highSlippageBpsThreshold: 300,
  maxFailedAttemptsPerWindow: 3,
  bulkRecordThreshold: 500,
};

export const HIGH_IMPACT_OPERATION_KINDS: readonly HighImpactOperationKind[] = [
  "treasury_withdrawal",
  "payout_initiation",
  "portfolio_rebalance",
  "portfolio_liquidation",
  "defi_position_exit",
  "defi_adapter_swap",
  "auth_credential_change",
  "api_key_issuance",
  "mfa_reset",
  "wallet_unlink",
  "data_export",
  "bulk_notification_dispatch",
  "oracle_submission",
  "admin_privilege_change",
] as const;

export const ABUSE_RESPONSE_HEADERS = {
  ASSESSMENT_ID: "X-Abuse-Assessment-Id",
  RISK_SCORE: "X-Abuse-Risk-Score",
  RISK_LEVEL: "X-Abuse-Risk-Level",
  DISPOSITION: "X-Abuse-Disposition",
  REQUIRED_ACTION: "X-Abuse-Required-Action",
} as const;

export const ABUSE_EVENTS = {
  ASSESSMENT_COMPLETED: "security.abuse.assessment_completed",
  STEP_UP_REQUIRED: "security.abuse.step_up_required",
  REVIEW_QUEUED: "security.abuse.review_queued",
  OPERATION_BLOCKED: "security.abuse.operation_blocked",
  REVIEW_RESOLVED: "security.abuse.review_resolved",
} as const;

export const ABUSE_HIGH_IMPACT_METADATA_KEY =
  "trellis:security:high_impact_operation";

import type { ErrorCode } from "../../common/errors/error-codes";

/**
 * High-impact operation categories evaluated by the risk-scored abuse detector.
 *
 * Covers value movement, portfolio/DeFi state mutations, auth/credential changes,
 * data exports, notification fan-out, and privileged administrative actions.
 */
export type HighImpactOperationKind =
  | "treasury_withdrawal"
  | "payout_initiation"
  | "portfolio_rebalance"
  | "portfolio_liquidation"
  | "defi_position_exit"
  | "defi_adapter_swap"
  | "auth_credential_change"
  | "api_key_issuance"
  | "mfa_reset"
  | "wallet_unlink"
  | "data_export"
  | "bulk_notification_dispatch"
  | "oracle_submission"
  | "admin_privilege_change";

/**
 * Operational mode of the abuse detection engine:
 * - `enforce`: Enforce step-up, manual review, and block dispositions.
 * - `shadow`: Evaluate and emit explainable signals/telemetry, but allow requests through.
 * - `disabled`: Bypass risk evaluation (emergency rollback mode).
 */
export type AbuseDetectionMode = "enforce" | "shadow" | "disabled";

/** Risk tier derived from the composite risk score and invariant signals. */
export type AbuseRiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Decision disposition for an evaluated high-impact operation:
 * - `allow`: Low-risk legitimate use; proceeds without friction.
 * - `allow_after_step_up`: Elevated risk that was satisfied by fresh step-up verification.
 * - `allow_after_review`: High risk that was explicitly approved by an operator review.
 * - `step_up_required`: Medium/elevated risk; requires fresh 2FA/TOTP or signed challenge.
 * - `manual_review`: High risk; queued for compliance/operator review before execution.
 * - `block`: Critical risk or invariant violation; immediately rejected.
 */
export type AbuseDisposition =
  | "allow"
  | "allow_after_step_up"
  | "allow_after_review"
  | "step_up_required"
  | "manual_review"
  | "block";

/** Machine-readable explainable risk signal codes. */
export type AbuseSignalCode =
  | "VELOCITY_BURST"
  | "AMOUNT_ANOMALY_SPIKE"
  | "UNVERIFIED_DESTINATION"
  | "RAPID_DESTINATION_CHURN"
  | "NEW_DEVICE_OR_IP_CONTEXT"
  | "RECENT_AUTH_OR_CREDENTIAL_MUTATION"
  | "DEFI_SLIPPAGE_OR_DRAIN_PATTERN"
  | "REPEATED_FAILED_ATTEMPTS"
  | "PRIVILEGE_OR_IMPERSONATION_CONTEXT"
  | "BULK_FANOUT_OR_EXPORT_SPIKE"
  | "SANCTIONED_OR_HIGH_RISK_COUNTERPARTY"
  | "TRUSTED_PRINCIPAL_MITIGATION";

/** Signal category for grouping across auth, portfolio, DeFi, and notifications. */
export type AbuseSignalCategory =
  | "velocity"
  | "value_anomaly"
  | "destination"
  | "authentication"
  | "defi_portfolio"
  | "session_context"
  | "mitigation";

/** Severity of an individual risk signal. */
export type AbuseSignalSeverity = "info" | "low" | "medium" | "high" | "critical";

/** Action required from the caller when an operation is not immediately allowed. */
export type AbuseRequiredAction =
  | "none"
  | "provide_totp_or_challenge"
  | "await_operator_review"
  | "contact_security";

/**
 * A single explainable risk signal contributing to the composite risk score.
 * Never contains raw secrets, tokens, or unredacted PII.
 */
export interface AbuseRiskSignal {
  code: AbuseSignalCode;
  category: AbuseSignalCategory;
  severity: AbuseSignalSeverity;
  /** Signed score delta (positive for risk factors, negative for trust mitigations). */
  weight: number;
  /** Clear, human-readable explanation of why this signal fired. */
  explanation: string;
  /** Concrete next step for the user or operator. */
  remediation: string;
  /** Mapped platform ErrorCode when this signal drives a rejection. */
  errorCode: ErrorCode;
  /** Deterministic, sanitized evidence supporting the signal. */
  evidence: Record<string, string | number | boolean | null>;
}

/** Principal and session context for the actor initiating the operation. */
export interface AbuseActorContext {
  actorId: string;
  actorRole?: string;
  tenantId?: string;
  sessionId?: string;
  ipAddress?: string;
  deviceFingerprint?: string;
  userAgent?: string;
  /** Account age in days; established accounts with clean history receive trust mitigation. */
  accountAgeDays?: number;
  /** Whether the user has 2FA/MFA enrolled on their account. */
  mfaEnabled?: boolean;
  /** Whether a fresh step-up proof (TOTP, WebAuthn, or signed wallet challenge) was verified. */
  stepUpVerified?: boolean;
  /** Method used for step-up verification when present. */
  stepUpMethod?: "totp" | "wallet_challenge" | "webauthn" | "recovery_code";
  /** Whether the request is executing under an admin/maintainer impersonation session. */
  isImpersonated?: boolean;
  /** Impersonator actor ID if `isImpersonated` is true. */
  impersonatorId?: string;
  /** Minutes elapsed since last password change, MFA reset, API key creation, or wallet link. */
  minutesSinceLastCredentialChange?: number;
  /** Known/trusted IP addresses or device fingerprints for this actor. */
  knownDevicesOrIps?: string[];
  /** Verified payout/withdrawal destinations for this actor. */
  verifiedDestinations?: string[];
  /** Operator review approval token when retrying an approved operation. */
  reviewApprovalToken?: string;
}

/** High-impact operation payload submitted for abuse risk evaluation. */
export interface HighImpactOperationInput {
  kind: HighImpactOperationKind;
  /** Monetary or token amount involved in the operation (when applicable). */
  amount?: number;
  /** Historical average operation amount for this actor (when known). */
  historicalAverageAmount?: number;
  /** Asset symbol or identifier (e.g., USDC, XLM). */
  asset?: string;
  /** Target destination wallet, contract address, or webhook/export sink. */
  destination?: string;
  /** Target portfolio ID (when applicable). */
  portfolioId?: string;
  /** Target DeFi adapter or protocol identifier (when applicable). */
  adapterId?: string;
  /** Fraction of portfolio or DeFi position being exited/moved (0.0 to 1.0). */
  portfolioExitFraction?: number;
  /** Slippage tolerance in basis points for DeFi swaps/exits (e.g., 500 = 5%). */
  slippageBps?: number;
  /** Whether the target DeFi adapter or contract is verified in the registry. */
  adapterVerified?: boolean;
  /** Number of records or recipients targeted (for exports or notification fan-out). */
  recordOrRecipientCount?: number;
  /** Whether the destination or counterparty is on a sanctions or high-risk denylist. */
  counterpartyFlagged?: boolean;
  /** Idempotency or correlation key for the operation. */
  idempotencyKey?: string;
  /** Optional ISO timestamp for deterministic evaluation in tests/replays. */
  asOf?: string;
  /** Additional sanitized metadata for domain-specific context. */
  metadata?: Record<string, string | number | boolean | null>;
}

/** Observed sliding-window behavioral state for the actor. */
export interface AbuseBehavioralWindowState {
  /** Number of high-impact operations attempted by this actor in the active window. */
  recentOperationCount: number;
  /** Distinct unverified destinations targeted by this actor in the active window. */
  recentDistinctDestinations: string[];
  /** Number of failed auth, preflight, or verification attempts in the active window. */
  recentFailedAttempts: number;
}

/** Configurable risk thresholds and scoring parameters. */
export interface AbuseDetectionThresholds {
  mode: AbuseDetectionMode;
  /** Score at or above which step-up verification is required (default: 35). */
  stepUpScoreThreshold: number;
  /** Score at or above which manual operator review is required (default: 70). */
  manualReviewScoreThreshold: number;
  /** Score at or above which the operation is immediately blocked (default: 85). */
  blockScoreThreshold: number;
  /** Sliding window duration in seconds for velocity tracking (default: 300). */
  velocityWindowSeconds: number;
  /** Max operations in the velocity window before `VELOCITY_BURST` fires (default: 5). */
  maxOperationsPerWindow: number;
  /** Absolute high-value amount threshold (default: 50_000). */
  highValueAmountThreshold: number;
  /** Multiplier over historical average that triggers `AMOUNT_ANOMALY_SPIKE` (default: 5). */
  amountSpikeMultiplier: number;
  /** Maximum distinct destinations in window before `RAPID_DESTINATION_CHURN` fires (default: 3). */
  maxDistinctDestinationsPerWindow: number;
  /** Recent credential mutation window in minutes (default: 30). */
  credentialCoolingPeriodMinutes: number;
  /** DeFi slippage threshold in bps before `DEFI_SLIPPAGE_OR_DRAIN_PATTERN` fires (default: 300). */
  highSlippageBpsThreshold: number;
  /** Failed attempts in window before `REPEATED_FAILED_ATTEMPTS` fires (default: 3). */
  maxFailedAttemptsPerWindow: number;
  /** Bulk export/notification count threshold (default: 500). */
  bulkRecordThreshold: number;
}

/** Complete, deterministic verdict from the risk-scored abuse detector. */
export interface AbuseAssessmentResult {
  /** Deterministic identifier: `abd:<kind>:<hex>`. */
  assessmentId: string;
  operationKind: HighImpactOperationKind;
  actorId: string;
  /** Composite risk score clamped to `[0, 100]`. */
  score: number;
  /** Unclamped raw sum of signal weights for diagnostic transparency. */
  rawScore: number;
  riskLevel: AbuseRiskLevel;
  disposition: AbuseDisposition;
  /** Effective enforcement mode when this assessment ran. */
  mode: AbuseDetectionMode;
  /** True when the operation is permitted to proceed immediately. */
  allowed: boolean;
  /** True when elevated risk was mitigated by step-up verification. */
  stepUpSatisfied: boolean;
  /** True when queued for or resolved by manual operator review. */
  reviewRequired: boolean;
  /** Associated review ticket ID when `disposition === 'manual_review'`. */
  reviewId?: string;
  requiredAction: AbuseRequiredAction;
  /** Deterministically ordered explainable signals (highest positive weight first). */
  signals: AbuseRiskSignal[];
  /** Digest of the normalized operation + actor input. */
  operationDigest: string;
  /** Digest over the assessment result itself. */
  digest: string;
  evaluatedAt: string;
  /** User-safe summary message explaining the outcome. */
  summary: string;
}

/** Status of a queued manual review item. */
export type AbuseReviewStatus = "pending" | "approved" | "rejected" | "expired";

/** Record created when an operation triggers `manual_review`. */
export interface AbuseReviewRecord {
  reviewId: string;
  assessmentId: string;
  actorId: string;
  operationKind: HighImpactOperationKind;
  operationDigest: string;
  score: number;
  riskLevel: AbuseRiskLevel;
  signals: AbuseRiskSignal[];
  status: AbuseReviewStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionReason?: string;
  /** One-time approval token issued when an operator approves the review. */
  approvalToken?: string;
}

/** Telemetry snapshot for observability and monitoring dashboards. */
export interface AbuseDetectionMetricsSnapshot {
  mode: AbuseDetectionMode;
  totalAssessments: number;
  byDisposition: Record<AbuseDisposition, number>;
  byRiskLevel: Record<AbuseRiskLevel, number>;
  byOperationKind: Partial<Record<HighImpactOperationKind, number>>;
  bySignalCode: Partial<Record<AbuseSignalCode, number>>;
  pendingReviews: number;
  approvedReviews: number;
  rejectedReviews: number;
  shadowWouldHaveBlockedOrChallenged: number;
}

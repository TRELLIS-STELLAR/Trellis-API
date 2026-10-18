import { createHash, randomBytes } from "crypto";
import type {
  AbuseActorContext,
  AbuseAssessmentResult,
  AbuseBehavioralWindowState,
  AbuseDetectionMetricsSnapshot,
  AbuseDetectionMode,
  AbuseDetectionThresholds,
  AbuseDisposition,
  AbuseRequiredAction,
  AbuseReviewRecord,
  AbuseReviewStatus,
  AbuseRiskLevel,
  AbuseRiskSignal,
  AbuseSignalCode,
  HighImpactOperationInput,
  HighImpactOperationKind,
} from "./abuse-detection.types";
import type { ErrorCode } from "../../common/errors/error-codes";

export const DEFAULT_ABUSE_THRESHOLDS_CORE: AbuseDetectionThresholds = {
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

const ERROR_CODE = {
  FORBIDDEN: "FORBIDDEN" as ErrorCode,
  RISK_LIMIT_EXCEEDED: "RISK_LIMIT_EXCEEDED" as ErrorCode,
  PRECONDITION_FAILED: "PRECONDITION_FAILED" as ErrorCode,
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED" as ErrorCode,
};

export interface AbuseRuleEvaluationContext {
  operation: HighImpactOperationInput;
  actor: AbuseActorContext;
  windowState: AbuseBehavioralWindowState;
  thresholds: AbuseDetectionThresholds;
  asOf: string;
  /** True when a valid operator review approval token matched this operation digest. */
  reviewApproved?: boolean;
}

const VALUE_MOVING_KINDS = new Set([
  "treasury_withdrawal",
  "payout_initiation",
  "portfolio_rebalance",
  "portfolio_liquidation",
  "defi_position_exit",
  "defi_adapter_swap",
]);

const DEFI_PORTFOLIO_KINDS = new Set([
  "portfolio_rebalance",
  "portfolio_liquidation",
  "defi_position_exit",
  "defi_adapter_swap",
]);

/**
 * Pure, deterministic risk-scoring engine for high-impact operations.
 *
 * Given identical `(operation, actor, windowState, thresholds, asOf)` inputs,
 * this function always produces the exact same `AbuseAssessmentResult` and digest.
 */
export function evaluateAbuseRisk(
  ctx: AbuseRuleEvaluationContext,
): AbuseAssessmentResult {
  const { operation, actor, windowState, thresholds, asOf, reviewApproved } =
    ctx;
  const operationDigest = computeOperationDigest(operation, actor.actorId);

  if (thresholds.mode === "disabled") {
    return buildResult({
      operation,
      actor,
      thresholds,
      asOf,
      operationDigest,
      signals: [],
      rawScore: 0,
      score: 0,
      riskLevel: "low",
      disposition: "allow",
      allowed: true,
      stepUpSatisfied: false,
      reviewRequired: false,
      requiredAction: "none",
      summary:
        "Abuse detection is currently disabled; operation allowed without risk scoring.",
    });
  }

  const signals: AbuseRiskSignal[] = [];

  // 1. Critical Counterparty / Sanctions Check
  if (operation.counterpartyFlagged === true) {
    signals.push({
      code: "SANCTIONED_OR_HIGH_RISK_COUNTERPARTY",
      category: "destination",
      severity: "critical",
      weight: 95,
      explanation:
        "Target destination or counterparty is flagged as high-risk or restricted.",
      remediation:
        "Abort this operation and contact security/compliance before interacting with this address.",
      errorCode: ERROR_CODE.FORBIDDEN,
      evidence: {
        destinationPrefix: maskIdentifier(operation.destination),
        counterpartyFlagged: true,
      },
    });
  }

  // 2. Velocity Burst Check
  if (windowState.recentOperationCount >= thresholds.maxOperationsPerWindow) {
    const excess =
      windowState.recentOperationCount - thresholds.maxOperationsPerWindow + 1;
    const weight = Math.min(55, 35 + (excess - 1) * 10);
    signals.push({
      code: "VELOCITY_BURST",
      category: "velocity",
      severity: weight >= 45 ? "high" : "medium",
      weight,
      explanation: `Actor attempted ${windowState.recentOperationCount + 1} high-impact operations within ${thresholds.velocityWindowSeconds}s (threshold: ${thresholds.maxOperationsPerWindow}).`,
      remediation:
        "Complete step-up verification or wait for the velocity cooling window before submitting additional high-impact operations.",
      errorCode: ERROR_CODE.RISK_LIMIT_EXCEEDED,
      evidence: {
        observedOperationsInWindow: windowState.recentOperationCount + 1,
        maxOperationsPerWindow: thresholds.maxOperationsPerWindow,
        windowSeconds: thresholds.velocityWindowSeconds,
      },
    });
  }

  // 3. Amount Anomaly Spike Check
  if (
    typeof operation.amount === "number" &&
    Number.isFinite(operation.amount) &&
    operation.amount > 0
  ) {
    const exceedsAbsoluteHigh =
      operation.amount >= thresholds.highValueAmountThreshold;
    const hasBaseline =
      typeof operation.historicalAverageAmount === "number" &&
      Number.isFinite(operation.historicalAverageAmount) &&
      operation.historicalAverageAmount > 0;
    const ratio = hasBaseline
      ? operation.amount / (operation.historicalAverageAmount as number)
      : 1;
    const exceedsRelativeSpike =
      hasBaseline && ratio >= thresholds.amountSpikeMultiplier;

    if (exceedsAbsoluteHigh && exceedsRelativeSpike) {
      signals.push({
        code: "AMOUNT_ANOMALY_SPIKE",
        category: "value_anomaly",
        severity: "high",
        weight: 45,
        explanation: `Operation amount (${operation.amount}) exceeds both the high-value threshold (${thresholds.highValueAmountThreshold}) and ${ratio.toFixed(1)}x the actor's historical average.`,
        remediation:
          "Provide step-up authentication or submit the high-value transfer for operator review.",
        errorCode: ERROR_CODE.RISK_LIMIT_EXCEEDED,
        evidence: {
          amount: operation.amount,
          highValueThreshold: thresholds.highValueAmountThreshold,
          historicalRatio: Number(ratio.toFixed(2)),
          spikeMultiplierThreshold: thresholds.amountSpikeMultiplier,
        },
      });
    } else if (exceedsAbsoluteHigh || exceedsRelativeSpike) {
      signals.push({
        code: "AMOUNT_ANOMALY_SPIKE",
        category: "value_anomaly",
        severity: "medium",
        weight: 30,
        explanation: exceedsRelativeSpike
          ? `Operation amount (${operation.amount}) is ${ratio.toFixed(1)}x the actor's historical baseline.`
          : `Operation amount (${operation.amount}) reaches or exceeds the high-value threshold (${thresholds.highValueAmountThreshold}).`,
        remediation:
          "Verify the operation amount and complete step-up authentication.",
        errorCode: ERROR_CODE.RISK_LIMIT_EXCEEDED,
        evidence: {
          amount: operation.amount,
          highValueThreshold: thresholds.highValueAmountThreshold,
          historicalRatio: Number(ratio.toFixed(2)),
        },
      });
    }
  }

  // 4. Unverified Destination Check
  if (
    operation.destination &&
    VALUE_MOVING_KINDS.has(operation.kind) &&
    Array.isArray(actor.verifiedDestinations)
  ) {
    const normalizedDest = operation.destination.trim().toLowerCase();
    const verifiedSet = new Set(
      actor.verifiedDestinations.map((d) => d.trim().toLowerCase()),
    );
    if (!verifiedSet.has(normalizedDest)) {
      signals.push({
        code: "UNVERIFIED_DESTINATION",
        category: "destination",
        severity: "medium",
        weight: 25,
        explanation:
          "Value-moving operation targets a destination address not in the actor's verified allow-list.",
        remediation:
          "Complete step-up verification to confirm the new destination or whitelist the address first.",
        errorCode: ERROR_CODE.PRECONDITION_FAILED,
        evidence: {
          destinationPrefix: maskIdentifier(operation.destination),
          verifiedDestinationCount: verifiedSet.size,
        },
      });
    }
  }

  // 5. Rapid Destination Churn Check
  if (
    windowState.recentDistinctDestinations.length >=
    thresholds.maxDistinctDestinationsPerWindow
  ) {
    signals.push({
      code: "RAPID_DESTINATION_CHURN",
      category: "destination",
      severity: "high",
      weight: 35,
      explanation: `Actor targeted ${windowState.recentDistinctDestinations.length} distinct destinations within the active observation window (threshold: ${thresholds.maxDistinctDestinationsPerWindow}).`,
      remediation:
        "Multi-destination fan-out requires step-up authentication or operator review.",
      errorCode: ERROR_CODE.RISK_LIMIT_EXCEEDED,
      evidence: {
        distinctDestinationsInWindow:
          windowState.recentDistinctDestinations.length,
        maxDistinctDestinations: thresholds.maxDistinctDestinationsPerWindow,
      },
    });
  }

  // 6. New Device or Unrecognized IP Context Check
  if (
    Array.isArray(actor.knownDevicesOrIps) &&
    actor.knownDevicesOrIps.length > 0
  ) {
    const knownSet = new Set(
      actor.knownDevicesOrIps.map((item) => item.trim().toLowerCase()),
    );
    const currentDevice = actor.deviceFingerprint?.trim().toLowerCase();
    const currentIp = actor.ipAddress?.trim().toLowerCase();
    const deviceRecognized = currentDevice
      ? knownSet.has(currentDevice)
      : false;
    const ipRecognized = currentIp ? knownSet.has(currentIp) : false;

    if ((currentDevice || currentIp) && !deviceRecognized && !ipRecognized) {
      signals.push({
        code: "NEW_DEVICE_OR_IP_CONTEXT",
        category: "session_context",
        severity: "medium",
        weight: 20,
        explanation:
          "High-impact operation initiated from an unrecognized device fingerprint or IP context.",
        remediation:
          "Complete step-up verification to confirm account ownership from this device/network.",
        errorCode: ERROR_CODE.FORBIDDEN,
        evidence: {
          hasDeviceFingerprint: Boolean(currentDevice),
          ipPrefix: maskIdentifier(actor.ipAddress),
          knownContextCount: knownSet.size,
        },
      });
    }
  }

  // 7. Recent Auth or Credential Mutation before High-Impact Action
  if (
    typeof actor.minutesSinceLastCredentialChange === "number" &&
    actor.minutesSinceLastCredentialChange >= 0 &&
    actor.minutesSinceLastCredentialChange <=
      thresholds.credentialCoolingPeriodMinutes
  ) {
    signals.push({
      code: "RECENT_AUTH_OR_CREDENTIAL_MUTATION",
      category: "authentication",
      severity: "high",
      weight: 35,
      explanation: `Account credentials, MFA settings, or API keys were modified ${actor.minutesSinceLastCredentialChange} minute(s) ago (cooling period: ${thresholds.credentialCoolingPeriodMinutes}m).`,
      remediation:
        "Complete fresh step-up verification or wait for the post-credential-change cooling period to elapse.",
      errorCode: ERROR_CODE.FORBIDDEN,
      evidence: {
        minutesSinceLastCredentialChange:
          actor.minutesSinceLastCredentialChange,
        coolingPeriodMinutes: thresholds.credentialCoolingPeriodMinutes,
      },
    });
  }

  // 8. DeFi Adapter / Portfolio Drain or Abnormal Slippage Pattern
  if (DEFI_PORTFOLIO_KINDS.has(operation.kind)) {
    const highSlippage =
      typeof operation.slippageBps === "number" &&
      operation.slippageBps >= thresholds.highSlippageBpsThreshold;
    const nearFullDrain =
      typeof operation.portfolioExitFraction === "number" &&
      operation.portfolioExitFraction >= 0.9;
    const unverifiedAdapter = operation.adapterVerified === false;

    if (unverifiedAdapter || (highSlippage && nearFullDrain)) {
      signals.push({
        code: "DEFI_SLIPPAGE_OR_DRAIN_PATTERN",
        category: "defi_portfolio",
        severity: "high",
        weight: 45,
        explanation: unverifiedAdapter
          ? "DeFi/portfolio operation interacts with an unverified protocol adapter."
          : `Rapid portfolio/position exit (${Math.round((operation.portfolioExitFraction ?? 0) * 100)}%) combined with elevated slippage tolerance (${operation.slippageBps} bps).`,
        remediation:
          "Reduce slippage tolerance, verify the target DeFi adapter, or complete step-up/operator review.",
        errorCode: ERROR_CODE.RISK_LIMIT_EXCEEDED,
        evidence: {
          slippageBps: operation.slippageBps ?? null,
          highSlippageBpsThreshold: thresholds.highSlippageBpsThreshold,
          portfolioExitFraction: operation.portfolioExitFraction ?? null,
          adapterVerified: operation.adapterVerified ?? true,
        },
      });
    } else if (highSlippage || nearFullDrain) {
      signals.push({
        code: "DEFI_SLIPPAGE_OR_DRAIN_PATTERN",
        category: "defi_portfolio",
        severity: "medium",
        weight: 25,
        explanation: highSlippage
          ? `DeFi operation specifies elevated slippage tolerance (${operation.slippageBps} bps >= ${thresholds.highSlippageBpsThreshold} bps).`
          : `Operation exits or liquidates ${Math.round((operation.portfolioExitFraction ?? 0) * 100)}% of the portfolio/position in a single action.`,
        remediation:
          "Confirm the slippage/exit parameters with step-up authentication.",
        errorCode: ERROR_CODE.RISK_LIMIT_EXCEEDED,
        evidence: {
          slippageBps: operation.slippageBps ?? null,
          portfolioExitFraction: operation.portfolioExitFraction ?? null,
        },
      });
    }
  }

  // 9. Repeated Failed Attempts Preceding Operation
  if (
    windowState.recentFailedAttempts >= thresholds.maxFailedAttemptsPerWindow
  ) {
    signals.push({
      code: "REPEATED_FAILED_ATTEMPTS",
      category: "authentication",
      severity: "medium",
      weight: 30,
      explanation: `Actor recorded ${windowState.recentFailedAttempts} failed authentication, verification, or preflight attempts prior to this operation.`,
      remediation:
        "Complete step-up authentication to confirm legitimate session control.",
      errorCode: ERROR_CODE.FORBIDDEN,
      evidence: {
        recentFailedAttempts: windowState.recentFailedAttempts,
        maxFailedAttemptsPerWindow: thresholds.maxFailedAttemptsPerWindow,
      },
    });
  }

  // 10. Privilege Escalation or Impersonation Session Context
  if (
    actor.isImpersonated === true ||
    operation.kind === "admin_privilege_change" ||
    operation.kind === "mfa_reset"
  ) {
    const isImpersonated = actor.isImpersonated === true;
    signals.push({
      code: "PRIVILEGE_OR_IMPERSONATION_CONTEXT",
      category: "session_context",
      severity: isImpersonated ? "high" : "medium",
      weight: isImpersonated ? 40 : 35,
      explanation: isImpersonated
        ? "High-impact operation attempted inside an active support/maintainer impersonation session."
        : `Sensitive privilege or security boundary mutation (${operation.kind}) requires elevated verification.`,
      remediation:
        "Provide fresh step-up verification (TOTP/2FA) or exit impersonation before executing high-impact mutations.",
      errorCode: ERROR_CODE.FORBIDDEN,
      evidence: {
        isImpersonated,
        operationKind: operation.kind,
      },
    });
  }

  // 11. Bulk Export or Notification Fan-Out Spike
  if (
    typeof operation.recordOrRecipientCount === "number" &&
    operation.recordOrRecipientCount >= thresholds.bulkRecordThreshold
  ) {
    const isExtreme =
      operation.recordOrRecipientCount >= thresholds.bulkRecordThreshold * 5;
    signals.push({
      code: "BULK_FANOUT_OR_EXPORT_SPIKE",
      category: "velocity",
      severity: isExtreme ? "high" : "medium",
      weight: isExtreme ? 45 : 35,
      explanation: `Operation targets ${operation.recordOrRecipientCount} records/recipients (threshold: ${thresholds.bulkRecordThreshold}).`,
      remediation:
        "Narrow the export/notification scope or complete step-up/operator review.",
      errorCode: ERROR_CODE.QUOTA_EXCEEDED,
      evidence: {
        recordOrRecipientCount: operation.recordOrRecipientCount,
        bulkRecordThreshold: thresholds.bulkRecordThreshold,
      },
    });
  }

  // 12. Trusted Principal Mitigation (avoids false positives on legitimate low/moderate-risk users)
  const positiveRiskWeight = signals.reduce(
    (sum, s) => (s.weight > 0 ? sum + s.weight : sum),
    0,
  );
  const hasCriticalSignal = signals.some((s) => s.severity === "critical");
  const isEstablishedAccount =
    typeof actor.accountAgeDays === "number" && actor.accountAgeDays >= 30;
  const hasLowVelocity = windowState.recentOperationCount <= 1;
  const hasCleanAttempts = windowState.recentFailedAttempts === 0;
  const hasVerifiedDest =
    Boolean(operation.destination) &&
    Array.isArray(actor.verifiedDestinations) &&
    actor.verifiedDestinations
      .map((d) => d.trim().toLowerCase())
      .includes(operation.destination!.trim().toLowerCase());

  if (
    !hasCriticalSignal &&
    isEstablishedAccount &&
    actor.mfaEnabled === true &&
    hasLowVelocity &&
    hasCleanAttempts &&
    (hasVerifiedDest || !operation.destination)
  ) {
    signals.push({
      code: "TRUSTED_PRINCIPAL_MITIGATION",
      category: "mitigation",
      severity: "info",
      weight: -15,
      explanation:
        "Trusted principal baseline applied (established account tenure, MFA enabled, normal velocity, and verified destination context).",
      remediation: "No action required.",
      errorCode: ERROR_CODE.FORBIDDEN,
      evidence: {
        accountAgeDays: actor.accountAgeDays ?? 0,
        mfaEnabled: true,
        verifiedDestination: hasVerifiedDest,
        positiveRiskWeightBeforeMitigation: positiveRiskWeight,
      },
    });
  }

  // Sort signals deterministically: highest weight descending, then lexicographically by code
  signals.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.code.localeCompare(b.code);
  });

  const rawScore = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.max(0, Math.min(100, rawScore));

  const riskLevel = resolveRiskLevel(score, hasCriticalSignal, thresholds);
  const {
    disposition,
    allowed,
    stepUpSatisfied,
    reviewRequired,
    requiredAction,
    summary,
  } = resolveDisposition({
    score,
    hasCriticalSignal,
    thresholds,
    stepUpVerified: actor.stepUpVerified === true,
    reviewApproved: reviewApproved === true,
    signals,
  });

  return buildResult({
    operation,
    actor,
    thresholds,
    asOf,
    operationDigest,
    signals,
    rawScore,
    score,
    riskLevel,
    disposition,
    allowed,
    stepUpSatisfied,
    reviewRequired,
    requiredAction,
    summary,
  });
}

function resolveRiskLevel(
  score: number,
  hasCriticalSignal: boolean,
  thresholds: AbuseDetectionThresholds,
): AbuseRiskLevel {
  if (hasCriticalSignal || score >= thresholds.blockScoreThreshold) {
    return "critical";
  }
  if (score >= thresholds.manualReviewScoreThreshold) {
    return "high";
  }
  if (score >= thresholds.stepUpScoreThreshold) {
    return "medium";
  }
  return "low";
}

function resolveDisposition(params: {
  score: number;
  hasCriticalSignal: boolean;
  thresholds: AbuseDetectionThresholds;
  stepUpVerified: boolean;
  reviewApproved: boolean;
  signals: AbuseRiskSignal[];
}): {
  disposition: AbuseDisposition;
  allowed: boolean;
  stepUpSatisfied: boolean;
  reviewRequired: boolean;
  requiredAction: AbuseRequiredAction;
  summary: string;
} {
  const {
    score,
    hasCriticalSignal,
    thresholds,
    stepUpVerified,
    reviewApproved,
    signals,
  } = params;
  const shadowMode = thresholds.mode === "shadow";

  if (hasCriticalSignal || score >= thresholds.blockScoreThreshold) {
    const primaryReason =
      signals[0]?.explanation ?? "Critical abuse risk threshold exceeded.";
    return {
      disposition: "block",
      allowed: shadowMode,
      stepUpSatisfied: false,
      reviewRequired: false,
      requiredAction: "contact_security",
      summary: shadowMode
        ? `[SHADOW] Operation would be blocked (score=${score}): ${primaryReason}`
        : `Operation blocked due to critical risk signals (score=${score}): ${primaryReason}`,
    };
  }

  if (score >= thresholds.manualReviewScoreThreshold) {
    if (reviewApproved) {
      return {
        disposition: "allow_after_review",
        allowed: true,
        stepUpSatisfied: stepUpVerified,
        reviewRequired: false,
        requiredAction: "none",
        summary: `High-risk operation allowed via verified operator review approval (score=${score}).`,
      };
    }
    const primaryReason =
      signals[0]?.explanation ??
      "High abuse risk score requires operator review.";
    return {
      disposition: "manual_review",
      allowed: shadowMode,
      stepUpSatisfied: false,
      reviewRequired: true,
      requiredAction: "await_operator_review",
      summary: shadowMode
        ? `[SHADOW] Operation would be queued for manual review (score=${score}): ${primaryReason}`
        : `Operation held for manual security/compliance review (score=${score}): ${primaryReason}`,
    };
  }

  if (score >= thresholds.stepUpScoreThreshold) {
    if (stepUpVerified) {
      return {
        disposition: "allow_after_step_up",
        allowed: true,
        stepUpSatisfied: true,
        reviewRequired: false,
        requiredAction: "none",
        summary: `Elevated-risk operation allowed after step-up verification (score=${score}).`,
      };
    }
    const primaryReason =
      signals[0]?.explanation ??
      "Elevated risk score requires step-up authentication.";
    return {
      disposition: "step_up_required",
      allowed: shadowMode,
      stepUpSatisfied: false,
      reviewRequired: false,
      requiredAction: "provide_totp_or_challenge",
      summary: shadowMode
        ? `[SHADOW] Operation would require step-up verification (score=${score}): ${primaryReason}`
        : `Step-up authentication required before executing this operation (score=${score}): ${primaryReason}`,
    };
  }

  return {
    disposition: "allow",
    allowed: true,
    stepUpSatisfied: stepUpVerified,
    reviewRequired: false,
    requiredAction: "none",
    summary: `Operation permitted; risk score (${score}) is within normal low-risk bounds.`,
  };
}

function buildResult(params: {
  operation: HighImpactOperationInput;
  actor: AbuseActorContext;
  thresholds: AbuseDetectionThresholds;
  asOf: string;
  operationDigest: string;
  signals: AbuseRiskSignal[];
  rawScore: number;
  score: number;
  riskLevel: AbuseRiskLevel;
  disposition: AbuseDisposition;
  allowed: boolean;
  stepUpSatisfied: boolean;
  reviewRequired: boolean;
  requiredAction: AbuseRequiredAction;
  summary: string;
}): AbuseAssessmentResult {
  const {
    operation,
    actor,
    thresholds,
    asOf,
    operationDigest,
    signals,
    rawScore,
    score,
    riskLevel,
    disposition,
    allowed,
    stepUpSatisfied,
    reviewRequired,
    requiredAction,
    summary,
  } = params;

  const assessmentHash = createHash("sha256")
    .update(
      JSON.stringify({
        operationDigest,
        actorId: actor.actorId,
        score,
        disposition,
        mode: thresholds.mode,
        signalCodes: signals.map((s) => `${s.code}:${s.weight}`),
        asOf,
      }),
    )
    .digest("hex");

  const assessmentId = `abd:${operation.kind}:${assessmentHash.slice(0, 16)}`;

  return {
    assessmentId,
    operationKind: operation.kind,
    actorId: actor.actorId,
    score,
    rawScore,
    riskLevel,
    disposition,
    mode: thresholds.mode,
    allowed,
    stepUpSatisfied,
    reviewRequired,
    requiredAction,
    signals,
    operationDigest,
    digest: assessmentHash,
    evaluatedAt: asOf,
    summary,
  };
}

/** Computes a deterministic digest over the operation and actor identity. */
export function computeOperationDigest(
  operation: HighImpactOperationInput,
  actorId: string,
): string {
  const canonical = {
    actorId: actorId.trim(),
    kind: operation.kind,
    amount: operation.amount ?? null,
    asset: operation.asset?.trim().toUpperCase() ?? null,
    destination: operation.destination?.trim().toLowerCase() ?? null,
    portfolioId: operation.portfolioId ?? null,
    adapterId: operation.adapterId ?? null,
    portfolioExitFraction: operation.portfolioExitFraction ?? null,
    slippageBps: operation.slippageBps ?? null,
    recordOrRecipientCount: operation.recordOrRecipientCount ?? null,
    idempotencyKey: operation.idempotencyKey ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Masks sensitive or full-length identifiers so evidence never leaks raw addresses or IPs. */
export function maskIdentifier(value?: string | null): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length <= 6) return "***";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-3)}`;
}

export function defaultAbuseThresholds(): AbuseDetectionThresholds {
  return { ...DEFAULT_ABUSE_THRESHOLDS_CORE };
}

/**
 * Validate and sanitize threshold configuration, falling back to safe defaults
 * if thresholds are non-positive or non-monotonic.
 */
export function sanitizeAbuseThresholds(
  partial?: Partial<AbuseDetectionThresholds>,
): AbuseDetectionThresholds {
  const base = { ...DEFAULT_ABUSE_THRESHOLDS_CORE, ...(partial ?? {}) };
  const mode: AbuseDetectionMode =
    base.mode === "shadow" || base.mode === "disabled" || base.mode === "enforce"
      ? base.mode
      : "enforce";

  let { stepUpScoreThreshold, manualReviewScoreThreshold, blockScoreThreshold } =
    base;

  if (
    !(
      Number.isFinite(stepUpScoreThreshold) &&
      stepUpScoreThreshold > 0 &&
      Number.isFinite(manualReviewScoreThreshold) &&
      Number.isFinite(blockScoreThreshold) &&
      stepUpScoreThreshold < manualReviewScoreThreshold &&
      manualReviewScoreThreshold < blockScoreThreshold &&
      blockScoreThreshold <= 100
    )
  ) {
    stepUpScoreThreshold = DEFAULT_ABUSE_THRESHOLDS_CORE.stepUpScoreThreshold;
    manualReviewScoreThreshold =
      DEFAULT_ABUSE_THRESHOLDS_CORE.manualReviewScoreThreshold;
    blockScoreThreshold = DEFAULT_ABUSE_THRESHOLDS_CORE.blockScoreThreshold;
  }

  return {
    ...base,
    mode,
    stepUpScoreThreshold,
    manualReviewScoreThreshold,
    blockScoreThreshold,
  };
}

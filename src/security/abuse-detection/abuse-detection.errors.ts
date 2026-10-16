import { HttpStatus } from "@nestjs/common";
import { AppException } from "src/common/errors/app.exception";
import { ErrorCode, ErrorDomain } from "src/common/errors/error-codes";
import {
  AbuseAssessmentResult,
  AbuseDisposition,
  AbuseRequiredAction,
  AbuseRiskLevel,
  AbuseRiskSignal,
} from "./abuse-detection.types";

/**
 * Base exception for operations halted by risk-scored abuse detection.
 * Extends {@link AppException} so the global exception filter renders standard
 * RFC 7807 Problem Details while preserving explainable risk signals for callers.
 */
export class AbuseDetectionException extends AppException {
  public readonly assessmentId: string;
  public readonly score: number;
  public readonly riskLevel: AbuseRiskLevel;
  public readonly disposition: AbuseDisposition;
  public readonly requiredAction: AbuseRequiredAction;
  public readonly signals: AbuseRiskSignal[];
  public readonly reviewId?: string;

  constructor(
    result: AbuseAssessmentResult,
    status: HttpStatus,
    errorCode: ErrorCode,
    retryable: boolean,
  ) {
    const positiveSignals = result.signals.filter((s) => s.weight > 0);
    const primaryRemediation =
      positiveSignals[0]?.remediation ??
      "Complete step-up authentication or contact security to proceed.";

    super(result.summary, status, errorCode, {
      domain: ErrorDomain.AUTH,
      retryable,
      recoveryGuidance: primaryRemediation,
    });

    this.assessmentId = result.assessmentId;
    this.score = result.score;
    this.riskLevel = result.riskLevel;
    this.disposition = result.disposition;
    this.requiredAction = result.requiredAction;
    this.signals = result.signals;
    this.reviewId = result.reviewId;
  }
}

/** Thrown when an elevated-risk operation requires step-up authentication (TOTP/challenge). */
export class AbuseStepUpRequiredException extends AbuseDetectionException {
  constructor(result: AbuseAssessmentResult) {
    super(result, HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, true);
  }
}

/** Thrown when a high-risk operation is queued for manual operator/compliance review. */
export class AbuseManualReviewRequiredException extends AbuseDetectionException {
  constructor(result: AbuseAssessmentResult) {
    super(result, HttpStatus.FORBIDDEN, ErrorCode.RISK_LIMIT_EXCEEDED, false);
  }
}

/** Thrown when a critical-risk operation is immediately blocked. */
export class AbuseOperationBlockedException extends AbuseDetectionException {
  constructor(result: AbuseAssessmentResult) {
    super(result, HttpStatus.FORBIDDEN, ErrorCode.RISK_LIMIT_EXCEEDED, false);
  }
}

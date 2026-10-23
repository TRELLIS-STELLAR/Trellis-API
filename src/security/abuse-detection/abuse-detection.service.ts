import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { createHash, randomBytes } from "crypto";
import {
  ABUSE_AMOUNT_SPIKE_MULTIPLIER_ENV,
  ABUSE_BLOCK_THRESHOLD_ENV,
  ABUSE_BULK_RECORD_THRESHOLD_ENV,
  ABUSE_CREDENTIAL_COOLING_MINUTES_ENV,
  ABUSE_DETECTION_MODE_ENV,
  ABUSE_EVENTS,
  ABUSE_HIGH_SLIPPAGE_BPS_ENV,
  ABUSE_HIGH_VALUE_AMOUNT_ENV,
  ABUSE_MANUAL_REVIEW_THRESHOLD_ENV,
  ABUSE_MAX_DESTINATIONS_PER_WINDOW_ENV,
  ABUSE_MAX_FAILED_ATTEMPTS_ENV,
  ABUSE_MAX_OPS_PER_WINDOW_ENV,
  ABUSE_STEP_UP_THRESHOLD_ENV,
  ABUSE_VELOCITY_WINDOW_SECONDS_ENV,
  DEFAULT_ABUSE_THRESHOLDS,
} from "./abuse-detection.constants";
import {
  AbuseManualReviewRequiredException,
  AbuseOperationBlockedException,
  AbuseStepUpRequiredException,
} from "./abuse-detection.errors";
import {
  computeOperationDigest,
  evaluateAbuseRisk,
} from "./abuse-detection.rules";
import {
  AbuseActorContext,
  AbuseAssessmentResult,
  AbuseBehavioralWindowState,
  AbuseDetectionMetricsSnapshot,
  AbuseDetectionMode,
  AbuseDetectionThresholds,
  AbuseDisposition,
  AbuseReviewRecord,
  AbuseReviewStatus,
  AbuseRiskLevel,
  AbuseSignalCode,
  HighImpactOperationInput,
  HighImpactOperationKind,
} from "./abuse-detection.types";
import { EvaluateAbuseRiskDto } from "./dto/abuse-detection.dto";

interface ActorWindowBucket {
  operationTimestampsMs: number[];
  destinationHistory: Array<{ destination: string; timestampMs: number }>;
  failedAttemptTimestampsMs: number[];
}

const MAX_TRACKED_ACTORS = 5_000;
const REVIEW_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

@Injectable()
export class AbuseDetectionService {
  private readonly logger = new Logger(AbuseDetectionService.name);
  private readonly actorWindows = new Map<string, ActorWindowBucket>();
  private readonly reviews = new Map<string, AbuseReviewRecord>();
  private readonly approvalTokens = new Map<
    string,
    { reviewId: string; actorId: string; operationDigest: string; expiresAtMs: number }
  >();
  private lastEvaluatedAtMs?: number;

  private totalAssessments = 0;
  private shadowWouldHaveBlockedOrChallenged = 0;
  private readonly byDisposition: Record<AbuseDisposition, number> = {
    allow: 0,
    allow_after_step_up: 0,
    allow_after_review: 0,
    step_up_required: 0,
    manual_review: 0,
    block: 0,
  };
  private readonly byRiskLevel: Record<AbuseRiskLevel, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  private readonly byOperationKind: Partial<
    Record<HighImpactOperationKind, number>
  > = {};
  private readonly bySignalCode: Partial<Record<AbuseSignalCode, number>> = {};

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  /**
   * Transport-friendly helper that maps an `EvaluateAbuseRiskDto` + request principal
   * into an `AbuseAssessmentResult`.
   */
  evaluateDto(
    dto: EvaluateAbuseRiskDto,
    principal?: Partial<AbuseActorContext>,
  ): AbuseAssessmentResult {
    const actor: AbuseActorContext = {
      actorId: principal?.actorId ?? "anonymous",
      actorRole: principal?.actorRole,
      tenantId: principal?.tenantId,
      sessionId: principal?.sessionId,
      ipAddress: principal?.ipAddress,
      userAgent: principal?.userAgent,
      deviceFingerprint: dto.deviceFingerprint ?? principal?.deviceFingerprint,
      accountAgeDays: dto.accountAgeDays ?? principal?.accountAgeDays,
      mfaEnabled: dto.mfaEnabled ?? principal?.mfaEnabled,
      stepUpVerified: dto.stepUpVerified ?? principal?.stepUpVerified,
      stepUpMethod: principal?.stepUpMethod,
      isImpersonated: principal?.isImpersonated,
      impersonatorId: principal?.impersonatorId,
      minutesSinceLastCredentialChange:
        dto.minutesSinceLastCredentialChange ??
        principal?.minutesSinceLastCredentialChange,
      knownDevicesOrIps: dto.knownDevicesOrIps ?? principal?.knownDevicesOrIps,
      verifiedDestinations:
        dto.verifiedDestinations ?? principal?.verifiedDestinations,
      reviewApprovalToken:
        dto.reviewApprovalToken ?? principal?.reviewApprovalToken,
    };

    const operation: HighImpactOperationInput = {
      kind: dto.kind,
      amount: dto.amount,
      historicalAverageAmount: dto.historicalAverageAmount,
      asset: dto.asset,
      destination: dto.destination,
      portfolioId: dto.portfolioId,
      adapterId: dto.adapterId,
      portfolioExitFraction: dto.portfolioExitFraction,
      slippageBps: dto.slippageBps,
      adapterVerified: dto.adapterVerified,
      recordOrRecipientCount: dto.recordOrRecipientCount,
      counterpartyFlagged: dto.counterpartyFlagged,
      idempotencyKey: dto.idempotencyKey,
      asOf: dto.asOf,
    };

    return this.evaluateOperation(operation, actor);
  }

  /**
   * Evaluates a high-impact operation for abuse risk, updates sliding-window state,
   * queues manual review records when needed, and emits telemetry/events.
   */
  evaluateOperation(
    operation: HighImpactOperationInput,
    actor: AbuseActorContext,
    overrideThresholds?: Partial<AbuseDetectionThresholds>,
  ): AbuseAssessmentResult {
    const thresholds = {
      ...this.resolveThresholds(),
      ...overrideThresholds,
    };
    const asOf = operation.asOf ?? new Date().toISOString();
    const nowMs = this.parseTimestampMs(asOf);
    this.lastEvaluatedAtMs = nowMs;

    const windowState = this.getBehavioralWindowState(
      actor.actorId,
      thresholds.velocityWindowSeconds,
      nowMs,
    );

    const operationDigest = computeOperationDigest(operation, actor.actorId);
    const reviewApproved = this.consumeApprovalTokenIfValid(
      actor.reviewApprovalToken,
      actor.actorId,
      operationDigest,
      nowMs,
    );

    const assessment = evaluateAbuseRisk({
      operation,
      actor,
      windowState,
      thresholds,
      asOf,
      reviewApproved,
    });

    // Record this attempt into the actor's sliding window
    this.recordOperationAttempt(
      actor.actorId,
      operation.destination,
      thresholds.velocityWindowSeconds,
      nowMs,
    );

    // If disposition is manual_review, create or attach a review record
    if (assessment.disposition === "manual_review") {
      const review = this.enqueueReview(assessment, nowMs);
      assessment.reviewId = review.reviewId;
    }

    this.recordTelemetry(assessment);
    this.emitDomainEvents(assessment);

    return assessment;
  }

  /**
   * Enforces the assessment disposition.
   * Throws a typed `AbuseDetectionException` subclass when `assessment.allowed` is false.
   */
  assertProceedable(
    assessment: AbuseAssessmentResult,
  ): AbuseAssessmentResult {
    if (assessment.allowed) {
      return assessment;
    }

    switch (assessment.disposition) {
      case "step_up_required":
        throw new AbuseStepUpRequiredException(assessment);
      case "manual_review":
        throw new AbuseManualReviewRequiredException(assessment);
      case "block":
      default:
        throw new AbuseOperationBlockedException(assessment);
    }
  }

  /**
   * Records a failed authentication, preflight, or verification attempt for the actor.
   * Feeds into the `REPEATED_FAILED_ATTEMPTS` signal on subsequent high-impact operations.
   */
  recordFailedAttempt(actorId: string, asOf?: string): void {
    const nowMs = this.parseTimestampMs(asOf ?? new Date().toISOString());
    const thresholds = this.resolveThresholds();
    const bucket = this.getOrCreateBucket(actorId);
    const cutoffMs = nowMs - thresholds.velocityWindowSeconds * 1000;
    bucket.failedAttemptTimestampsMs = bucket.failedAttemptTimestampsMs.filter(
      (ts) => ts >= cutoffMs,
    );
    bucket.failedAttemptTimestampsMs.push(nowMs);
  }

  /** Returns the current sliding-window behavioral state for an actor. */
  getBehavioralWindowState(
    actorId: string,
    windowSeconds: number = DEFAULT_ABUSE_THRESHOLDS.velocityWindowSeconds,
    nowMs: number = Date.now(),
  ): AbuseBehavioralWindowState {
    const bucket = this.actorWindows.get(actorId);
    if (!bucket) {
      return {
        recentOperationCount: 0,
        recentDistinctDestinations: [],
        recentFailedAttempts: 0,
      };
    }

    const cutoffMs = nowMs - windowSeconds * 1000;
    bucket.operationTimestampsMs = bucket.operationTimestampsMs.filter(
      (ts) => ts >= cutoffMs,
    );
    bucket.destinationHistory = bucket.destinationHistory.filter(
      (entry) => entry.timestampMs >= cutoffMs,
    );
    bucket.failedAttemptTimestampsMs = bucket.failedAttemptTimestampsMs.filter(
      (ts) => ts >= cutoffMs,
    );

    const distinctDestinations = Array.from(
      new Set(bucket.destinationHistory.map((d) => d.destination)),
    );

    return {
      recentOperationCount: bucket.operationTimestampsMs.length,
      recentDistinctDestinations: distinctDestinations,
      recentFailedAttempts: bucket.failedAttemptTimestampsMs.length,
    };
  }

  /** Clears sliding-window behavioral state for a specific actor (used for operator reset / recovery). */
  resetActorWindowState(actorId: string): void {
    this.actorWindows.delete(actorId);
    this.logger.log(`Reset behavioral abuse window state for actor=${actorId}`);
  }

  /** Lists queued or resolved manual review records. */
  listReviews(filter?: {
    status?: AbuseReviewStatus;
    actorId?: string;
    asOf?: string;
  }): AbuseReviewRecord[] {
    const nowMs = filter?.asOf
      ? this.parseTimestampMs(filter.asOf)
      : (this.lastEvaluatedAtMs ?? Date.now());
    this.expireStaleReviews(nowMs);
    const all = Array.from(this.reviews.values());
    return all
      .filter((r) => {
        if (filter?.status && r.status !== filter.status) return false;
        if (filter?.actorId && r.actorId !== filter.actorId) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Retrieves a single review record by ID. */
  getReview(reviewId: string, asOf?: string): AbuseReviewRecord {
    const nowMs = asOf
      ? this.parseTimestampMs(asOf)
      : (this.lastEvaluatedAtMs ?? Date.now());
    this.expireStaleReviews(nowMs);
    const review = this.reviews.get(reviewId);
    if (!review) {
      throw new NotFoundException(`Abuse review record ${reviewId} not found`);
    }
    return review;
  }

  /**
   * Resolves a pending manual review item (`approved` or `rejected`).
   * Requires a non-empty audit reason. When approved, generates a single-use
   * `approvalToken` bound to the actor and operation digest.
   */
  resolveReview(
    reviewId: string,
    decision: "approved" | "rejected",
    operatorId: string,
    reason: string,
    asOf?: string,
  ): AbuseReviewRecord {
    const trimmedReason = reason?.trim() ?? "";
    if (trimmedReason.length < 10) {
      throw new BadRequestException(
        "A detailed resolution reason (at least 10 characters) is required for audit compliance.",
      );
    }

    const nowIso =
      asOf ??
      (this.lastEvaluatedAtMs
        ? new Date(this.lastEvaluatedAtMs).toISOString()
        : new Date().toISOString());
    const nowMs = this.parseTimestampMs(nowIso);
    this.expireStaleReviews(nowMs);

    const review = this.reviews.get(reviewId);
    if (!review) {
      throw new NotFoundException(`Abuse review record ${reviewId} not found`);
    }

    if (review.status !== "pending") {
      throw new BadRequestException(
        `Abuse review ${reviewId} cannot be resolved because its current status is '${review.status}'.`,
      );
    }

    review.status = decision;
    review.resolvedAt = nowIso;
    review.resolvedBy = operatorId;
    review.resolutionReason = trimmedReason;

    if (decision === "approved") {
      const token = `rat_${randomBytes(12).toString("hex")}`;
      review.approvalToken = token;
      this.approvalTokens.set(token, {
        reviewId: review.reviewId,
        actorId: review.actorId,
        operationDigest: review.operationDigest,
        expiresAtMs: nowMs + REVIEW_TTL_MS,
      });
    }

    this.eventEmitter?.emit(ABUSE_EVENTS.REVIEW_RESOLVED, {
      reviewId: review.reviewId,
      assessmentId: review.assessmentId,
      actorId: review.actorId,
      operationKind: review.operationKind,
      decision,
      operatorId,
      resolvedAt: nowIso,
    });

    this.logger.log(
      `Abuse review ${reviewId} resolved status=${decision} by=${operatorId}`,
    );

    return { ...review };
  }

  /** Returns a structured telemetry snapshot for observability dashboards. */
  getMetricsSnapshot(asOf?: string): AbuseDetectionMetricsSnapshot {
    const nowMs = asOf
      ? this.parseTimestampMs(asOf)
      : (this.lastEvaluatedAtMs ?? Date.now());
    this.expireStaleReviews(nowMs);
    const reviews = Array.from(this.reviews.values());

    return {
      mode: this.resolveThresholds().mode,
      totalAssessments: this.totalAssessments,
      byDisposition: { ...this.byDisposition },
      byRiskLevel: { ...this.byRiskLevel },
      byOperationKind: { ...this.byOperationKind },
      bySignalCode: { ...this.bySignalCode },
      pendingReviews: reviews.filter((r) => r.status === "pending").length,
      approvedReviews: reviews.filter((r) => r.status === "approved").length,
      rejectedReviews: reviews.filter((r) => r.status === "rejected").length,
      shadowWouldHaveBlockedOrChallenged:
        this.shadowWouldHaveBlockedOrChallenged,
    };
  }

  /** Resolves thresholds and mode from ConfigService with safe fallback validation. */
  resolveThresholds(): AbuseDetectionThresholds {
    const modeRaw = this.readString(
      ABUSE_DETECTION_MODE_ENV,
      DEFAULT_ABUSE_THRESHOLDS.mode,
    ).toLowerCase();
    const mode: AbuseDetectionMode =
      modeRaw === "shadow" || modeRaw === "disabled" || modeRaw === "enforce"
        ? modeRaw
        : DEFAULT_ABUSE_THRESHOLDS.mode;

    let stepUpScoreThreshold = this.readPositiveNumber(
      ABUSE_STEP_UP_THRESHOLD_ENV,
      DEFAULT_ABUSE_THRESHOLDS.stepUpScoreThreshold,
    );
    let manualReviewScoreThreshold = this.readPositiveNumber(
      ABUSE_MANUAL_REVIEW_THRESHOLD_ENV,
      DEFAULT_ABUSE_THRESHOLDS.manualReviewScoreThreshold,
    );
    let blockScoreThreshold = this.readPositiveNumber(
      ABUSE_BLOCK_THRESHOLD_ENV,
      DEFAULT_ABUSE_THRESHOLDS.blockScoreThreshold,
    );

    // Enforce monotonic threshold ordering; fall back to defaults if inverted
    if (
      !(
        stepUpScoreThreshold < manualReviewScoreThreshold &&
        manualReviewScoreThreshold < blockScoreThreshold &&
        blockScoreThreshold <= 100
      )
    ) {
      stepUpScoreThreshold = DEFAULT_ABUSE_THRESHOLDS.stepUpScoreThreshold;
      manualReviewScoreThreshold =
        DEFAULT_ABUSE_THRESHOLDS.manualReviewScoreThreshold;
      blockScoreThreshold = DEFAULT_ABUSE_THRESHOLDS.blockScoreThreshold;
    }

    return {
      mode,
      stepUpScoreThreshold,
      manualReviewScoreThreshold,
      blockScoreThreshold,
      velocityWindowSeconds: this.readPositiveNumber(
        ABUSE_VELOCITY_WINDOW_SECONDS_ENV,
        DEFAULT_ABUSE_THRESHOLDS.velocityWindowSeconds,
      ),
      maxOperationsPerWindow: this.readPositiveNumber(
        ABUSE_MAX_OPS_PER_WINDOW_ENV,
        DEFAULT_ABUSE_THRESHOLDS.maxOperationsPerWindow,
      ),
      highValueAmountThreshold: this.readPositiveNumber(
        ABUSE_HIGH_VALUE_AMOUNT_ENV,
        DEFAULT_ABUSE_THRESHOLDS.highValueAmountThreshold,
      ),
      amountSpikeMultiplier: this.readPositiveNumber(
        ABUSE_AMOUNT_SPIKE_MULTIPLIER_ENV,
        DEFAULT_ABUSE_THRESHOLDS.amountSpikeMultiplier,
      ),
      maxDistinctDestinationsPerWindow: this.readPositiveNumber(
        ABUSE_MAX_DESTINATIONS_PER_WINDOW_ENV,
        DEFAULT_ABUSE_THRESHOLDS.maxDistinctDestinationsPerWindow,
      ),
      credentialCoolingPeriodMinutes: this.readPositiveNumber(
        ABUSE_CREDENTIAL_COOLING_MINUTES_ENV,
        DEFAULT_ABUSE_THRESHOLDS.credentialCoolingPeriodMinutes,
      ),
      highSlippageBpsThreshold: this.readPositiveNumber(
        ABUSE_HIGH_SLIPPAGE_BPS_ENV,
        DEFAULT_ABUSE_THRESHOLDS.highSlippageBpsThreshold,
      ),
      maxFailedAttemptsPerWindow: this.readPositiveNumber(
        ABUSE_MAX_FAILED_ATTEMPTS_ENV,
        DEFAULT_ABUSE_THRESHOLDS.maxFailedAttemptsPerWindow,
      ),
      bulkRecordThreshold: this.readPositiveNumber(
        ABUSE_BULK_RECORD_THRESHOLD_ENV,
        DEFAULT_ABUSE_THRESHOLDS.bulkRecordThreshold,
      ),
    };
  }

  private recordOperationAttempt(
    actorId: string,
    destination: string | undefined,
    windowSeconds: number,
    nowMs: number,
  ): void {
    const bucket = this.getOrCreateBucket(actorId);
    const cutoffMs = nowMs - windowSeconds * 1000;
    bucket.operationTimestampsMs = bucket.operationTimestampsMs.filter(
      (ts) => ts >= cutoffMs,
    );
    bucket.operationTimestampsMs.push(nowMs);

    if (destination && destination.trim()) {
      bucket.destinationHistory = bucket.destinationHistory.filter(
        (d) => d.timestampMs >= cutoffMs,
      );
      bucket.destinationHistory.push({
        destination: destination.trim().toLowerCase(),
        timestampMs: nowMs,
      });
    }
  }

  private getOrCreateBucket(actorId: string): ActorWindowBucket {
    let bucket = this.actorWindows.get(actorId);
    if (!bucket) {
      if (this.actorWindows.size >= MAX_TRACKED_ACTORS) {
        const oldestKey = this.actorWindows.keys().next().value;
        if (oldestKey !== undefined) {
          this.actorWindows.delete(oldestKey);
        }
      }
      bucket = {
        operationTimestampsMs: [],
        destinationHistory: [],
        failedAttemptTimestampsMs: [],
      };
      this.actorWindows.set(actorId, bucket);
    }
    return bucket;
  }

  private enqueueReview(
    assessment: AbuseAssessmentResult,
    nowMs: number,
  ): AbuseReviewRecord {
    const reviewHash = createHash("sha256")
      .update(`${assessment.actorId}:${assessment.operationDigest}`)
      .digest("hex")
      .slice(0, 16);
    const reviewId = `rv:${assessment.operationKind}:${reviewHash}`;

    const existing = this.reviews.get(reviewId);
    if (existing && existing.status === "pending") {
      return existing;
    }

    const record: AbuseReviewRecord = {
      reviewId,
      assessmentId: assessment.assessmentId,
      actorId: assessment.actorId,
      operationKind: assessment.operationKind,
      operationDigest: assessment.operationDigest,
      score: assessment.score,
      riskLevel: assessment.riskLevel,
      signals: assessment.signals,
      status: "pending",
      createdAt: assessment.evaluatedAt,
      expiresAt: new Date(nowMs + REVIEW_TTL_MS).toISOString(),
    };

    this.reviews.set(reviewId, record);
    return record;
  }

  private consumeApprovalTokenIfValid(
    token: string | undefined,
    actorId: string,
    operationDigest: string,
    nowMs: number,
  ): boolean {
    if (!token || typeof token !== "string") return false;
    const entry = this.approvalTokens.get(token.trim());
    if (!entry) return false;

    if (nowMs > entry.expiresAtMs) {
      this.approvalTokens.delete(token.trim());
      return false;
    }

    if (
      entry.actorId !== actorId ||
      entry.operationDigest !== operationDigest
    ) {
      return false;
    }

    // Single-use token: consume on match
    this.approvalTokens.delete(token.trim());
    return true;
  }

  private expireStaleReviews(nowMs: number): void {
    for (const review of this.reviews.values()) {
      if (review.status === "pending") {
        const expMs = Date.parse(review.expiresAt);
        if (Number.isFinite(expMs) && nowMs > expMs) {
          review.status = "expired";
        }
      }
    }
  }

  private recordTelemetry(assessment: AbuseAssessmentResult): void {
    this.totalAssessments += 1;
    this.byDisposition[assessment.disposition] =
      (this.byDisposition[assessment.disposition] ?? 0) + 1;
    this.byRiskLevel[assessment.riskLevel] =
      (this.byRiskLevel[assessment.riskLevel] ?? 0) + 1;
    this.byOperationKind[assessment.operationKind] =
      (this.byOperationKind[assessment.operationKind] ?? 0) + 1;

    for (const signal of assessment.signals) {
      this.bySignalCode[signal.code] =
        (this.bySignalCode[signal.code] ?? 0) + 1;
    }

    if (
      assessment.mode === "shadow" &&
      (assessment.disposition === "step_up_required" ||
        assessment.disposition === "manual_review" ||
        assessment.disposition === "block")
    ) {
      this.shadowWouldHaveBlockedOrChallenged += 1;
    }
  }

  private emitDomainEvents(assessment: AbuseAssessmentResult): void {
    const payload = {
      assessmentId: assessment.assessmentId,
      actorId: assessment.actorId,
      operationKind: assessment.operationKind,
      score: assessment.score,
      riskLevel: assessment.riskLevel,
      disposition: assessment.disposition,
      mode: assessment.mode,
      allowed: assessment.allowed,
      reviewId: assessment.reviewId,
      signalCodes: assessment.signals.map((s) => s.code),
      evaluatedAt: assessment.evaluatedAt,
    };

    this.eventEmitter?.emit(ABUSE_EVENTS.ASSESSMENT_COMPLETED, payload);

    if (assessment.disposition === "step_up_required") {
      this.eventEmitter?.emit(ABUSE_EVENTS.STEP_UP_REQUIRED, payload);
    } else if (assessment.disposition === "manual_review") {
      this.eventEmitter?.emit(ABUSE_EVENTS.REVIEW_QUEUED, payload);
    } else if (assessment.disposition === "block") {
      this.eventEmitter?.emit(ABUSE_EVENTS.OPERATION_BLOCKED, payload);
    }
  }

  private parseTimestampMs(iso: string): number {
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  private readString(key: string, fallback: string): string {
    const raw = this.configService?.get<string>(key);
    return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  }

  private readPositiveNumber(key: string, fallback: number): number {
    const raw = Number(this.configService?.get(key));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }
}

import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { Role, normalizeRole } from "../../common/guard/roles.enum";

export enum ReferralRewardStatus {
  PENDING = "pending",
  UNLOCKED = "unlocked",
  AWARDED = "awarded",
  CLAWBACK_INITIATED = "clawback_initiated",
  CLAWED_BACK = "clawed_back",
  CLAWBACK_DISPUTED = "clawback_disputed",
  CLAWBACK_REVERSED = "clawback_reversed",
  CLAWBACK_FAILED = "clawback_failed",
}

export enum ClawbackReason {
  FRAUD_SYBIL = "fraud_sybil",
  CHARGEBACK = "chargeback",
  DEPOSIT_REFUND = "deposit_refund",
  SELF_REFERRAL = "self_referral",
  POLICY_VIOLATION = "policy_violation",
  ADMIN_DISCRETION = "admin_discretion",
}

export interface ReferralAttributionContext {
  referralId: string;
  referringUserId: string;
  referredUserId: string;
  referralCode: string;
  clickTimestamp: Date;
  registeredAt: Date;
  metadata?: Record<string, unknown>;
}

export interface AttributionValidationResult {
  valid: boolean;
  reason?: string;
  code?: "VALID" | "CLOCK_SKEW_FUTURE_CLICK" | "ATTRIBUTION_WINDOW_EXPIRED";
  attributionDurationMs: number;
  remainingWindowMs: number;
  windowExpiresAt: Date;
}

export interface QualificationValidationResult {
  valid: boolean;
  reason?: string;
  code?: "VALID" | "INVALID_SEQUENCE" | "QUALIFICATION_WINDOW_EXPIRED";
  qualificationDurationMs: number;
  remainingWindowMs: number;
  windowExpiresAt: Date;
}

export interface ReferralRewardRecord {
  referralId: string;
  referringUserId: string;
  referredUserId: string;
  rewardAmount: number;
  currency: string;
  status: ReferralRewardStatus;
  awardedAt?: Date | null;
  clawbackRecord?: ClawbackRecord | null;
  history: Array<{ status: ReferralRewardStatus; timestamp: Date; detail?: string }>;
}

export interface ClawbackRecord {
  clawbackId: string;
  referralId: string;
  amount: number;
  currency: string;
  reason: ClawbackReason;
  detail: string;
  initiatedBy: string;
  initiatedAt: Date;
  completedAt?: Date | null;
  attempts: number;
  lastError?: string | null;
}

export interface GrowthActorContext {
  id: string;
  roles: string[];
}

export interface ReferralAttributionConfig {
  attributionWindowMs?: number; // default 30 days
  qualificationWindowMs?: number; // default 14 days
  clawbackWindowMs?: number; // default 90 days
  clockSkewToleranceMs?: number; // default 5 minutes
}

const DEFAULT_ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_QUALIFICATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const DEFAULT_CLAWBACK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class ReferralAttributionService {
  private readonly logger = new Logger(ReferralAttributionService.name);
  private readonly attributionWindowMs: number;
  private readonly qualificationWindowMs: number;
  private readonly clawbackWindowMs: number;
  private readonly clockSkewToleranceMs: number;

  /** In-memory ledger of referral rewards */
  private readonly rewards = new Map<string, ReferralRewardRecord>();

  constructor(config?: ReferralAttributionConfig) {
    this.attributionWindowMs =
      config?.attributionWindowMs ?? DEFAULT_ATTRIBUTION_WINDOW_MS;
    this.qualificationWindowMs =
      config?.qualificationWindowMs ?? DEFAULT_QUALIFICATION_WINDOW_MS;
    this.clawbackWindowMs =
      config?.clawbackWindowMs ?? DEFAULT_CLAWBACK_WINDOW_MS;
    this.clockSkewToleranceMs =
      config?.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
  }

  // =========================================================================
  // 1. Attribution Window Verifier
  // =========================================================================

  /**
   * Verifies whether a signup registration occurred within the valid attribution window
   * after the initial referral click / link presentation.
   */
  verifyAttributionWindow(
    ctx: ReferralAttributionContext,
  ): AttributionValidationResult {
    const clickTime = ctx.clickTimestamp.getTime();
    const regTime = ctx.registeredAt.getTime();
    const duration = regTime - clickTime;
    const windowExpiresAt = new Date(clickTime + this.attributionWindowMs);

    // Guard against future click timestamps / excessive clock skew
    if (duration < -this.clockSkewToleranceMs) {
      return {
        valid: false,
        code: "CLOCK_SKEW_FUTURE_CLICK",
        reason: `Click timestamp (${ctx.clickTimestamp.toISOString()}) is ahead of registration timestamp (${ctx.registeredAt.toISOString()})`,
        attributionDurationMs: duration,
        remainingWindowMs: 0,
        windowExpiresAt,
      };
    }

    // Check expiration
    if (duration > this.attributionWindowMs) {
      return {
        valid: false,
        code: "ATTRIBUTION_WINDOW_EXPIRED",
        reason: `Registration exceeded the ${Math.round(
          this.attributionWindowMs / (24 * 60 * 60 * 1000),
        )}-day referral attribution window by ${Math.round(
          (duration - this.attributionWindowMs) / (24 * 60 * 60 * 1000),
        )} days`,
        attributionDurationMs: duration,
        remainingWindowMs: 0,
        windowExpiresAt,
      };
    }

    const remaining = Math.max(0, this.attributionWindowMs - duration);
    return {
      valid: true,
      code: "VALID",
      attributionDurationMs: Math.max(0, duration),
      remainingWindowMs: remaining,
      windowExpiresAt,
    };
  }

  /**
   * Verifies whether the referred user completed the qualifying action within the
   * required qualification window after account registration.
   */
  verifyQualificationWindow(
    registeredAt: Date,
    qualifiedAt: Date,
  ): QualificationValidationResult {
    const regTime = registeredAt.getTime();
    const qualTime = qualifiedAt.getTime();
    const duration = qualTime - regTime;
    const windowExpiresAt = new Date(regTime + this.qualificationWindowMs);

    if (duration < 0) {
      return {
        valid: false,
        code: "INVALID_SEQUENCE",
        reason: "Qualification timestamp is prior to registration timestamp",
        qualificationDurationMs: duration,
        remainingWindowMs: 0,
        windowExpiresAt,
      };
    }

    if (duration > this.qualificationWindowMs) {
      return {
        valid: false,
        code: "QUALIFICATION_WINDOW_EXPIRED",
        reason: `Qualification took ${Math.round(
          duration / (24 * 60 * 60 * 1000),
        )} days, exceeding the allowed ${Math.round(
          this.qualificationWindowMs / (24 * 60 * 60 * 1000),
        )}-day window`,
        qualificationDurationMs: duration,
        remainingWindowMs: 0,
        windowExpiresAt,
      };
    }

    const remaining = Math.max(0, this.qualificationWindowMs - duration);
    return {
      valid: true,
      code: "VALID",
      qualificationDurationMs: duration,
      remainingWindowMs: remaining,
      windowExpiresAt,
    };
  }

  // =========================================================================
  // 2. Reward Management & Clawback Guard
  // =========================================================================

  /**
   * Registers an awarded referral reward into the attribution tracking ledger.
   */
  recordAwardedReward(
    referralId: string,
    referringUserId: string,
    referredUserId: string,
    rewardAmount: number,
    currency = "XLM",
    awardedAt = new Date(),
  ): ReferralRewardRecord {
    const existing = this.rewards.get(referralId);
    if (existing && existing.status === ReferralRewardStatus.AWARDED) {
      return existing;
    }

    const record: ReferralRewardRecord = {
      referralId,
      referringUserId,
      referredUserId,
      rewardAmount,
      currency,
      status: ReferralRewardStatus.AWARDED,
      awardedAt,
      clawbackRecord: null,
      history: [
        {
          status: ReferralRewardStatus.AWARDED,
          timestamp: awardedAt,
          detail: `Reward granted: ${rewardAmount} ${currency}`,
        },
      ],
    };
    this.rewards.set(referralId, record);
    return record;
  }

  /**
   * Initiates a clawback on an awarded referral reward.
   *
   * Invariants enforced:
   * 1. Authorization: Requires ADMIN or GROWTH_LEAD role.
   * 2. Double-Clawback Prevention: Idempotent if already clawed back.
   * 3. Clawback Window: Disallows clawbacks older than clawbackWindowMs unless forceOverride is true.
   * 4. Failure/Retry Handling: Handles simulated recovery failure cleanly.
   */
  async initiateClawback(
    referralId: string,
    reason: ClawbackReason,
    actor: GrowthActorContext,
    options?: {
      detail?: string;
      forceOverride?: boolean;
      simulateLedgerFailure?: boolean;
    },
  ): Promise<ReferralRewardRecord> {
    this.assertAuthorizedGrowthActor(actor);

    const record = this.rewards.get(referralId);
    if (!record) {
      throw new BadRequestException(
        `Referral reward "${referralId}" not found`,
      );
    }

    // Idempotency: If already clawed back, return existing record
    if (record.status === ReferralRewardStatus.CLAWED_BACK) {
      this.logger.log(
        `Clawback for "${referralId}" already finalized -- returning existing record idempotently`,
      );
      return record;
    }

    // Disallow clawback on pending or already reversed status without re-grant
    if (
      record.status !== ReferralRewardStatus.AWARDED &&
      record.status !== ReferralRewardStatus.CLAWBACK_FAILED &&
      record.status !== ReferralRewardStatus.CLAWBACK_INITIATED
    ) {
      throw new ConflictException(
        `Cannot claw back referral "${referralId}" with current status "${record.status}"`,
      );
    }

    // Check clawback window expiration (default 90 days from grant)
    const now = Date.now();
    const grantTime = record.awardedAt ? record.awardedAt.getTime() : now;
    const elapsed = now - grantTime;

    if (elapsed > this.clawbackWindowMs && !options?.forceOverride) {
      throw new BadRequestException(
        `Clawback window expired (${Math.round(
          elapsed / (24 * 60 * 60 * 1000),
        )} days since award exceeds ${Math.round(
          this.clawbackWindowMs / (24 * 60 * 60 * 1000),
        )}-day limit). Operator override required.`,
      );
    }

    const clawbackId = `clw:${referralId}:${Date.now()}`;
    const clawback: ClawbackRecord = {
      clawbackId,
      referralId,
      amount: record.rewardAmount,
      currency: record.currency,
      reason,
      detail: options?.detail || `Clawed back due to ${reason}`,
      initiatedBy: actor.id,
      initiatedAt: new Date(),
      attempts: (record.clawbackRecord?.attempts ?? 0) + 1,
    };

    record.status = ReferralRewardStatus.CLAWBACK_INITIATED;
    record.clawbackRecord = clawback;

    // Simulate recovery execution (e.g. on-chain wallet balance deduction / escrow reclaim)
    if (options?.simulateLedgerFailure) {
      record.status = ReferralRewardStatus.CLAWBACK_FAILED;
      clawback.lastError = "Ledger transaction failure: timeout or insufficient unencumbered funds";
      record.history.push({
        status: ReferralRewardStatus.CLAWBACK_FAILED,
        timestamp: new Date(),
        detail: clawback.lastError,
      });
      this.logger.error(
        `Clawback execution failed for "${referralId}": ${clawback.lastError}`,
      );
      return record;
    }

    // Successful execution
    clawback.completedAt = new Date();
    record.status = ReferralRewardStatus.CLAWED_BACK;
    record.history.push({
      status: ReferralRewardStatus.CLAWED_BACK,
      timestamp: new Date(),
      detail: `Clawed back ${record.rewardAmount} ${record.currency} by ${actor.id} (${reason})`,
    });

    this.logger.log(
      `Referral "${referralId}" successfully clawed back: ${record.rewardAmount} ${record.currency}`,
    );
    return record;
  }

  /**
   * Retries a previously failed clawback attempt.
   */
  async retryClawback(
    referralId: string,
    actor: GrowthActorContext,
  ): Promise<ReferralRewardRecord> {
    this.assertAuthorizedGrowthActor(actor);
    const record = this.rewards.get(referralId);
    if (!record || !record.clawbackRecord) {
      throw new BadRequestException(
        `No clawback record found to retry for "${referralId}"`,
      );
    }

    if (record.status !== ReferralRewardStatus.CLAWBACK_FAILED) {
      throw new ConflictException(
        `Referral "${referralId}" is not in failed clawback state (current: ${record.status})`,
      );
    }

    return this.initiateClawback(
      referralId,
      record.clawbackRecord.reason,
      actor,
      { detail: "Retry of failed clawback", forceOverride: true },
    );
  }

  /**
   * Reverses a clawback, restoring the award (rollback/dispute resolution path).
   * Requires ADMIN or GROWTH_LEAD role.
   */
  async reverseClawback(
    referralId: string,
    actor: GrowthActorContext,
    reason = "Dispute resolution favor of user",
  ): Promise<ReferralRewardRecord> {
    this.assertAuthorizedGrowthActor(actor);
    const record = this.rewards.get(referralId);
    if (!record) {
      throw new BadRequestException(`Referral "${referralId}" not found`);
    }

    if (
      record.status !== ReferralRewardStatus.CLAWED_BACK &&
      record.status !== ReferralRewardStatus.CLAWBACK_DISPUTED
    ) {
      throw new ConflictException(
        `Cannot reverse clawback for referral "${referralId}" in status "${record.status}"`,
      );
    }

    record.status = ReferralRewardStatus.CLAWBACK_REVERSED;
    record.history.push({
      status: ReferralRewardStatus.CLAWBACK_REVERSED,
      timestamp: new Date(),
      detail: `Clawback reversed by ${actor.id}: ${reason}`,
    });

    this.logger.log(
      `Clawback for "${referralId}" reversed by ${actor.id}. Reason: ${reason}`,
    );
    return record;
  }

  getReward(referralId: string): ReferralRewardRecord | undefined {
    return this.rewards.get(referralId);
  }

  listRewards(): ReferralRewardRecord[] {
    return Array.from(this.rewards.values());
  }

  private assertAuthorizedGrowthActor(actor: GrowthActorContext): void {
    if (!actor || !actor.roles || !Array.isArray(actor.roles)) {
      throw new ForbiddenException("Missing actor or roles for growth operation");
    }
    const roles = actor.roles.map((r) => normalizeRole(r));
    const isAuthorized =
      roles.includes(Role.ADMIN) ||
      roles.some((r) => r.toUpperCase() === "GROWTH_LEAD");
    if (!isAuthorized) {
      throw new ForbiddenException(
        "Only ADMIN or GROWTH_LEAD roles may manage referral clawbacks",
      );
    }
  }
}

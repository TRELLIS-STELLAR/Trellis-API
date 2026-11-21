import { Injectable, Logger } from "@nestjs/common";
import { RateLimiterService } from "./rate-limiter.service";
import { RateLimitPolicy, RateLimitStrategy } from "./interfaces";

/**
 * Tenant burst quota configuration
 */
export interface TenantBurstQuota {
  tenantId: string;
  maxBurstTokens: number;
  burstRefillRatePerSec: number;
  adaptiveWindow: number; // milliseconds for measuring load
  failureThreshold: number; // percentage of failed requests to trigger adaptation
}

/**
 * Adaptive token bucket state tracking per tenant
 */
interface AdaptiveState {
  tenantId: string;
  baseCapacity: number;
  currentCapacity: number;
  burstCapacity: number;
  failureCount: number;
  successCount: number;
  lastAdaptationTime: number;
  adaptiveLevel: number; // 0-100, reflects system load
  recoveryScheduled: boolean;
}

/**
 * Adaptive Token Bucket with Tenant Burst Quota Support
 *
 * This service extends rate limiting with:
 * - Adaptive token refill rates based on failure rates
 * - Per-tenant burst quota management
 * - Retry and recovery tracking
 * - Authorization-aware rate limiting
 */
@Injectable()
export class AdaptiveTokenBucketService {
  private readonly logger = new Logger(AdaptiveTokenBucketService.name);
  private readonly adaptiveStates = new Map<string, AdaptiveState>();
  private readonly tenantQuotas = new Map<string, TenantBurstQuota>();
  private readonly recoverySchedules = new Map<string, NodeJS.Timeout>();

  private readonly defaultAdaptiveWindow = 60_000; // 1 minute
  private readonly defaultFailureThreshold = 20; // 20%
  private readonly minCapacityPercentage = 0.5; // Don't reduce below 50%
  private readonly maxCapacityPercentage = 1.5; // Don't exceed 150%

  constructor(private readonly rateLimiter: RateLimiterService) {}

  /**
   * Register a tenant's burst quota configuration
   */
  registerTenantQuota(quota: TenantBurstQuota): void {
    this.tenantQuotas.set(quota.tenantId, quota);
    this.logger.debug(
      `Registered burst quota for tenant ${quota.tenantId}: max=${quota.maxBurstTokens} tokens`,
    );
  }

  /**
   * Get or initialize adaptive state for a tenant
   */
  private getAdaptiveState(
    tenantId: string,
    baseCapacity: number,
  ): AdaptiveState {
    if (!this.adaptiveStates.has(tenantId)) {
      this.adaptiveStates.set(tenantId, {
        tenantId,
        baseCapacity,
        currentCapacity: baseCapacity,
        burstCapacity: baseCapacity * 1.2,
        failureCount: 0,
        successCount: 0,
        lastAdaptationTime: Date.now(),
        adaptiveLevel: 0,
        recoveryScheduled: false,
      });
    }
    return this.adaptiveStates.get(tenantId)!;
  }

  /**
   * Consume tokens with adaptive rate limiting and burst quota support
   *
   * Paths covered:
   * - Normal: Enough tokens, request allowed
   * - Failure: Rate limit exceeded, retry information provided
   * - Retry: After failure, adaptive rates may change based on load
   * - Authorization: Different tenants get different burst quotas
   */
  async consumeAdaptive(
    key: string,
    tenantId: string,
    basePolicy: RateLimitPolicy,
    tracker: string,
    scope: string,
    tier: string,
    isRetry: boolean = false,
  ): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
    retryAfterMs?: number;
    adaptiveLevel?: number;
    burstUsed?: number;
    burstRemaining?: number;
    reason?: string;
  }> {
    // Get tenant burst quota configuration
    const quota = this.tenantQuotas.get(tenantId);
    if (!quota) {
      // Fall back to base rate limiter if no quota registered
      const baseDecision = await this.rateLimiter.consume(
        key,
        basePolicy,
        tracker,
        scope,
        tier,
      );
      return {
        allowed: baseDecision.allowed,
        remaining: baseDecision.remaining,
        resetAt: baseDecision.resetAt,
        retryAfterMs: baseDecision.retryAfterMs,
      };
    }

    // Get or initialize adaptive state
    const state = this.getAdaptiveState(tenantId, basePolicy.limit);

    // Check if we need to adapt based on recent failures
    this.evaluateAdaptation(state, quota);

    // Create adaptive policy based on current state
    const adaptivePolicy = this.buildAdaptivePolicy(
      basePolicy,
      state,
      quota,
      isRetry,
    );

    // Consume from base rate limiter with adaptive policy
    const decision = await this.rateLimiter.consume(
      key,
      adaptivePolicy,
      tracker,
      scope,
      tier,
    );

    // Track success/failure for adaptation
    if (decision.allowed) {
      state.successCount++;
    } else {
      state.failureCount++;
    }

    // Schedule recovery if failure rate is high
    if (
      !state.recoveryScheduled &&
      this.getFailureRate(state) > quota.failureThreshold
    ) {
      this.scheduleRecovery(state, quota);
    }

    return {
      allowed: decision.allowed,
      remaining: decision.remaining,
      resetAt: decision.resetAt,
      retryAfterMs: decision.retryAfterMs,
      adaptiveLevel: state.adaptiveLevel,
      burstUsed: adaptivePolicy.burst - state.burstCapacity,
      burstRemaining: state.burstCapacity,
      reason: !decision.allowed
        ? `Adaptive rate limit exceeded. Load level: ${state.adaptiveLevel}%`
        : undefined,
    };
  }

  /**
   * Evaluate if adaptation is needed based on failure rates
   */
  private evaluateAdaptation(
    state: AdaptiveState,
    quota: TenantBurstQuota,
  ): void {
    const now = Date.now();
    const timeSinceLastAdaptation = now - state.lastAdaptationTime;

    if (timeSinceLastAdaptation < quota.adaptiveWindow) {
      return; // Too soon to re-evaluate
    }

    const failureRate = this.getFailureRate(state);
    const loadPercentage = Math.min(
      100,
      Math.max(0, failureRate * 5), // Scale to 0-100
    );

    // Adjust capacity based on load
    if (failureRate > quota.failureThreshold / 100) {
      // High failure rate: reduce capacity
      const reductionFactor = Math.max(
        this.minCapacityPercentage,
        1 - failureRate / 10,
      );
      state.currentCapacity = state.baseCapacity * reductionFactor;
      state.adaptiveLevel = Math.ceil(loadPercentage);

      this.logger.warn(
        `Adaptive reduction for tenant ${state.tenantId}: ` +
          `failureRate=${(failureRate * 100).toFixed(1)}%, ` +
          `new capacity=${state.currentCapacity.toFixed(0)}`,
      );
    } else if (failureRate < quota.failureThreshold / 200) {
      // Low failure rate: gradually increase capacity
      const expansionFactor = Math.min(
        this.maxCapacityPercentage,
        1 + (quota.failureThreshold / 200 - failureRate) / 10,
      );
      state.currentCapacity = Math.min(
        state.baseCapacity * this.maxCapacityPercentage,
        state.currentCapacity * expansionFactor,
      );
      state.adaptiveLevel = Math.max(0, Math.ceil(loadPercentage - 10));

      this.logger.debug(
        `Adaptive expansion for tenant ${state.tenantId}: ` +
          `new capacity=${state.currentCapacity.toFixed(0)}`,
      );
    }

    // Update burst capacity proportionally
    state.burstCapacity = Math.min(
      quota.maxBurstTokens,
      state.currentCapacity * 1.2,
    );

    // Reset counters for next window
    state.successCount = 0;
    state.failureCount = 0;
    state.lastAdaptationTime = now;
  }

  /**
   * Build adaptive policy accounting for burst and load
   */
  private buildAdaptivePolicy(
    basePolicy: RateLimitPolicy,
    state: AdaptiveState,
    quota: TenantBurstQuota,
    isRetry: boolean,
  ): RateLimitPolicy {
    return {
      ...basePolicy,
      limit: Math.ceil(state.currentCapacity),
      burst: Math.min(quota.maxBurstTokens, state.burstCapacity),
      // On retry, allow some leniency if we're still adapting
      windowMs: isRetry
        ? Math.max(basePolicy.windowMs * 0.8, 10_000) // Faster retry window
        : basePolicy.windowMs,
    };
  }

  /**
   * Get current failure rate (0-1)
   */
  private getFailureRate(state: AdaptiveState): number {
    const total = state.failureCount + state.successCount;
    if (total === 0) return 0;
    return state.failureCount / total;
  }

  /**
   * Schedule recovery after high failure period
   */
  private scheduleRecovery(
    state: AdaptiveState,
    quota: TenantBurstQuota,
  ): void {
    state.recoveryScheduled = true;

    // Clear any existing recovery schedule
    const existing = this.recoverySchedules.get(state.tenantId);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule recovery after adaptive window
    const timeout = setTimeout(() => {
      state.failureCount = 0;
      state.successCount = 0;
      state.adaptiveLevel = Math.max(0, state.adaptiveLevel - 10);
      state.recoveryScheduled = false;

      this.logger.info(
        `Recovery cycle for tenant ${state.tenantId}: adaptive level reduced to ${state.adaptiveLevel}%`,
      );
    }, quota.adaptiveWindow * 2);

    this.recoverySchedules.set(state.tenantId, timeout);
  }

  /**
   * Get current adaptive state for a tenant (for monitoring/debugging)
   */
  getAdaptiveStateSnapshot(tenantId: string): AdaptiveState | undefined {
    return this.adaptiveStates.get(tenantId);
  }

  /**
   * Reset adaptive state for a tenant (for recovery operations)
   */
  resetAdaptiveState(tenantId: string): boolean {
    const state = this.adaptiveStates.get(tenantId);
    if (!state) return false;

    state.currentCapacity = state.baseCapacity;
    state.burstCapacity = state.baseCapacity * 1.2;
    state.failureCount = 0;
    state.successCount = 0;
    state.adaptiveLevel = 0;

    // Clear recovery schedule
    const timeout = this.recoverySchedules.get(tenantId);
    if (timeout) {
      clearTimeout(timeout);
      this.recoverySchedules.delete(tenantId);
    }
    state.recoveryScheduled = false;

    this.logger.info(`Adaptive state reset for tenant ${tenantId}`);
    return true;
  }

  /**
   * List all tenant adaptive states (for monitoring)
   */
  listAllAdaptiveStates(): AdaptiveState[] {
    return Array.from(this.adaptiveStates.values());
  }
}

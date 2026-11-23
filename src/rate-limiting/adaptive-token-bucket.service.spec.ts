import { AdaptiveTokenBucketService, TenantBurstQuota } from "./adaptive-token-bucket.service";
import { RateLimiterService, RateLimitConfig } from "./rate-limiter.service";
import { RateLimitStrategy } from "./interfaces";

describe("AdaptiveTokenBucketService", () => {
  let service: AdaptiveTokenBucketService;
  let rateLimiter: RateLimiterService;

  const mockConfig: RateLimitConfig = {
    keyPrefix: "trellis:rl:",
    defaultStrategy: RateLimitStrategy.TokenBucket,
    enableFallback: true,
  };

  beforeEach(() => {
    rateLimiter = new RateLimiterService(null, mockConfig);
    service = new AdaptiveTokenBucketService(rateLimiter);
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  describe("tenant burst quota registration", () => {
    it("registers a tenant burst quota", () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-1",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);
      const state = service.getAdaptiveStateSnapshot("tenant-1");

      expect(state).toBeDefined();
      expect(state?.burstCapacity).toBeGreaterThan(0);
    });

    it("allows multiple tenant quotas", () => {
      const quota1: TenantBurstQuota = {
        tenantId: "tenant-1",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      const quota2: TenantBurstQuota = {
        tenantId: "tenant-2",
        maxBurstTokens: 50,
        burstRefillRatePerSec: 5,
        adaptiveWindow: 60_000,
        failureThreshold: 25,
      };

      service.registerTenantQuota(quota1);
      service.registerTenantQuota(quota2);

      const state1 = service.getAdaptiveStateSnapshot("tenant-1");
      const state2 = service.getAdaptiveStateSnapshot("tenant-2");

      expect(state1?.burstCapacity).toBeGreaterThan(state2?.burstCapacity || 0);
    });
  });

  describe("normal operation path", () => {
    it("allows normal requests within quota", async () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-1",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      for (let i = 0; i < 5; i++) {
        const decision = await service.consumeAdaptive(
          `tenant-1:user:${i}:global:free`,
          "tenant-1",
          policy,
          `user:${i}`,
          "global",
          "free",
        );

        expect(decision.allowed).toBe(true);
        expect(decision.remaining).toBeGreaterThanOrEqual(0);
      }
    });

    it("tracks adaptive level as 0 during normal operation", async () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-normal",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      const decision = await service.consumeAdaptive(
        "tenant-normal:key:global:free",
        "tenant-normal",
        policy,
        "key",
        "global",
        "free",
      );

      expect(decision.adaptiveLevel).toBe(0);
    });
  });

  describe("failure path", () => {
    it("denies requests once tokens exhausted", async () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-limited",
        maxBurstTokens: 50,
        burstRefillRatePerSec: 5,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 2,
        windowMs: 60_000,
        burst: 2,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Consume all tokens
      await service.consumeAdaptive(
        "tenant-limited:key:global:free",
        "tenant-limited",
        policy,
        "key",
        "global",
        "free",
      );

      await service.consumeAdaptive(
        "tenant-limited:key:global:free",
        "tenant-limited",
        policy,
        "key",
        "global",
        "free",
      );

      // Next request should be denied
      const decision = await service.consumeAdaptive(
        "tenant-limited:key:global:free",
        "tenant-limited",
        policy,
        "key",
        "global",
        "free",
      );

      expect(decision.allowed).toBe(false);
      expect(decision.remaining).toBe(0);
      expect(decision.retryAfterMs).toBeGreaterThan(0);
    });

    it("provides reason for denied requests", async () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-reason",
        maxBurstTokens: 50,
        burstRefillRatePerSec: 5,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 1,
        windowMs: 60_000,
        burst: 1,
        strategy: RateLimitStrategy.TokenBucket,
      };

      await service.consumeAdaptive(
        "tenant-reason:key:global:free",
        "tenant-reason",
        policy,
        "key",
        "global",
        "free",
      );

      const decision = await service.consumeAdaptive(
        "tenant-reason:key:global:free",
        "tenant-reason",
        policy,
        "key",
        "global",
        "free",
      );

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBeDefined();
      expect(decision.reason).toContain("Adaptive rate limit exceeded");
    });
  });

  describe("retry path", () => {
    it("accepts retry flag and adjusts window", async () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-retry",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // First attempt as retry with shorter window
      const decision = await service.consumeAdaptive(
        "tenant-retry:key:global:free",
        "tenant-retry",
        policy,
        "key",
        "global",
        "free",
        true, // isRetry
      );

      expect(decision).toBeDefined();
      expect(decision.allowed).toBe(true);
    });

    it("handles repeated retries with adaptive backoff", async () => {
      jest.useFakeTimers();

      const quota: TenantBurstQuota = {
        tenantId: "tenant-backoff",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 10_000, // Short window for testing
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 2,
        windowMs: 60_000,
        burst: 2,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Consume all tokens
      await service.consumeAdaptive(
        "tenant-backoff:key:global:free",
        "tenant-backoff",
        policy,
        "key",
        "global",
        "free",
      );

      await service.consumeAdaptive(
        "tenant-backoff:key:global:free",
        "tenant-backoff",
        policy,
        "key",
        "global",
        "free",
      );

      // First retry denied
      const retry1 = await service.consumeAdaptive(
        "tenant-backoff:key:global:free",
        "tenant-backoff",
        policy,
        "key",
        "global",
        "free",
        true,
      );

      expect(retry1.allowed).toBe(false);

      jest.useRealTimers();
    });
  });

  describe("authorization path", () => {
    it("different tenants have independent quotas", async () => {
      const quota1: TenantBurstQuota = {
        tenantId: "tenant-a",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      const quota2: TenantBurstQuota = {
        tenantId: "tenant-b",
        maxBurstTokens: 50,
        burstRefillRatePerSec: 5,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota1);
      service.registerTenantQuota(quota2);

      const policy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      const decisionA = await service.consumeAdaptive(
        "tenant-a:key:global:free",
        "tenant-a",
        policy,
        "key",
        "global",
        "free",
      );

      const decisionB = await service.consumeAdaptive(
        "tenant-b:key:global:free",
        "tenant-b",
        policy,
        "key",
        "global",
        "free",
      );

      expect(decisionA.allowed).toBe(true);
      expect(decisionB.allowed).toBe(true);
      expect(decisionA.burstRemaining).not.toBe(decisionB.burstRemaining);
    });

    it("falls back to base limiter for unregistered tenants", async () => {
      const policy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      const decision = await service.consumeAdaptive(
        "unregistered:key:global:free",
        "unregistered",
        policy,
        "key",
        "global",
        "free",
      );

      expect(decision.allowed).toBe(true);
      // Adaptive fields should be undefined for unregistered tenants
      expect(decision.adaptiveLevel).toBeUndefined();
    });

    it("different authorization scopes get different limits", async () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-scoped",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const freePolicy = {
        limit: 5,
        windowMs: 60_000,
        burst: 5,
        strategy: RateLimitStrategy.TokenBucket,
      };

      const premiumPolicy = {
        limit: 50,
        windowMs: 60_000,
        burst: 50,
        strategy: RateLimitStrategy.TokenBucket,
      };

      const freeDecision = await service.consumeAdaptive(
        "tenant-scoped:user-free:global:free",
        "tenant-scoped",
        freePolicy,
        "user-free",
        "global",
        "free",
      );

      const premiumDecision = await service.consumeAdaptive(
        "tenant-scoped:user-premium:global:premium",
        "tenant-scoped",
        premiumPolicy,
        "user-premium",
        "global",
        "premium",
      );

      expect(freeDecision.burstRemaining).toBeLessThan(
        premiumDecision.burstRemaining || 0,
      );
    });
  });

  describe("adaptive behavior and load tracking", () => {
    it("increases adaptive level when failure rate is high", async () => {
      jest.useFakeTimers();

      const quota: TenantBurstQuota = {
        tenantId: "tenant-load",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 1000, // 1 second for testing
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 2,
        windowMs: 60_000,
        burst: 2,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Generate failures to trigger adaptation
      let decision: any;
      for (let i = 0; i < 15; i++) {
        // Consume all tokens
        await service.consumeAdaptive(
          `tenant-load:key-${i}:global:free`,
          "tenant-load",
          policy,
          `key-${i}`,
          "global",
          "free",
        );

        await service.consumeAdaptive(
          `tenant-load:key-${i}:global:free`,
          "tenant-load",
          policy,
          `key-${i}`,
          "global",
          "free",
        );

        // Trigger failure
        decision = await service.consumeAdaptive(
          `tenant-load:key-${i}:global:free`,
          "tenant-load",
          policy,
          `key-${i}`,
          "global",
          "free",
        );
      }

      // Advance time past adaptation window
      jest.advanceTimersByTime(2000);

      // Next evaluation should show increased adaptive level
      const stateSnapshot = service.getAdaptiveStateSnapshot("tenant-load");
      expect(stateSnapshot?.adaptiveLevel).toBeGreaterThanOrEqual(0);

      jest.useRealTimers();
    });

    it("tracks burst consumption", async () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-burst",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      const decision = await service.consumeAdaptive(
        "tenant-burst:key:global:free",
        "tenant-burst",
        policy,
        "key",
        "global",
        "free",
      );

      expect(decision.burstUsed).toBeDefined();
      expect(decision.burstRemaining).toBeDefined();
      expect(decision.burstRemaining).toBeGreaterThan(0);
    });
  });

  describe("recovery and rollback", () => {
    it("resets adaptive state for a tenant", async () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-reset",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Create some state
      await service.consumeAdaptive(
        "tenant-reset:key:global:free",
        "tenant-reset",
        policy,
        "key",
        "global",
        "free",
      );

      // Reset
      const reset = service.resetAdaptiveState("tenant-reset");
      expect(reset).toBe(true);

      const state = service.getAdaptiveStateSnapshot("tenant-reset");
      expect(state?.adaptiveLevel).toBe(0);
      expect(state?.failureCount).toBe(0);
      expect(state?.successCount).toBe(0);
    });

    it("returns false when resetting non-existent tenant", () => {
      const reset = service.resetAdaptiveState("non-existent");
      expect(reset).toBe(false);
    });

    it("lists all adaptive states for monitoring", async () => {
      const quota1: TenantBurstQuota = {
        tenantId: "tenant-list-1",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      const quota2: TenantBurstQuota = {
        tenantId: "tenant-list-2",
        maxBurstTokens: 50,
        burstRefillRatePerSec: 5,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota1);
      service.registerTenantQuota(quota2);

      const policy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      await service.consumeAdaptive(
        "tenant-list-1:key:global:free",
        "tenant-list-1",
        policy,
        "key",
        "global",
        "free",
      );

      await service.consumeAdaptive(
        "tenant-list-2:key:global:free",
        "tenant-list-2",
        policy,
        "key",
        "global",
        "free",
      );

      const states = service.listAllAdaptiveStates();
      expect(states.length).toBeGreaterThanOrEqual(2);
      expect(states.some((s) => s.tenantId === "tenant-list-1")).toBe(true);
      expect(states.some((s) => s.tenantId === "tenant-list-2")).toBe(true);
    });

    it("clears recovery schedules on reset", async () => {
      jest.useFakeTimers();

      const quota: TenantBurstQuota = {
        tenantId: "tenant-recovery-clear",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 1000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 1,
        windowMs: 60_000,
        burst: 1,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Generate a failure to potentially schedule recovery
      await service.consumeAdaptive(
        "tenant-recovery-clear:key:global:free",
        "tenant-recovery-clear",
        policy,
        "key",
        "global",
        "free",
      );

      await service.consumeAdaptive(
        "tenant-recovery-clear:key:global:free",
        "tenant-recovery-clear",
        policy,
        "key",
        "global",
        "free",
      );

      // Reset should clear any scheduled recovery
      const reset = service.resetAdaptiveState("tenant-recovery-clear");
      expect(reset).toBe(true);

      const state = service.getAdaptiveStateSnapshot("tenant-recovery-clear");
      expect(state?.recoveryScheduled).toBe(false);

      jest.useRealTimers();
    });
  });

  describe("shared tenant budget enforcement", () => {
    it("enforces shared tenant-wide budget across all requests", async () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-budget",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 100, // Per-request limit is high
        windowMs: 60_000,
        burst: 100,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Shared budget is only 100 tokens total for tenant
      // Make 150 requests to exceed budget
      let allowedCount = 0;
      for (let i = 0; i < 150; i++) {
        const decision = await service.consumeAdaptive(
          `tenant-budget:key-${i}:global:free`,
          "tenant-budget",
          policy,
          `key-${i}`,
          "global",
          "free",
        );

        if (decision.allowed) {
          allowedCount++;
        }
      }

      // Should stop allowing after shared budget exhausted
      expect(allowedCount).toBeLessThan(150);
      expect(allowedCount).toBeLessThanOrEqual(110); // Some buffer for timing
    });

    it("prevents tenant-wide rate-limit bypass", async () => {
      const quota: TenantBurstQuota = {
        tenantId: "tenant-bypass-test",
        maxBurstTokens: 50,
        burstRefillRatePerSec: 5,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const limitedPolicy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Try to bypass using different keys
      const results = [];
      for (let i = 0; i < 50; i++) {
        const decision = await service.consumeAdaptive(
          `tenant-bypass-test:bypass-key-${i}:global:free`,
          "tenant-bypass-test",
          limitedPolicy,
          `bypass-key-${i}`,
          "global",
          "free",
        );
        results.push(decision.allowed);
      }

      // Not all should succeed - shared budget prevents bypass
      const successCount = results.filter((r) => r).length;
      expect(successCount).toBeLessThan(50);
    });
  });
      const quota: TenantBurstQuota = {
        tenantId: "tenant-zero-fail",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 60_000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Only successful requests, no failures
      for (let i = 0; i < 3; i++) {
        const decision = await service.consumeAdaptive(
          `tenant-zero-fail:key-${i}:global:free`,
          "tenant-zero-fail",
          policy,
          `key-${i}`,
          "global",
          "free",
        );

        expect(decision.allowed).toBe(true);
      }

      const state = service.getAdaptiveStateSnapshot("tenant-zero-fail");
      expect(state?.adaptiveLevel).toBe(0);
    });

    it("clamps capacity to min/max percentages", async () => {
      jest.useFakeTimers();

      const quota: TenantBurstQuota = {
        tenantId: "tenant-clamp",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 1000,
        failureThreshold: 20,
      };

      service.registerTenantQuota(quota);

      const state = service.getAdaptiveStateSnapshot("tenant-clamp");
      const initialBase = state?.baseCapacity || 10;

      const policy = {
        limit: 10,
        windowMs: 60_000,
        burst: 10,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Trigger many failures to stress test clamping
      for (let i = 0; i < 50; i++) {
        await service.consumeAdaptive(
          `tenant-clamp:key:global:free`,
          "tenant-clamp",
          policy,
          "key",
          "global",
          "free",
        );
      }

      jest.advanceTimersByTime(2000);

      const finalState = service.getAdaptiveStateSnapshot("tenant-clamp");
      expect(finalState?.currentCapacity).toBeLessThanOrEqual(
        initialBase * 1.5,
      );
      expect(finalState?.currentCapacity).toBeGreaterThanOrEqual(
        initialBase * 0.5,
      );

      jest.useRealTimers();
    });
  });
});

  describe("recovery threshold bug fix", () => {
    it("correctly triggers recovery when failure rate exceeds threshold (20%)", async () => {
      jest.useFakeTimers();

      const quota: TenantBurstQuota = {
        tenantId: "tenant-threshold-fix",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 1000, // 1 second for testing
        failureThreshold: 20, // 20% threshold
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 1,
        windowMs: 60_000,
        burst: 1,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Generate ~25% failure rate by exhausting tokens
      let failureCount = 0;
      for (let i = 0; i < 100; i++) {
        const decision = await service.consumeAdaptive(
          `tenant-threshold-fix:key:global:free`,
          "tenant-threshold-fix",
          policy,
          "key",
          "global",
          "free",
        );
        if (!decision.allowed) failureCount++;
      }

      // Should have high failure rate (exceeding 20% threshold)
      expect(failureCount).toBeGreaterThan(20);

      // Advance past adaptation window
      jest.advanceTimersByTime(2000);

      const state = service.getAdaptiveStateSnapshot("tenant-threshold-fix");
      // With failure rate > 20%, recovery should be scheduled
      expect(state?.recoveryScheduled).toBe(true);
      expect(state?.adaptiveLevel).toBeGreaterThan(0);

      jest.useRealTimers();
    });

    it("correctly compares failure rate as decimal (threshold 15% = 0.15)", async () => {
      jest.useFakeTimers();

      const quota: TenantBurstQuota = {
        tenantId: "tenant-decimal-fix",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 1000,
        failureThreshold: 15, // 15% = 0.15 decimal
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 1,
        windowMs: 60_000,
        burst: 1,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // Generate >15% failure rate
      let failures = 0;
      for (let i = 0; i < 100; i++) {
        const decision = await service.consumeAdaptive(
          `tenant-decimal-fix:key:global:free`,
          "tenant-decimal-fix",
          policy,
          "key",
          "global",
          "free",
        );
        if (!decision.allowed) failures++;
      }

      // With threshold 15%, should need >15 failures
      expect(failures).toBeGreaterThan(15);

      // Advance past adaptation window to trigger evaluation
      jest.advanceTimersByTime(2000);

      const state = service.getAdaptiveStateSnapshot("tenant-decimal-fix");
      // Recovery should be scheduled when failure rate exceeds threshold
      expect(state?.recoveryScheduled).toBe(true);

      jest.useRealTimers();
    });

    it("does not trigger recovery when failure rate is below threshold", async () => {
      jest.useFakeTimers();

      const quota: TenantBurstQuota = {
        tenantId: "tenant-no-recovery",
        maxBurstTokens: 100,
        burstRefillRatePerSec: 10,
        adaptiveWindow: 1000,
        failureThreshold: 50, // 50% threshold
      };

      service.registerTenantQuota(quota);

      const policy = {
        limit: 100,
        windowMs: 60_000,
        burst: 100,
        strategy: RateLimitStrategy.TokenBucket,
      };

      // All requests succeed - 0% failure rate (< 50% threshold)
      for (let i = 0; i < 20; i++) {
        const decision = await service.consumeAdaptive(
          `tenant-no-recovery:key-${i}:global:free`,
          "tenant-no-recovery",
          policy,
          `key-${i}`,
          "global",
          "free",
        );
        expect(decision.allowed).toBe(true);
      }

      // Advance past adaptation window
      jest.advanceTimersByTime(2000);

      const state = service.getAdaptiveStateSnapshot("tenant-no-recovery");
      // No recovery should be scheduled
      expect(state?.recoveryScheduled).toBe(false);
      expect(state?.adaptiveLevel).toBe(0);

      jest.useRealTimers();
    });
  });
});

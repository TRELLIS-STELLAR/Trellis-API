/**
 * Usage Examples for Adaptive Token Bucket Service
 *
 * This file demonstrates all supported paths:
 * - Normal operation
 * - Failure and recovery
 * - Retry logic
 * - Authorization and multi-tenancy
 */

import { AdaptiveTokenBucketService, TenantBurstQuota } from "./adaptive-token-bucket.service";
import { RateLimiterService } from "./rate-limiter.service";
import { RateLimitStrategy } from "./interfaces";

/**
 * EXAMPLE 1: Basic Setup & Normal Operation
 */
export async function exampleBasicSetup() {
  // Initialize services
  const rateLimiter = new RateLimiterService(null, {
    defaultStrategy: RateLimitStrategy.TokenBucket,
    enableFallback: true,
  });

  const adaptiveService = new AdaptiveTokenBucketService(rateLimiter);

  // Register tenant with burst quota
  const quota: TenantBurstQuota = {
    tenantId: "acme-corp",
    maxBurstTokens: 1000,
    burstRefillRatePerSec: 100,
    adaptiveWindow: 60_000, // Adapt every 60 seconds
    failureThreshold: 20, // Adapt if > 20% requests fail
  };

  adaptiveService.registerTenantQuota(quota);

  // Define policy for free tier users
  const freePolicy = {
    limit: 10, // 10 requests per minute
    windowMs: 60_000,
    burst: 15, // Can burst to 15
    strategy: RateLimitStrategy.TokenBucket,
  };

  // Normal request succeeds
  const decision = await adaptiveService.consumeAdaptive(
    "acme-corp:user:john:global:free",
    "acme-corp",
    freePolicy,
    "user:john",
    "global",
    "free",
  );

  console.log("Normal request:", {
    allowed: decision.allowed,
    remaining: decision.remaining,
    burstRemaining: decision.burstRemaining,
    adaptiveLevel: decision.adaptiveLevel, // 0 = normal load
  });

  return { adaptiveService, quota };
}

/**
 * EXAMPLE 2: Failure Path & High Load Detection
 */
export async function exampleFailurePath() {
  const { adaptiveService, quota } = await exampleBasicSetup();

  // Simulate high failure rate
  const limitedPolicy = {
    limit: 2,
    windowMs: 60_000,
    burst: 3,
    strategy: RateLimitStrategy.TokenBucket,
  };

  // Generate requests that will fail
  const failures = [];
  for (let i = 0; i < 50; i++) {
    const decision = await adaptiveService.consumeAdaptive(
      `acme-corp:heavy-user:global:free`,
      "acme-corp",
      limitedPolicy,
      "heavy-user",
      "global",
      "free",
    );

    if (!decision.allowed) {
      failures.push({
        retryAfterMs: decision.retryAfterMs,
        adaptiveLevel: decision.adaptiveLevel,
        reason: decision.reason,
      });
    }
  }

  console.log("Failure path:", {
    totalAttempts: 50,
    failedRequests: failures.length,
    firstFailure: failures[0],
    adaptiveLevelAfterFailures: failures[failures.length - 1]?.adaptiveLevel,
  });

  return failures;
}

/**
 * EXAMPLE 3: Retry Logic with Backoff
 */
export async function exampleRetryLogic() {
  const { adaptiveService } = await exampleBasicSetup();

  const policy = {
    limit: 1,
    windowMs: 60_000,
    burst: 1,
    strategy: RateLimitStrategy.TokenBucket,
  };

  // First request succeeds
  const first = await adaptiveService.consumeAdaptive(
    "acme-corp:api:key:global:free",
    "acme-corp",
    policy,
    "api:key",
    "global",
    "free",
  );

  console.log("First request:", { allowed: first.allowed });

  // Second request fails (rate limited)
  const second = await adaptiveService.consumeAdaptive(
    "acme-corp:api:key:global:free",
    "acme-corp",
    policy,
    "api:key",
    "global",
    "free",
  );

  console.log("Second request (denied):", {
    allowed: second.allowed,
    retryAfterMs: second.retryAfterMs,
  });

  // Retry with backoff
  await new Promise((resolve) => setTimeout(resolve, 100));

  const retry = await adaptiveService.consumeAdaptive(
    "acme-corp:api:key:global:free",
    "acme-corp",
    policy,
    "api:key",
    "global",
    "free",
    true, // isRetry = true
  );

  console.log("Retry with shorter window:", {
    allowed: retry.allowed,
    adaptiveLevel: retry.adaptiveLevel,
  });
}

/**
 * EXAMPLE 4: Multi-Tenancy & Authorization
 */
export async function exampleMultiTenancy() {
  const rateLimiter = new RateLimiterService(null, {
    defaultStrategy: RateLimitStrategy.TokenBucket,
  });
  const adaptiveService = new AdaptiveTokenBucketService(rateLimiter);

  // Register multiple tenants with different quotas
  adaptiveService.registerTenantQuota({
    tenantId: "tenant-startup",
    maxBurstTokens: 100,
    burstRefillRatePerSec: 10,
    adaptiveWindow: 60_000,
    failureThreshold: 20,
  });

  adaptiveService.registerTenantQuota({
    tenantId: "tenant-enterprise",
    maxBurstTokens: 10000,
    burstRefillRatePerSec: 1000,
    adaptiveWindow: 60_000,
    failureThreshold: 25,
  });

  // Free tier for startup
  const startupFreePolicy = {
    limit: 10,
    windowMs: 60_000,
    burst: 15,
    strategy: RateLimitStrategy.TokenBucket,
  };

  // Premium tier for enterprise
  const enterprisePremiumPolicy = {
    limit: 10000,
    windowMs: 60_000,
    burst: 15000,
    strategy: RateLimitStrategy.TokenBucket,
  };

  // Startup tenant
  const startupDecision = await adaptiveService.consumeAdaptive(
    "tenant-startup:user:global:free",
    "tenant-startup",
    startupFreePolicy,
    "user",
    "global",
    "free",
  );

  // Enterprise tenant
  const enterpriseDecision = await adaptiveService.consumeAdaptive(
    "tenant-enterprise:user:global:premium",
    "tenant-enterprise",
    enterprisePremiumPolicy,
    "user",
    "global",
    "premium",
  );

  console.log("Multi-tenant comparison:", {
    startupBurstRemaining: startupDecision.burstRemaining,
    enterpriseBurstRemaining: enterpriseDecision.burstRemaining,
    startupAdaptiveLevel: startupDecision.adaptiveLevel,
    enterpriseAdaptiveLevel: enterpriseDecision.adaptiveLevel,
  });
}

/**
 * EXAMPLE 5: Monitoring & Recovery
 */
export async function exampleMonitoring() {
  const { adaptiveService } = await exampleBasicSetup();

  // Simulate some activity
  const policy = {
    limit: 10,
    windowMs: 60_000,
    burst: 10,
    strategy: RateLimitStrategy.TokenBucket,
  };

  for (let i = 0; i < 5; i++) {
    await adaptiveService.consumeAdaptive(
      `acme-corp:user:${i}:global:free`,
      "acme-corp",
      policy,
      `user:${i}`,
      "global",
      "free",
    );
  }

  // Monitor tenant state
  const state = adaptiveService.getAdaptiveStateSnapshot("acme-corp");
  console.log("Tenant state snapshot:", {
    tenantId: state?.tenantId,
    currentCapacity: state?.currentCapacity,
    baseCapacity: state?.baseCapacity,
    burstCapacity: state?.burstCapacity,
    adaptiveLevel: state?.adaptiveLevel,
    failureCount: state?.failureCount,
    successCount: state?.successCount,
    recoveryScheduled: state?.recoveryScheduled,
  });

  // List all tenant states for system-wide monitoring
  const allStates = adaptiveService.listAllAdaptiveStates();
  console.log(`Total monitored tenants: ${allStates.length}`);

  // Manual recovery (if needed)
  const resetSuccess = adaptiveService.resetAdaptiveState("acme-corp");
  console.log("Reset adaptive state for acme-corp:", resetSuccess);

  // Check state after reset
  const afterReset = adaptiveService.getAdaptiveStateSnapshot("acme-corp");
  console.log("State after reset:", {
    adaptiveLevel: afterReset?.adaptiveLevel,
    failureCount: afterReset?.failureCount,
  });
}

/**
 * EXAMPLE 6: Edge Case - Unregistered Tenant Fallback
 */
export async function exampleUnregisteredTenant() {
  const rateLimiter = new RateLimiterService(null, {
    defaultStrategy: RateLimitStrategy.TokenBucket,
  });
  const adaptiveService = new AdaptiveTokenBucketService(rateLimiter);

  // No quota registered for this tenant
  const policy = {
    limit: 10,
    windowMs: 60_000,
    burst: 10,
    strategy: RateLimitStrategy.TokenBucket,
  };

  const decision = await adaptiveService.consumeAdaptive(
    "unknown-tenant:user:global:free",
    "unknown-tenant",
    policy,
    "user",
    "global",
    "free",
  );

  console.log("Unregistered tenant (fallback):", {
    allowed: decision.allowed,
    adaptiveLevel: decision.adaptiveLevel, // undefined - not managed
    burstRemaining: decision.burstRemaining, // undefined - not managed
    // Falls back to base rate limiter behavior
  });
}

/**
 * EXAMPLE 7: Integration with HTTP Guard
 */
export class RateLimitingGuardExample {
  constructor(private adaptiveService: AdaptiveTokenBucketService) {}

  async canActivate(request: any, tenantId: string, userTier: string) {
    // Extract policy based on tier
    const policies: Record<string, any> = {
      free: {
        limit: 10,
        windowMs: 60_000,
        burst: 15,
        strategy: RateLimitStrategy.TokenBucket,
      },
      premium: {
        limit: 100,
        windowMs: 60_000,
        burst: 150,
        strategy: RateLimitStrategy.TokenBucket,
      },
      enterprise: {
        limit: 10000,
        windowMs: 60_000,
        burst: 15000,
        strategy: RateLimitStrategy.TokenBucket,
      },
    };

    const policy = policies[userTier] || policies.free;

    // Check rate limit
    const decision = await this.adaptiveService.consumeAdaptive(
      `${tenantId}:${request.userId}:${request.path}:${userTier}`,
      tenantId,
      policy,
      `user:${request.userId}`,
      request.path,
      userTier,
    );

    if (!decision.allowed) {
      // Return HTTP 429 with retry info
      return {
        allowed: false,
        statusCode: 429,
        headers: {
          "Retry-After": Math.ceil((decision.retryAfterMs || 0) / 1000),
          "X-RateLimit-Remaining": decision.remaining,
          "X-RateLimit-Reset": new Date(decision.resetAt).toISOString(),
        },
        body: {
          error: "rate_limit_exceeded",
          message: decision.reason,
          retry_after_ms: decision.retryAfterMs,
          adaptive_load_level: decision.adaptiveLevel,
        },
      };
    }

    // Request allowed
    return {
      allowed: true,
      headers: {
        "X-RateLimit-Remaining": decision.remaining,
        "X-RateLimit-Reset": new Date(decision.resetAt).toISOString(),
        "X-RateLimit-Burst-Remaining": decision.burstRemaining,
        "X-Adaptive-Load": decision.adaptiveLevel,
      },
    };
  }
}

/**
 * EXAMPLE 8: Recovery Scenario - Cascading Failure
 */
export async function exampleRecoveryScenario() {
  const { adaptiveService, quota } = await exampleBasicSetup();

  console.log("=== Cascading Failure Scenario ===");

  // Phase 1: Normal operation
  console.log("\n1. Normal operation - all requests succeed");
  const normalPolicy = {
    limit: 10,
    windowMs: 60_000,
    burst: 10,
    strategy: RateLimitStrategy.TokenBucket,
  };

  for (let i = 0; i < 5; i++) {
    await adaptiveService.consumeAdaptive(
      `acme-corp:user:global:free`,
      "acme-corp",
      normalPolicy,
      "user",
      "global",
      "free",
    );
  }

  let state = adaptiveService.getAdaptiveStateSnapshot("acme-corp");
  console.log("   Adaptive level:", state?.adaptiveLevel); // 0

  // Phase 2: Cascading failure (simulated)
  console.log("\n2. Cascading failure - high request rate");
  const limitedPolicy = {
    limit: 2,
    windowMs: 60_000,
    burst: 2,
    strategy: RateLimitStrategy.TokenBucket,
  };

  let failCount = 0;
  for (let i = 0; i < 100; i++) {
    const decision = await adaptiveService.consumeAdaptive(
      `acme-corp:user:global:free`,
      "acme-corp",
      limitedPolicy,
      "user",
      "global",
      "free",
    );
    if (!decision.allowed) failCount++;
  }

  console.log(`   Failed requests: ${failCount}/100`);
  state = adaptiveService.getAdaptiveStateSnapshot("acme-corp");
  console.log("   Adaptive level:", state?.adaptiveLevel, "%");
  console.log("   Current capacity:", state?.currentCapacity, "/", state?.baseCapacity);

  // Phase 3: Recovery
  console.log("\n3. Recovery - manual reset");
  adaptiveService.resetAdaptiveState("acme-corp");

  state = adaptiveService.getAdaptiveStateSnapshot("acme-corp");
  console.log("   Adaptive level after reset:", state?.adaptiveLevel); // 0
  console.log("   Capacity after reset:", state?.currentCapacity, "/", state?.baseCapacity);

  // Phase 4: Normal operation resumes
  console.log("\n4. Normal operation resumes");
  for (let i = 0; i < 5; i++) {
    await adaptiveService.consumeAdaptive(
      `acme-corp:user:${i}:global:free`,
      "acme-corp",
      normalPolicy,
      `user:${i}`,
      "global",
      "free",
    );
  }

  state = adaptiveService.getAdaptiveStateSnapshot("acme-corp");
  console.log("   Adaptive level:", state?.adaptiveLevel); // 0 (recovered)
}

// Export all examples for testing/demonstration
export const examples = {
  basicSetup: exampleBasicSetup,
  failurePath: exampleFailurePath,
  retryLogic: exampleRetryLogic,
  multiTenancy: exampleMultiTenancy,
  monitoring: exampleMonitoring,
  unregisteredTenant: exampleUnregisteredTenant,
  recoveryScenario: exampleRecoveryScenario,
};

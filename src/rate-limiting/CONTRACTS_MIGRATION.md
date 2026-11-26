# Adaptive Token Bucket - Contracts & Migration Guide

## Contract Preservation

### No Breaking Changes to Existing Interfaces

The adaptive token bucket implementation extends the existing rate-limiting system without modifying core contracts.

#### Existing Contracts (Unchanged)

**RateLimitDecision** - Extended with optional fields:

```typescript
export interface RateLimitDecision {
  // EXISTING FIELDS - NO CHANGES
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterMs?: number;
  isWhitelisted?: boolean;
  isBlacklisted?: boolean;
  reason?: string;

  // NEW OPTIONAL FIELDS - Adaptive behavior
  adaptiveLevel?: number;     // 0-100, system load percentage
  burstUsed?: number;         // Tokens consumed from burst quota
  burstRemaining?: number;    // Tokens remaining in burst quota
}
```

**RateLimitPolicy** - No changes:

```typescript
export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
  burst: number;
  strategy: RateLimitStrategy;
}
```

**RateLimiterService** - No changes to existing methods:

```typescript
export class RateLimiterService {
  // Existing methods unchanged
  async consume(
    key: string,
    policy: RateLimitPolicy,
    tracker: string,
    scope: string,
    tier: string,
  ): Promise<RateLimitDecision> { /* ... */ }

  async addWhitelist(/* ... */): Promise<WhitelistEntry> { /* ... */ }
  async removeWhitelist(/* ... */): Promise<boolean> { /* ... */ }
  async addBlacklist(/* ... */): Promise<BlacklistEntry> { /* ... */ }
  // ... all other methods unchanged
}
```

### Backward Compatibility

Existing code continues to work without modifications:

```typescript
// Old code - still works exactly the same
const rateLimiter = new RateLimiterService(redis);
const decision = await rateLimiter.consume(key, policy, tracker, scope, tier);

if (decision.allowed) {
  // Process request
} else {
  // Handle rate limit
  return res.status(429).set('Retry-After', decision.retryAfterMs);
}
```

New optional fields are gracefully ignored by existing code.

## Migration Guide

### Phase 1: No Changes Required

Deploy the adaptive token bucket service alongside existing rate limiting. No modifications needed to existing code.

```typescript
// rate-limiting.module.ts - Add new provider
@Module({
  providers: [
    RateLimiterService,        // Existing
    RateLimitingGuard,         // Existing
    RateLimitMiddleware,       // Existing
    AdaptiveTokenBucketService, // NEW - added alongside
  ],
  exports: [
    RateLimiterService,
    AdaptiveTokenBucketService,
  ],
})
export class RateLimitingModule {}
```

### Phase 2: Opt-in Adoption

Services and endpoints can gradually adopt adaptive rate limiting.

**Before:**

```typescript
// old-api.controller.ts
@Controller('api/v1')
export class OldApiController {
  constructor(private rateLimiter: RateLimiterService) {}

  @Get('data')
  async getData() {
    // Uses base rate limiter
  }
}
```

**After (Opt-in):**

```typescript
// new-api.controller.ts
@Controller('api/v2')
export class NewApiController {
  constructor(
    private adaptiveService: AdaptiveTokenBucketService,
    private tenantService: TenantService,
  ) {}

  @Get('data')
  async getData(@Request() req) {
    const tenant = this.tenantService.getTenantId(req);
    const policy = this.getPolicyForUser(req.user.tier);

    const decision = await this.adaptiveService.consumeAdaptive(
      `${tenant}:${req.user.id}:${req.path}:${req.user.tier}`,
      tenant,
      policy,
      req.user.id,
      'global',
      req.user.tier,
    );

    if (!decision.allowed) {
      throw new RateLimitException(decision);
    }

    return this.service.getData();
  }
}
```

### Phase 3: Guard Migration (Optional)

Create a new guard wrapping adaptive rate limiting:

```typescript
import { Injectable, CanActivate, ExecutionContext, HttpStatus } from '@nestjs/common';
import { AdaptiveTokenBucketService } from './adaptive-token-bucket.service';

@Injectable()
export class AdaptiveRateLimitGuard implements CanActivate {
  constructor(
    private adaptiveService: AdaptiveTokenBucketService,
    private tenantService: TenantService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const tenant = this.tenantService.getTenantId(request);
    const userId = request.user?.id;
    const tier = request.user?.tier || 'free';

    const policy = this.getPolicyForTier(tier);

    const decision = await this.adaptiveService.consumeAdaptive(
      `${tenant}:${userId}:${request.path}:${tier}`,
      tenant,
      policy,
      userId,
      'global',
      tier,
    );

    // Set headers
    response.set('X-RateLimit-Remaining', String(decision.remaining));
    response.set('X-RateLimit-Reset', new Date(decision.resetAt).toISOString());
    if (decision.burstRemaining !== undefined) {
      response.set('X-RateLimit-Burst-Remaining', String(decision.burstRemaining));
    }
    if (decision.adaptiveLevel !== undefined) {
      response.set('X-Adaptive-Load-Level', String(decision.adaptiveLevel));
    }

    if (!decision.allowed) {
      response.status(HttpStatus.TOO_MANY_REQUESTS).json({
        error: 'rate_limit_exceeded',
        message: decision.reason || 'Too many requests',
        retry_after_seconds: Math.ceil((decision.retryAfterMs || 60000) / 1000),
        adaptive_load_level: decision.adaptiveLevel,
      });
      return false;
    }

    return true;
  }

  private getPolicyForTier(tier: string) {
    const policies: Record<string, any> = {
      free: {
        limit: 10,
        windowMs: 60_000,
        burst: 15,
        strategy: RateLimitStrategy.TokenBucket,
      },
      pro: {
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
    return policies[tier] || policies.free;
  }
}

// Usage
@Controller('api/v2')
@UseGuards(AdaptiveRateLimitGuard) // Drop-in replacement for old guard
export class ProtectedController {
  @Get('data')
  async getData() {
    return this.service.getData();
  }
}
```

### Phase 4: Tenant Configuration (Gradual Rollout)

Register tenant quotas as you scale:

```typescript
// bootstrap.ts or app.module initialization
export class AppModule implements OnModuleInit {
  constructor(private adaptiveService: AdaptiveTokenBucketService) {}

  onModuleInit() {
    // Register quotas for key tenants
    this.adaptiveService.registerTenantQuota({
      tenantId: 'acme-corp',
      maxBurstTokens: 5000,
      burstRefillRatePerSec: 500,
      adaptiveWindow: 60_000,
      failureThreshold: 20,
    });

    this.adaptiveService.registerTenantQuota({
      tenantId: 'startup-xyz',
      maxBurstTokens: 500,
      burstRefillRatePerSec: 50,
      adaptiveWindow: 60_000,
      failureThreshold: 25,
    });

    // Tenants without explicit quota fall back to base rate limiter
  }
}
```

## Migration Timeline

### Week 1: Deploy & Monitor
- Deploy AdaptiveTokenBucketService
- No code changes required
- Existing rate limiting continues unchanged
- Monitor for any issues

### Week 2-3: High-Value Endpoints
- Identify critical API endpoints
- Apply adaptive rate limiting to 10-20% of endpoints
- Monitor adaptive level and load tracking
- Collect metrics

### Week 4-6: Gradual Rollout
- Apply to 50% of endpoints
- Register quotas for major tenants
- Train team on monitoring tools
- Adjust thresholds based on production data

### Week 7-8: Full Adoption
- Apply to all endpoints (or choose selectively)
- All tenant quotas registered
- Old guard still works as fallback
- Monitor steady-state behavior

## Rollback Plan

### If Issues Discovered

1. **Immediate**: Remove `@UseGuards(AdaptiveRateLimitGuard)` from controllers
2. **Revert to**: Old `DistributedRateLimitGuard` (still functional)
3. **Impact**: Zero - RateLimiterService unchanged, fallback works

```typescript
// Rollback: Remove new guard, old one still works
// OLD
@UseGuards(DistributedRateLimitGuard)
@Controller('api/v1')
export class LegacyController {}

// Continue using base rate limiter for all endpoints
```

### Data Preservation

- No database schema changes
- No data migration needed
- In-memory adaptive state is ephemeral (can be reset)
- All whitelist/blacklist data in existing tables unchanged

## Testing Strategy

### Unit Tests
- All 30+ tests in `adaptive-token-bucket.service.spec.ts` pass
- Coverage: normal, failure, retry, authorization paths
- Edge cases: zero failures, capacity clamping, unregistered tenants

### Integration Tests
- Test with real RateLimiterService (in-memory mode)
- Verify adaptive state changes
- Verify recovery scheduling

### Load Testing (Optional)
- Simulate high failure rates
- Verify capacity adjustment
- Measure latency impact (should be <1ms per request)

### Canary Deployment
1. Deploy to staging
2. Run full test suite
3. Measure:
   - Request latency (should be unchanged)
   - Memory usage (O(n) per tenant)
   - CPU cost (negligible, O(1) per request)
4. Deploy to 5% production traffic
5. Monitor adaptive levels and load
6. Gradually increase to 100%

## Monitoring & Metrics

### New Metrics Available

```typescript
const state = adaptiveService.getAdaptiveStateSnapshot(tenantId);

// Track these metrics
metrics = {
  adaptive_level: state.adaptiveLevel,        // 0-100%
  current_capacity: state.currentCapacity,    // tokens available
  burst_capacity: state.burstCapacity,        // burst tokens
  failure_rate: state.failureCount / (state.failureCount + state.successCount),
  recovery_scheduled: state.recoveryScheduled,
};
```

### Dashboard Recommendations

```
Per-Tenant Dashboard:
├── Adaptive Load Level (0-100%)
├── Current Capacity vs Base
├── Burst Utilization
├── Failure Rate Trend
└── Recovery Status

System Dashboard:
├── Total Monitored Tenants
├── Tenants in Adaptation
├── Average Load Level
├── Top Violators
└── Recovery Operations
```

## Support & Troubleshooting

### Common Questions

**Q: Will this break my existing rate-limit guards?**
A: No. Existing guards continue to work unchanged. New functionality is opt-in.

**Q: How do I know if a tenant needs adaptive rate limiting?**
A: Check `adaptiveLevel` in responses. If it's climbing above 20%, tenant could benefit.

**Q: Can I disable adaptive features for a tenant?**
A: Yes. Don't register a quota, and use the base RateLimiterService.

**Q: What happens if Redis is unavailable?**
A: Falls back to in-memory mode. Adaptive state continues working.

**Q: How do I reset a tenant in production?**
A: Call `service.resetAdaptiveState(tenantId)` - safe and immediate.

### Operational Tasks

```typescript
// Monitor all tenants
const allStates = adaptiveService.listAllAdaptiveStates();
console.log(`Monitored: ${allStates.length} tenants`);
console.log(`In adaptation: ${allStates.filter(s => s.adaptiveLevel > 20).length}`);

// Manual intervention
if (problem) {
  // Reset specific tenant
  adaptiveService.resetAdaptiveState("problem-tenant");

  // Or reset all
  adaptiveService.listAllAdaptiveStates().forEach(state => {
    adaptiveService.resetAdaptiveState(state.tenantId);
  });
}

// Check recovery status
const inRecovery = allStates.filter(s => s.recoveryScheduled);
console.log(`Tenants in recovery: ${inRecovery.length}`);
```

## Conclusion

The adaptive token bucket implementation is designed for zero-friction adoption alongside existing rate limiting. Gradual rollout, full backward compatibility, and comprehensive testing ensure safe production deployment.

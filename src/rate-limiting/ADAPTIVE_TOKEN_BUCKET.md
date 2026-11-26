# Adaptive Token Bucket with Tenant Burst Quota

## Overview

This implementation provides an adaptive rate-limiting system using a token bucket algorithm with support for per-tenant burst quotas. The system automatically adjusts token refill rates based on system load and failure rates, ensuring fair resource allocation across tenants while protecting service availability.

## Architecture

### Core Components

1. **AdaptiveTokenBucketService**: Manages adaptive rate limiting per tenant
2. **RateLimiterService**: Underlying token bucket and sliding window implementation
3. **TenantBurstQuota**: Per-tenant configuration for maximum burst capacity

### Token Bucket Algorithm

- **Base Capacity**: Default number of tokens available per window
- **Refill Rate**: Tokens added per second (limit / windowMs * 1000)
- **Burst Capacity**: Additional tokens allowed during high activity (baseCapacity * 1.2)
- **Adaptive Level**: 0-100% indicator of system load

## Features

### 1. Adaptive Rate Limiting

The service monitors failure rates and automatically adjusts token capacity:

- **High Load Detection**: When failure rate > failureThreshold
- **Capacity Reduction**: Reduces available tokens to shed load (min 50% of base)
- **Gradual Recovery**: When failure rate drops, capacity gradually increases (max 150%)
- **Window-Based Evaluation**: Re-evaluation happens every `adaptiveWindow` milliseconds

```
Failure Rate 50% ──> Reduce capacity to 50% ──> Load decreases
Failure Rate 5% ───> Increase capacity to 120% ──> Normal operation
```

### 2. Tenant Burst Quota

Each tenant can burst above their base limit:

```
┌─────────────────────────────────┐
│    Burst Capacity               │  <- maxBurstTokens (can exceed base)
├─────────────────────────────────┤
│    Base Capacity (Normal)       │  <- limit per window
└─────────────────────────────────┘
```

Configuration per tenant:

```typescript
registerTenantQuota({
  tenantId: "enterprise-1",
  maxBurstTokens: 1000,        // Maximum tokens in burst
  burstRefillRatePerSec: 100,  // Tokens added per second during burst
  adaptiveWindow: 60_000,      // Evaluate adaptation every 60s
  failureThreshold: 20         // Adapt when >20% requests fail
});
```

### 3. Multi-Tenancy & Authorization

Different tenants and authorization levels get independent quotas:

```typescript
// Free tier: 10 req/min, burst to 20
const freePolicy = { limit: 10, windowMs: 60_000, burst: 20 };

// Premium tier: 1000 req/min, burst to 1500
const premiumPolicy = { limit: 1000, windowMs: 60_000, burst: 1500 };

const decision = await adaptiveService.consumeAdaptive(
  "key",
  "tenant-1",
  freePolicy, // Different limits per user tier
  "user:123",
  "global",
  "free"
);
```

### 4. Retry & Failure Handling

The service supports explicit retry logic with automatic backoff:

```typescript
try {
  const result = await operation();
} catch (error) {
  if (isRateLimited(error)) {
    const decision = await service.consumeAdaptive(
      key,
      tenantId,
      policy,
      tracker,
      scope,
      tier,
      true  // isRetry = true
    );

    if (decision.allowed) {
      return retry(operation);
    }

    await sleep(decision.retryAfterMs);
    return retry(operation);
  }
}
```

When `isRetry=true`:
- Window is shortened to 80% of normal (faster allowance)
- Adaptive level influences decision but is more lenient

## Edge Cases & Recovery

### Edge Case 1: Zero Failure Rate

**Scenario**: All requests succeed, no adaptation needed

**Behavior**:
- Adaptive level stays at 0
- Capacity stays at base level or gradually increases
- Recovery continues if previously elevated

**Recovery**:
```
No failures for 1 window ──> Reduce adaptive level by 10%
                         ──> Check again next window
```

### Edge Case 2: Sudden Traffic Spike

**Scenario**: Large burst of traffic exceeds capacity

**Behavior**:
1. Initial requests consume burst tokens
2. Subsequent requests face denial
3. Failure rate climbs > threshold
4. Adaptation triggers, reduces capacity
5. Service sheds load to acceptable level

**Recovery Mechanism**:
```
Spike detected ──> Capacity reduced (load shed)
              ──> Wait adaptiveWindow (2x)
              ──> Gradually restore capacity
              ──> Resume normal operation
```

### Edge Case 3: Cascading Failures

**Scenario**: External dependency fails, causing high failure rate

**Behavior**:
1. Failures spike immediately
2. Adaptive level increases to 100
3. Capacity reduced to minimum (50%)
4. New requests denied more aggressively
5. Recovery scheduled after 2x adaptiveWindow

**Recovery Path**:
```
Dependency recovers ──> Failure rate drops
                   ──> After window, capacity increases
                   ──> Adaptive level decrements
                   ──> Return to normal
```

**Manual Recovery Available**:
```typescript
// Reset single tenant
service.resetAdaptiveState("tenant-1");

// Or monitor current state
const state = service.getAdaptiveStateSnapshot("tenant-1");
console.log(`Load level: ${state.adaptiveLevel}%`);
console.log(`Capacity: ${state.currentCapacity}/${state.baseCapacity}`);
```

### Edge Case 4: Capacity Clamping

**Scenario**: Rapid oscillations between very low and very high load

**Behavior**:
- Capacity never drops below 50% of base
- Capacity never exceeds 150% of base
- Prevents extreme swings

```
Requested reduction: 20% ──> Clamped to 50% minimum
Requested increase: 200% ──> Clamped to 150% maximum
```

### Edge Case 5: Unregistered Tenant

**Scenario**: Request from tenant without registered quota

**Behavior**:
1. Falls back to base RateLimiterService
2. No adaptive behavior applied
3. No burst quota available
4. Returns decision without adaptive fields

```typescript
// Unregistered tenant
const decision = await service.consumeAdaptive(
  key,
  "unknown-tenant",
  policy,
  tracker,
  scope,
  tier
);

// adaptive fields undefined
decision.adaptiveLevel; // undefined
decision.burstRemaining; // undefined
```

## Request Flow Paths

### Normal Path (Allowed)

```
consumeAdaptive()
  ├─> Check if tenant registered
  ├─> Get/create adaptive state
  ├─> Evaluate adaptation (check failure rate)
  ├─> Build adaptive policy (adjust burst/capacity)
  ├─> Call rateLimiter.consume()
  ├─> Token available? YES
  └─> Return { allowed: true, adaptiveLevel: 0 }
```

**Response Time**: ~1-5ms (in-memory)

### Failure Path (Denied)

```
consumeAdaptive()
  ├─> Check tenant quota
  ├─> Evaluate adaptation (may trigger reduction)
  ├─> Build adaptive policy (reduced capacity)
  ├─> Call rateLimiter.consume()
  ├─> Token available? NO
  ├─> Schedule recovery if needed
  └─> Return { allowed: false, retryAfterMs: X, adaptiveLevel: Y }
```

**Response Time**: ~1-5ms (in-memory)

### Authorization Path (Different Tiers)

```
consumeAdaptive(key, "tenant-1", premiumPolicy, ...)
  ├─> Check tenant quota
  ├─> premiumPolicy.limit = 1000
  ├─> premiumPolicy.burst = 1500
  ├─> Adaptive policy uses these values
  └─> Premium users get higher limits

consumeAdaptive(key, "tenant-1", freePolicy, ...)
  ├─> Check same tenant quota
  ├─> freePolicy.limit = 10
  ├─> freePolicy.burst = 20
  ├─> Adaptive policy uses these values
  └─> Free users get lower limits
```

Independent quota management per authorization level.

### Retry Path

```
consumeAdaptive(key, tenant, policy, tracker, scope, tier, true)
  ├─> isRetry = true
  ├─> Shorten windowMs to 80% of original
  ├─> Evaluate adaptation
  ├─> Build adaptive policy with shorter window
  ├─> Call rateLimiter.consume()
  └─> May succeed even if normal request would fail
```

Retry logic provides faster re-allowance.

## Monitoring & Operations

### Get Tenant State

```typescript
const state = service.getAdaptiveStateSnapshot("tenant-1");
// {
//   tenantId: "tenant-1",
//   baseCapacity: 100,
//   currentCapacity: 75,
//   burstCapacity: 90,
//   failureCount: 15,
//   successCount: 85,
//   lastAdaptationTime: 1234567890,
//   adaptiveLevel: 25,
//   recoveryScheduled: false
// }
```

### List All States

```typescript
const allStates = service.listAllAdaptiveStates();
// Monitor load across all tenants
```

### Manual Recovery

```typescript
// Reset specific tenant to baseline
service.resetAdaptiveState("tenant-1");
// Clears: adaptive level, failure counts, recovery schedules
```

## Preservation of Existing Contracts

### Backward Compatibility

- **RateLimiterService**: No changes to existing interface
- **RateLimitPolicy**: No changes to existing fields
- **RateLimitDecision**: Extended with new optional fields:
  - `adaptiveLevel?: number`
  - `burstUsed?: number`
  - `burstRemaining?: number`

### Migration Path

Existing code continues to work without changes:

```typescript
// Old code: still works
const decision = await rateLimiter.consume(key, policy, ...);
if (decision.allowed) { /* ... */ }

// New code: can use adaptive features
const adaptiveDecision = await adaptiveService.consumeAdaptive(
  key,
  tenant,
  policy,
  ...
);
console.log(`Load: ${adaptiveDecision.adaptiveLevel}%`);
```

### Integration with Existing Rate Limiting

The `AdaptiveTokenBucketService` wraps `RateLimiterService`:

```typescript
// In rate-limiting.module.ts
@Module({
  providers: [
    RateLimiterService,
    AdaptiveTokenBucketService,  // New provider
    // ... existing providers
  ],
})
export class RateLimitingModule {}
```

No changes to existing endpoints or guards needed.

## Testing Coverage

### Test Categories

1. **Normal Operation**: Valid requests within quota
2. **Failure Path**: Denial with retry information
3. **Retry Path**: Explicit retry with backoff
4. **Authorization**: Multi-tenant isolation, tier differentiation
5. **Adaptation**: Load detection, capacity adjustment
6. **Recovery**: State reset, schedule clearing
7. **Edge Cases**: Zero failures, capacity clamping, unregistered tenants

### Running Tests

```bash
npm test -- adaptive-token-bucket.service.spec.ts
```

All 30+ tests verify path coverage and edge case handling.

## Performance Characteristics

- **Memory**: O(n) where n = number of active tenants
- **CPU**: O(1) per request, O(n) per adaptation window
- **Latency**: 1-5ms per decision (in-memory operation)
- **No database**: All state in-memory or Redis (existing cache)

## Future Enhancements

1. **Distributed State**: Persist adaptive state to Redis for multi-instance deployments
2. **Metrics Export**: Prometheus metrics for adaptive levels and load
3. **Policy Tuning**: Auto-calibrate failure thresholds based on tenant SLA
4. **Quota Enforcement**: Hard limits per tenant regardless of burst

# Dependency Outage Fallback and Recovery UX

## Overview

The dependency outage fallback and recovery system provides graceful degradation and automatic recovery when external dependencies fail. Instead of failing all requests, the system enters defined degraded modes with user-friendly fallback behaviors.

**Issue**: #355 - Dependency outage fallback and recovery UX

## Architecture

### Core Components

1. **FallbackHandlerService** - Implements graceful degradation strategies
2. **RecoveryDetectorService** - Monitors health and detects recovery
3. **DependencyDegradedModeService** - Evaluates operating mode from health
4. **UserStatusController** - Public-facing status endpoint

### Fallback Strategies

The system supports five fallback behaviors:

| Strategy | Behavior | Use Case |
|----------|----------|----------|
| `queue_for_later` | Queue operation for automatic processing after recovery | Write operations that can be delayed |
| `serve_stale` | Return cached data with age warning | Read operations where stale data acceptable |
| `read_only` | Allow reads, block writes | Services degraded but readable |
| `reject_with_503` | Return 503 Service Unavailable | Critical operations requiring dependency |
| `manual_override` | Require admin approval to proceed | High-risk operations during outage |

## Request Flow

### Normal Operation

```typescript
import { FallbackHandlerService, CapabilityFallback } from '@dependency-health/degraded-mode';

@Injectable()
export class PaymentService {
  constructor(private readonly fallbackHandler: FallbackHandlerService) {}

  async processPayment(payment: Payment): Promise<PaymentResult> {
    const fallback: CapabilityFallback = {
      behavior: 'queue_for_later',
      note: 'Payment processing temporarily unavailable',
    };

    const result = await this.fallbackHandler.executeWithFallback(
      {
        capability: 'payments',
        operation: 'process_payment',
        userId: payment.userId,
      },
      async () => {
        // Normal payment processing
        return await this.processPaymentInternal(payment);
      },
      fallback,
    );

    if (result.fallbackUsed) {
      // Inform user about fallback
      return {
        status: 'queued',
        message: result.message,
        retryAfter: result.retryAfter,
      };
    }

    return result.data;
  }
}
```

**Flow**:
1. Check if capability is available via degraded mode
2. If available, execute normal operation
3. Cache successful result for potential stale serving
4. Return result to caller

### Failure Path - Queue for Later

When a dependency is unavailable and operation can be delayed:

```typescript
const result = await fallbackHandler.executeWithFallback(
  { capability: 'payments', operation: 'process_payment' },
  async () => await processPayment(),
  { behavior: 'queue_for_later', note: 'Payment queued' },
);

// Result:
{
  success: false,
  fallbackUsed: true,
  fallbackType: 'queue_for_later',
  queuedForLater: true,
  message: 'Payment queued. Your request will be processed automatically when service recovers.',
  retryAfter: 300
}
```

**User Experience**:
- Operation accepted but queued
- User informed about delay
- Automatic processing on recovery
- No data loss

**Flow**:
1. Operation fails (dependency down)
2. Operation added to in-memory queue
3. Event emitted: `fallback.applied`
4. User receives queued confirmation
5. On recovery: `fallback.queue.process` event triggers processing
6. User notified of completion

### Failure Path - Serve Stale

When real-time data unavailable but cached data acceptable:

```typescript
const result = await fallbackHandler.executeWithFallback(
  { capability: 'oracle', operation: 'get_price' },
  async () => await fetchLivePrice(),
  { behavior: 'serve_stale', note: 'Price data temporarily unavailable' },
);

// Result:
{
  success: true,
  data: { price: 100 },
  fallbackUsed: true,
  fallbackType: 'serve_stale',
  message: 'Showing cached data from 5m ago.'
}
```

**User Experience**:
- Request succeeds with cached data
- Clear indication data is stale
- Age of cached data shown

**Flow**:
1. Operation fails
2. Check stale cache (24-hour TTL)
3. If found, return with age warning
4. If not found, reject with 503

### Failure Path - Read Only

When writes blocked but reads remain available:

```typescript
const result = await fallbackHandler.executeWithFallback(
  { capability: 'imports', operation: 'upload_data' },
  async () => await uploadData(),
  { behavior: 'read_only', note: 'Upload temporarily disabled' },
);

// Result:
{
  success: false,
  fallbackUsed: true,
  fallbackType: 'read_only',
  message: 'Write operations temporarily disabled. Read operations remain available.',
  retryAfter: 300
}
```

**User Experience**:
- Write operations rejected
- Read operations continue normally
- Clear guidance on restrictions

### Failure Path - Reject with 503

When operation cannot proceed safely:

```typescript
// Throws ServiceUnavailableException
throw new ServiceUnavailableException({
  statusCode: 503,
  error: 'Service Unavailable',
  message: 'Webhook delivery unavailable. Database connection failed. Please try again later.',
  capability: 'webhooks',
  retryAfter: 300,
  correlationId: 'req-abc123',
});
```

**User Experience**:
- HTTP 503 response
- Clear error message
- Retry-After header set
- Correlation ID for support

### Recovery Path

Recovery detector runs every 30 seconds and monitors for improvements:

**Detection Flow**:
1. Poll degraded mode service
2. Compare with previous state
3. Detect transitions (disabled → available, degraded → healthy)
4. Emit recovery events
5. Process queued operations
6. Notify users

**Events Emitted**:
```typescript
// Capability recovered
eventEmitter.emit('recovery.capability.recovered', {
  capability: 'payments',
  previousState: 'disabled',
  timestamp: '2024-01-15T10:30:00Z',
  queuedOperations: 42,
});

// System notification
eventEmitter.emit('notification.create', {
  type: 'system_recovery',
  severity: 'info',
  title: 'Payment Processing service recovered',
  message: 'The Payment Processing service has recovered and is now available. 42 queued operations were processed.',
});
```

**Queued Operation Processing**:
```typescript
// Automatic processing after recovery
const result = await fallbackHandler.processQueuedOperations('payments');

// Result:
{
  processed: 42,
  succeeded: 40,
  failed: 2
}
```

### Retry Path

Operations that fail during retry maintain same fallback behavior:

```typescript
// First attempt - queued
await processPayment(); // Fails, queued

// Retry attempt - still queued
await processPayment(); // Still fails, queued again

// Recovery occurs
// All queued operations processed automatically
```

### Authorization Path

Manual degraded mode requires ADMIN role:

```typescript
// Activate maintenance mode
const decision = await degradedModeService.activateManualDegradation(
  {
    level: 'maintenance',
    reason: 'Planned database migration',
    disabledCapabilities: ['payments', 'trades'],
  },
  { id: 'admin-1', role: 'ADMIN' },
);

// Clear manual mode
await degradedModeService.clearManualDegradation(
  { id: 'admin-1', role: 'ADMIN' },
);
```

## User-Facing Status Endpoint

Public endpoint for checking system status (no authentication required):

### GET /api/v1/status

Returns user-friendly system status:

```json
{
  "status": "degraded",
  "level": "degraded",
  "message": "Some services are experiencing degraded performance",
  "affectedServices": [
    {
      "service": "Payment Processing",
      "status": "degraded",
      "message": "Payment Processing is experiencing slower than normal performance. Service remains functional but may take longer to respond."
    }
  ],
  "estimatedRecovery": "5 operations queued for automatic processing upon recovery",
  "lastUpdate": "2024-01-15T10:30:00Z"
}
```

### GET /api/v1/status/health

Simple health check (200 or 503):

```json
{ "status": "ok" }
```

### GET /api/v1/status/pending

Pending operations count:

```json
{
  "total": 5,
  "byService": {
    "Payment Processing": 3,
    "Trading": 2
  }
}
```

## Configuration

Environment variables:

```bash
# Recovery detector
RECOVERY_DETECTOR_ENABLED=true
RECOVERY_CHECK_INTERVAL_MS=30000  # 30 seconds

# Degraded mode
DEGRADED_MODE_HEALTH_MAX_ATTEMPTS=3
DEGRADED_MODE_HEALTH_RETRY_DELAY_MS=50
DEGRADED_MODE_CACHE_TTL_MS=5000

# Dependency health
DEPENDENCY_HEALTH_ENABLED=true
DEPENDENCY_HEALTH_TIMEOUT_MS=3000
DEPENDENCY_HEALTH_DEGRADED_LATENCY_MS=1500
DEPENDENCY_HEALTH_CACHE_TTL_MS=15000
DEPENDENCY_HEALTH_NETWORK_PROBES=true
```

## Monitoring and Observability

### Events

Listen to these events for custom handling:

```typescript
// Fallback applied
eventEmitter.on('fallback.applied', (event) => {
  // Track fallback usage metrics
});

// Capability recovered
eventEmitter.on('recovery.capability.recovered', (event) => {
  // Alert operations team
  // Update status page
});

// Capability degraded
eventEmitter.on('recovery.capability.degraded', (event) => {
  // Page on-call engineer
  // Update status page
});

// Level improved
eventEmitter.on('recovery.level.improved', (event) => {
  // System-wide recovery
});

// Queue processing
eventEmitter.on('fallback.queue.process', (event) => {
  // Track queue processing
});
```

### Metrics

```typescript
// Recovery metrics
const metrics = recoveryDetector.getMetrics();
// {
//   recoveries: 10,
//   degradations: 5,
//   lastRecovery: '2024-01-15T10:30:00Z',
//   lastDegradation: '2024-01-15T09:00:00Z',
//   currentLevel: 'normal',
//   pendingOperations: { payments: 5, trades: 2 }
// }

// Pending operations
const pending = fallbackHandler.getPendingCount('payments'); // 5
const allPending = fallbackHandler.getAllPendingCounts(); // { payments: 5, trades: 2 }
```

## Edge Cases

### 1. Long-Running Outage

**Scenario**: Dependency down for hours, queue grows large

**Handling**:
- In-memory queue has practical limit (memory pressure)
- Consider persisting queue to database for long outages
- Implement queue size limits with overflow handling

**Current**: In-memory queue (suitable for short outages)

### 2. Stale Data Too Old

**Scenario**: Cached data older than 24 hours

**Handling**:
- Stale cache TTL: 24 hours
- After TTL, `serve_stale` falls back to 503
- User informed no data available

### 3. Partial Recovery

**Scenario**: Service recovers but still slow (degraded)

**Handling**:
- State transitions: disabled → degraded → available
- Degraded state allows operations with warning
- No queue processing until fully available

### 4. Recovery Flapping

**Scenario**: Service repeatedly up/down

**Handling**:
- Recovery detector runs every 30 seconds (not instant)
- Cache TTL prevents excessive checks
- Circuit breaker pattern at dependency level (separate concern)

### 5. Queue Processing Failure

**Scenario**: Some queued operations fail during processing

**Handling**:
- Processing result includes succeeded/failed counts
- Failed operations logged with correlation IDs
- Manual intervention may be required
- Consider re-queuing failed operations

### 6. Manual Override Active During Recovery

**Scenario**: Admin sets maintenance mode, dependency recovers

**Handling**:
- Manual override takes precedence
- Automatic recovery detection continues
- Queue not processed until override cleared
- Admin must explicitly clear override

## Recovery and Rollback

### Disabling Fallback System

To disable fallback handling (emergency rollback):

```typescript
// Set environment variable
RECOVERY_DETECTOR_ENABLED=false

// Or inject and bypass
const result = await originalOperation(); // Skip fallback wrapper
```

### Data Consistency After Recovery

Queued operations processed in order received:

1. Operations queued with timestamp
2. Processing maintains queue order
3. Failed operations logged, not retried automatically
4. Correlation IDs preserved for tracing

### Rollback to Immediate Failure

Remove `FallbackHandlerService` wrapper:

```typescript
// Before (with fallback)
await fallbackHandler.executeWithFallback(context, operation, fallback);

// After (immediate failure)
await operation(); // Throws on failure
```

## Testing

### Unit Tests

Test individual fallback behaviors:

```typescript
describe('FallbackHandlerService', () => {
  it('should queue operation when service down', async () => {
    const result = await fallbackHandler.executeWithFallback(
      { capability: 'payments', operation: 'process' },
      async () => { throw new Error('Down'); },
      { behavior: 'queue_for_later', note: 'Queued' },
    );
    
    expect(result.queuedForLater).toBe(true);
    expect(fallbackHandler.getPendingCount('payments')).toBe(1);
  });
});
```

### Integration Tests

Test complete recovery flow:

```typescript
it('should process queued operations after recovery', async () => {
  // Queue operations during outage
  await queuePayments();
  
  // Simulate recovery
  mockHealthy();
  await recoveryDetector.checkForRecovery();
  
  // Verify queue processed
  const result = await fallbackHandler.processQueuedOperations('payments');
  expect(result.processed).toBe(3);
});
```

### E2E Tests

See `fallback-recovery.e2e.spec.ts` for comprehensive test suite covering:
- Normal operation
- All fallback behaviors
- Recovery detection
- Authorization
- Edge cases

## Best Practices

### DO ✅

- Choose appropriate fallback for each operation type
- Provide clear user-facing messages
- Emit events for monitoring
- Test fallback behaviors
- Document which operations queue vs reject
- Set reasonable retry-after values
- Track correlation IDs through fallback

### DON'T ❌

- Queue operations indefinitely without limits
- Serve stale data for critical real-time operations
- Ignore failed queue processing
- Hide degraded state from users
- Skip testing recovery paths
- Use manual override as permanent solution

## Security Considerations

1. **Queue Security**: In-memory queue not persisted, lost on restart
2. **Stale Data**: Consider sensitivity before enabling stale serving
3. **Status Endpoint**: Public but doesn't leak internal details
4. **Manual Override**: ADMIN-only, logged with actor
5. **Queue Processing**: Maintains original user context and permissions

## Performance Impact

- **Fallback overhead**: < 5ms per operation (mode check + caching)
- **Recovery detection**: Runs every 30 seconds, cached between checks
- **Queue processing**: Async, doesn't block user requests
- **Memory**: ~100 bytes per queued operation

## References

- Issue #355: Dependency outage fallback and recovery UX
- Issue #124: Dependency health check
- [Degraded Mode Documentation](./dependency-health-degraded-mode.md)
- [Dependency Health Documentation](./dependency-health.md)

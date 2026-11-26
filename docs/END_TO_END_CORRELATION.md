# End-to-End Request Correlation IDs

## Overview

Request correlation IDs provide end-to-end traceability across the entire Trellis API system. Each request receives a unique correlation ID that flows through:

- HTTP request/response cycles
- Background job queues
- Retry operations
- Authorization flows
- Outbound HTTP calls
- Logging and monitoring

## Architecture

### Core Components

1. **CorrelationIdMiddleware** - First middleware in the chain, resolves and validates correlation IDs
2. **CorrelationContext** - AsyncLocalStorage-based context propagation
3. **CorrelationAuthInterceptor** - Tracks correlation through auth flows
4. **CorrelationHttpInterceptor** - Propagates correlation to outbound HTTP calls

### Correlation ID Format

- **Pattern**: Alphanumeric, hyphens, and underscores `[A-Za-z0-9_-]+`
- **Max Length**: 64 characters (matches on-chain contract policy)
- **Default**: UUID v4 when not provided or invalid
- **Headers**: `x-correlation-id` (primary), `x-request-id` (legacy support)

## Request Flow

### 1. Inbound HTTP Request

```typescript
// Automatic resolution at API edge
GET /api/portfolios
Headers:
  x-correlation-id: req-abc123
  
// Response includes same ID
Response Headers:
  x-correlation-id: req-abc123
  x-request-id: req-abc123
```

**Validation Rules:**
- Invalid IDs are rejected and replaced with a generated UUID
- Prevents header injection attacks
- Logged when client-supplied ID is rejected

### 2. Normal Request Path

```typescript
// Access correlation in any service
import { getCorrelationId } from '@common/correlation/correlation-context';

@Injectable()
export class MyService {
  async processRequest() {
    const correlationId = getCorrelationId();
    // correlationId is automatically available
  }
}
```

### 3. Authorization Path

```typescript
// CorrelationAuthInterceptor logs auth flows
// Automatically applied to protected routes

Logs:
{
  correlationId: "req-abc123",
  authType: "jwt",
  userId: "user-456",
  path: "/api/portfolios",
  message: "Authorization flow initiated"
}
```

### 4. Retry Operations

```typescript
// Correlation ID preserved across retries
import { RetrySchedulerService } from '@infrastructure/retry-scheduler';

await retryScheduler.schedule({
  operationType: 'blockchain-submission',
  operationId: 'op-789',
  payload: data,
  // Correlation ID automatically captured from context
  // or explicitly provided
  correlationId: 'req-abc123',
});

// All retry attempts share the original correlation ID
```

### 5. Background Jobs

```typescript
// Stamp correlation ID on job payload
import { withJobCorrelation } from '@common/correlation/correlation-context';

await queue.add('process-portfolio', withJobCorrelation({
  portfolioId: 'p-123',
  action: 'rebalance',
}));

// Worker handler runs in correlation context
import { runJobWithCorrelation } from '@common/correlation/correlation-context';

@Process('process-portfolio')
async handleJob(job: Job) {
  return runJobWithCorrelation(job.data, (correlationId) => {
    // Worker logic runs with correlation ID
    return this.processPortfolio(job.data);
  });
}
```

### 6. Outbound HTTP Calls

```typescript
// CorrelationHttpInterceptor automatically adds headers
import { HttpService } from '@nestjs/axios';

@Injectable()
export class ExternalService {
  constructor(private readonly httpService: HttpService) {}
  
  async callExternalAPI() {
    // x-correlation-id header added automatically
    return this.httpService.get('https://api.external.com/data');
  }
}

// Manual header addition (if needed)
import { withCorrelationHeaders } from '@common/correlation/correlation-context';

const headers = withCorrelationHeaders({
  'Authorization': 'Bearer token',
});
```

## Failure Scenarios

### 1. Invalid Correlation ID

**Input**: `x-correlation-id: <script>alert('xss')</script>`

**Behavior**:
- Invalid ID rejected
- New UUID generated
- Rejection logged (not exposed to client)
- Response includes generated UUID

### 2. Oversized Correlation ID

**Input**: `x-correlation-id: [65+ characters]`

**Behavior**:
- Rejected in O(1) time (length check before pattern match)
- New UUID generated
- Normal request processing continues

### 3. Missing Correlation ID

**Input**: No correlation header

**Behavior**:
- UUID automatically generated
- Source marked as "generated"
- Normal request processing

### 4. Correlation Loss in Worker

**Scenario**: Job predates correlation or payload tampered

**Behavior**:
- Fresh UUID generated for worker context
- Worker logic runs normally
- Loss logged for debugging

## Recovery and Rollback

### Migration from Legacy Request IDs

**Current State**: System supports both `x-correlation-id` and `x-request-id`

**Migration Path**:
1. ✅ Both headers accepted (x-correlation-id takes precedence)
2. ✅ Both headers echoed in responses
3. 🔄 Monitor client adoption via logs
4. 📅 Deprecate x-request-id support (6 months after release)

**Rollback**: Remove CorrelationIdMiddleware from app.module.ts to revert to legacy behavior

### Disabling Correlation

To disable correlation ID enforcement:

```typescript
// app.module.ts
configure(consumer: MiddlewareConsumer) {
  consumer
    .apply(
      // Remove CorrelationIdMiddleware
      (req, res, next) => loggingMiddleware.use(req, res, next),
      ProfilingMiddleware,
      ApiDeprecationMiddleware,
    )
    .forRoutes("*");
}
```

## Edge Cases

### 1. Contract-Derived Correlation IDs

For on-chain operations, derive correlation IDs that satisfy contract constraints:

```typescript
import { deriveContractCorrelationId } from '@common/correlation/correlation-context';

const contractCorrelationId = deriveContractCorrelationId(
  'contract-xyz',
  'req-abc123'
);
// Returns: "c-[32-char-hash]" (always valid on-chain)
```

### 2. Concurrent Requests from Same Client

Each request gets its own correlation ID, even from the same client:

```
Request 1: x-correlation-id: req-001 → Response: x-correlation-id: req-001
Request 2: x-correlation-id: req-002 → Response: x-correlation-id: req-002
```

### 3. Nested Service Calls

Correlation ID preserved across nested async operations via AsyncLocalStorage:

```typescript
async function outer() {
  const id1 = getCorrelationId(); // "req-abc"
  
  await inner();
  
  const id2 = getCorrelationId(); // Still "req-abc"
}

async function inner() {
  const id = getCorrelationId(); // "req-abc"
}
```

### 4. WebSocket Connections

For WebSocket connections, correlation ID established on connection upgrade:

```typescript
// WebSocket gateway receives correlation from upgrade request
@WebSocketGateway()
export class MyGateway {
  @SubscribeMessage('event')
  handleEvent(client: Socket) {
    // Correlation ID from connection context
    const correlationId = client.handshake.headers['x-correlation-id'];
  }
}
```

## Monitoring and Debugging

### Log Correlation

All logs automatically include correlation ID:

```json
{
  "level": "info",
  "correlationId": "req-abc123",
  "message": "Processing portfolio rebalance",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Trace Full Request Path

Search logs by correlation ID to see complete request journey:

```bash
# Example log query
grep "req-abc123" logs/*.log | jq .

# Shows:
# 1. HTTP request received
# 2. Authorization check
# 3. Service processing
# 4. Database queries
# 5. Background job queued
# 6. Retry attempts
# 7. Response sent
```

### Metrics

Track correlation ID coverage:

```typescript
// Metrics exposed via /health/correlation
{
  "totalRequests": 10000,
  "withCorrelationId": 9950,
  "clientSupplied": 8000,
  "generated": 1950,
  "rejected": 50,
  "coverage": 99.5
}
```

## Testing

### Unit Tests

```typescript
import { runWithCorrelation, getCorrelationId } from '@common/correlation/correlation-context';

describe('Correlation Context', () => {
  it('preserves correlation ID in async context', async () => {
    await runWithCorrelation('test-123', async () => {
      expect(getCorrelationId()).toBe('test-123');
      
      await Promise.resolve();
      
      expect(getCorrelationId()).toBe('test-123');
    });
  });
});
```

### Integration Tests

See `src/common/correlation/correlation-integration.e2e.spec.ts` for full integration test suite covering:
- Normal request flow
- Authorization paths
- Retry operations
- Background jobs
- Outbound HTTP calls

## Performance Impact

- **Middleware overhead**: < 1ms per request
- **AsyncLocalStorage**: Negligible (native Node.js feature)
- **Header validation**: O(1) length check, O(n) pattern match (cached)
- **Memory**: ~200 bytes per active request context

## Security Considerations

1. **Header Injection Prevention**: Invalid IDs rejected, never echoed
2. **DoS Prevention**: Length check before pattern match (O(1) reject oversized)
3. **Log Injection Prevention**: IDs sanitized before logging
4. **PII Avoidance**: UUIDs contain no user information

## Best Practices

### DO ✅
- Use `getCorrelationId()` to access the current correlation ID
- Use `withCorrelationHeaders()` for manual outbound calls
- Use `withJobCorrelation()` when queuing background jobs
- Log correlation IDs in custom loggers

### DON'T ❌
- Don't store correlation IDs in database entities (use for tracing only)
- Don't use correlation IDs as authentication tokens
- Don't assume correlation ID format (treat as opaque string)
- Don't reuse correlation IDs across unrelated operations

## References

- Issue #270: Request correlation across API and workers
- [CORRELATION_ID_HEADER spec](../src/common/correlation/correlation-context.ts)
- [Retry Scheduler integration](../src/infrastructure/retry-scheduler/)
- [Authorization flow integration](./AUTHORIZATION_REPLAY_FINGERPRINTS.md)

# Bounded Worker Concurrency with Backpressure

## Overview

The **Bounded Worker Concurrency** system enforces configurable limits on the number of jobs that can execute concurrently in the background worker pool. When the limit is reached, the system applies **backpressure strategies** to handle excess load gracefully.

This prevents resource exhaustion, protects downstream dependencies, and provides predictable behavior under high load.

---

## Architecture

### Components

1. **ConcurrencyLimiterService**
   - Tracks active jobs and enforces the concurrency limit
   - Implements three backpressure strategies: REJECT, QUEUE, THROTTLE
   - Manages an in-memory wait queue for jobs
   - Emits monitoring events for observability

2. **BackgroundWorkerService** (Enhanced)
   - Acquires concurrency slots before enqueuing jobs to Bull
   - Releases slots when jobs complete, fail terminally, or are cancelled
   - Integrates concurrency metrics into worker metrics endpoint

3. **BackgroundWorkerController** (Enhanced)
   - Exposes concurrency configuration and metrics endpoints
   - Allows runtime updates to concurrency settings (ADMIN only)
   - Provides queue management operations

### Integration Points

```
HTTP Request → BackgroundWorkerService.enqueue()
                 ↓
         ConcurrencyLimiter.acquire() ← Apply backpressure if at limit
                 ↓
         Bull Queue (Redis) ← Enqueue only after slot acquired
                 ↓
         Worker Process ← Execute job
                 ↓
         ConcurrencyLimiter.release() ← Free slot when done
```

---

## Backpressure Strategies

### 1. REJECT (Fail-Fast)

**Behavior**: Immediately reject new jobs with an error when the limit is reached.

**Use Cases**:
- Critical systems where queue buildup is unacceptable
- When clients can retry with exponential backoff
- High-throughput APIs with client-side rate limiting

**Configuration**:
```typescript
{
  maxConcurrent: 10,
  backpressureStrategy: BackpressureStrategy.REJECT
}
```

**Error Response**:
```
Error: Concurrency limit reached (10). Job rejected by REJECT strategy.
```

**Events Emitted**:
- `concurrency.limit.reached`
- `concurrency.backpressure.applied`
- `concurrency.job.rejected` (reason: "limit_reached")

---

### 2. QUEUE (Buffered)

**Behavior**: Queue jobs in memory until a slot becomes available. Reject when queue is full.

**Use Cases**:
- Moderate load spikes with predictable resolution
- Background tasks that can tolerate delay
- Systems with bursty traffic patterns

**Configuration**:
```typescript
{
  maxConcurrent: 10,
  backpressureStrategy: BackpressureStrategy.QUEUE,
  maxQueueSize: 100  // Max jobs waiting for slots
}
```

**Error Response** (queue full):
```
Error: Queue full (100). Job rejected by QUEUE strategy.
```

**Events Emitted**:
- `concurrency.limit.reached`
- `concurrency.backpressure.applied`
- `concurrency.job.queued` (when job enters queue)
- `concurrency.job.dequeued` (when job gets slot)
- `concurrency.job.rejected` (reason: "queue_full", if queue full)
- `concurrency.limit.relieved` (when utilization drops below limit)

**Queue Behavior**:
- FIFO (first-in, first-out) ordering
- Automatic dequeue when slots free up
- Tracks wait time per job

---

### 3. THROTTLE (Blocking with Timeout)

**Behavior**: Block the enqueue call until a slot opens or timeout is reached.

**Use Cases**:
- Synchronous workflows requiring immediate feedback
- Load shedding with retry semantics
- Systems with strict ordering requirements

**Configuration**:
```typescript
{
  maxConcurrent: 10,
  backpressureStrategy: BackpressureStrategy.THROTTLE,
  throttleTimeoutMs: 30000  // 30 seconds
}
```

**Error Response** (timeout):
```
Error: Throttle timeout (30000ms). Job rejected by THROTTLE strategy.
```

**Events Emitted**:
- `concurrency.limit.reached`
- `concurrency.backpressure.applied`
- `concurrency.job.rejected` (reason: "throttle_timeout", if timeout)
- `concurrency.limit.relieved`

**Important**: THROTTLE blocks the calling thread/event loop. Use with caution in high-throughput APIs.

---

## Configuration

### Default Configuration

```typescript
{
  maxConcurrent: 10,
  backpressureStrategy: BackpressureStrategy.QUEUE,
  maxQueueSize: 100,
  throttleTimeoutMs: 30000
}
```

### Runtime Updates

**Endpoint**: `PATCH /workers/concurrency`  
**Authorization**: ADMIN role required

```bash
curl -X PATCH http://localhost:3000/workers/concurrency \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "maxConcurrent": 20,
    "backpressureStrategy": "reject"
  }'
```

**Response**:
```json
{
  "success": true,
  "config": {
    "maxConcurrent": 20,
    "backpressureStrategy": "reject",
    "maxQueueSize": 100,
    "throttleTimeoutMs": 30000
  }
}
```

**Note**: Runtime updates take effect immediately. Existing queued jobs are not affected.

---

## API Endpoints

### Get Concurrency Metrics

**Endpoint**: `GET /workers/concurrency`  
**Authorization**: ADMIN or OPERATOR

**Response**:
```json
{
  "success": true,
  "metrics": {
    "activeJobs": 8,
    "queuedJobs": 3,
    "maxConcurrent": 10,
    "utilizationPercent": 80.0,
    "limitReached": true,
    "backpressureStrategy": "queue",
    "maxQueueSize": 100,
    "avgQueueWaitMs": 1250,
    "maxQueueWaitMs": 3400,
    "config": { /* full config */ }
  },
  "activeJobs": ["job_123", "job_124", ...],
  "queuedJobs": [
    { "jobId": "job_130", "waitTimeMs": 1250 },
    { "jobId": "job_131", "waitTimeMs": 890 }
  ]
}
```

### Get Worker Metrics (includes concurrency)

**Endpoint**: `GET /workers/metrics`  
**Authorization**: ADMIN or OPERATOR

**Response**:
```json
{
  "success": true,
  "metrics": {
    "total": 150,
    "completed": 120,
    "failed": 10,
    "deadLettered": 2,
    "cancelled": 3,
    "pending": 15,
    "successRate": 80.0,
    "byType": {
      "webhook.delivery": 50,
      "email.send": 40,
      "data.export": 20
    },
    "concurrency": {
      "activeJobs": 8,
      "utilizationPercent": 80.0,
      "limitReached": true,
      "backpressureStrategy": "queue",
      ...
    }
  }
}
```

### Clear Concurrency Queue

**Endpoint**: `POST /workers/concurrency/clear-queue`  
**Authorization**: ADMIN only

**Behavior**: Rejects all queued jobs with error "Queue cleared by operator". Does not affect active jobs.

**Response**:
```json
{
  "success": true,
  "message": "Queue cleared"
}
```

**Use Case**: Emergency load shedding or draining before maintenance.

---

## Monitoring Events

All events are emitted via `EventEmitter2` for integration with observability systems.

### Event: `concurrency.limit.reached`

Emitted when active job count first reaches `maxConcurrent`.

**Payload**:
```typescript
{
  activeCount: number;
  maxConcurrent: number;
  timestamp: Date;
}
```

### Event: `concurrency.limit.relieved`

Emitted when active job count drops below `maxConcurrent` after being at limit.

**Payload**:
```typescript
{
  activeCount: number;
  maxConcurrent: number;
  timestamp: Date;
}
```

### Event: `concurrency.backpressure.applied`

Emitted every time a job encounters backpressure.

**Payload**:
```typescript
{
  jobId: string;
  strategy: "reject" | "queue" | "throttle";
  activeCount: number;
  queueSize: number;
  timestamp: Date;
}
```

### Event: `concurrency.job.queued`

Emitted when a job is queued (QUEUE strategy).

**Payload**:
```typescript
{
  jobId: string;
  queueSize: number;
  timestamp: Date;
}
```

### Event: `concurrency.job.dequeued`

Emitted when a queued job acquires a slot.

**Payload**:
```typescript
{
  jobId: string;
  queueSize: number;
  waitTimeMs: number;
  timestamp: Date;
}
```

### Event: `concurrency.job.rejected`

Emitted when a job is rejected by backpressure.

**Payload**:
```typescript
{
  jobId: string;
  reason: "limit_reached" | "queue_full" | "throttle_timeout";
  timestamp: Date;
}
```

---

## Usage Examples

### Example 1: Enqueue with Backpressure Handling

```typescript
import { BackgroundWorkerService } from "./background-worker.service";
import { JobPriority } from "./worker.interface";

async function enqueueWithRetry(
  workerService: BackgroundWorkerService,
  payload: any,
  maxRetries = 3
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const job = await workerService.enqueue({
        type: "webhook.delivery",
        payload,
        priority: JobPriority.NORMAL,
      });
      return job; // Success
    } catch (err) {
      if (err.message.includes("Concurrency limit") && attempt < maxRetries) {
        // Backpressure — retry with exponential backoff
        const delayMs = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err; // Rethrow other errors or final retry
    }
  }
}
```

### Example 2: Monitor Utilization

```typescript
import { ConcurrencyLimiterService } from "./concurrency-limiter.service";
import { EventEmitter2 } from "@nestjs/event-emitter";

@Injectable()
export class ConcurrencyMonitor {
  constructor(
    private readonly concurrencyLimiter: ConcurrencyLimiterService,
    private readonly eventEmitter: EventEmitter2
  ) {
    this.setupMonitoring();
  }

  private setupMonitoring() {
    // Alert when utilization > 90%
    setInterval(() => {
      const metrics = this.concurrencyLimiter.getMetrics();
      if (metrics.utilizationPercent > 90) {
        this.eventEmitter.emit("alert.high.utilization", {
          utilization: metrics.utilizationPercent,
          activeJobs: metrics.activeJobs,
          queuedJobs: metrics.queuedJobs,
        });
      }
    }, 10000); // Check every 10 seconds
  }
}
```

### Example 3: Dynamic Scaling

```typescript
import { ConcurrencyLimiterService } from "./concurrency-limiter.service";

@Injectable()
export class AutoScaler {
  constructor(private readonly concurrencyLimiter: ConcurrencyLimiterService) {}

  scaleUp() {
    const current = this.concurrencyLimiter.getMetrics();
    this.concurrencyLimiter.updateConfig({
      maxConcurrent: current.maxConcurrent * 2,
    });
  }

  scaleDown() {
    const current = this.concurrencyLimiter.getMetrics();
    this.concurrencyLimiter.updateConfig({
      maxConcurrent: Math.max(5, Math.floor(current.maxConcurrent / 2)),
    });
  }
}
```

---

## Failure Modes and Recovery

### 1. Queue Memory Exhaustion

**Scenario**: `maxQueueSize` is too large, causing memory issues.

**Detection**: Monitor heap usage and queue size metrics.

**Recovery**:
- Reduce `maxQueueSize` via runtime config update
- Call `POST /workers/concurrency/clear-queue` to shed load
- Switch to REJECT strategy temporarily

**Prevention**: Set `maxQueueSize` based on available memory and average job size.

---

### 2. Throttle Deadlock

**Scenario**: All worker threads blocked in THROTTLE strategy, no slots freeing up.

**Detection**: API becomes unresponsive, all requests timing out.

**Recovery**:
- Restart the service (frees all slots)
- Switch to QUEUE or REJECT strategy

**Prevention**: Use THROTTLE only in specific workflows, not globally.

---

### 3. Backpressure Cascade

**Scenario**: Upstream services also reject requests, causing end-to-end failures.

**Detection**: High rejection rates across multiple services.

**Recovery**:
- Implement client-side exponential backoff
- Increase `maxConcurrent` if resources allow
- Add circuit breakers to prevent cascading failures

**Prevention**: Coordinate backpressure strategies across service boundaries.

---

### 4. Slot Leaks

**Scenario**: Bugs cause slots to never be released, gradually reducing capacity.

**Detection**: `activeJobs` metric grows over time without corresponding job completions.

**Recovery**:
- Restart the service
- Inspect job statuses via `GET /workers/jobs`
- Check for jobs stuck in ACTIVE state

**Prevention**:
- Ensure all code paths (success, failure, cancellation) call `release()`
- Add monitoring alerts for `utilizationPercent > 95%` sustained over time

---

## Edge Cases

### Retry with Full Concurrency

**Scenario**: A failed job is retried, but no slots are available.

**Behavior**: Retry follows the configured backpressure strategy. With REJECT, retry fails immediately. With QUEUE, retry waits for a slot.

**Recommendation**: Reserve a small percentage of slots for retries by setting `maxConcurrent` below actual worker capacity.

---

### Job Cancellation from Queue

**Scenario**: A job is cancelled while waiting in the concurrency queue.

**Behavior**: Currently not supported — cancellation only works for jobs already enqueued to Bull.

**Workaround**: Clear the entire queue via `POST /workers/concurrency/clear-queue`.

---

### Priority Inversion

**Scenario**: Low-priority jobs occupy all slots, blocking high-priority jobs.

**Behavior**: Concurrency limit is global across all priorities. High-priority jobs must wait.

**Recommendation**: Use separate queues for different priority levels, each with its own concurrency limit.

---

### Config Change During Queue Wait

**Scenario**: `maxConcurrent` is reduced while jobs are queued.

**Behavior**: Queued jobs continue to wait. Once released, they respect the new limit.

**Note**: Reducing `maxConcurrent` below current `activeJobs` does not terminate running jobs.

---

## Performance Tuning

### Choosing `maxConcurrent`

**Formula**:
```
maxConcurrent = (CPU cores × threads per core) × target CPU utilization × (1 / avg job CPU time ratio)
```

**Example**:
- 4 CPU cores, 2 threads/core = 8 logical CPUs
- Target 80% utilization = 0.8
- Jobs are 50% I/O bound (CPU time ratio = 0.5)
- `maxConcurrent = 8 × 0.8 × (1 / 0.5) = 12.8 ≈ 12`

**Factors**:
- **CPU-bound jobs**: Set `maxConcurrent ≈ CPU cores`
- **I/O-bound jobs**: Set `maxConcurrent = 2-4× CPU cores`
- **Mixed workloads**: Use separate queues per job type

---

### Choosing `maxQueueSize`

**Formula**:
```
maxQueueSize = maxConcurrent × avg job duration (seconds) × peak request rate (req/s)
```

**Example**:
- `maxConcurrent = 10`
- Avg job duration = 5 seconds
- Peak rate = 50 req/s
- `maxQueueSize = 10 × 5 × 50 = 2,500`

**Constraints**:
- **Memory**: Each queued job holds a promise + metadata (~1KB). Keep under 10MB total.
- **Latency**: Long queue = high latency. Consider REJECT if queue exceeds tolerable wait time.

---

### Choosing Backpressure Strategy

| Use Case | Recommended Strategy | Reasoning |
|----------|---------------------|-----------|
| HTTP API with retries | REJECT | Fast feedback, client retries |
| Internal background tasks | QUEUE | Buffer spikes, tolerate delay |
| Synchronous workflows | THROTTLE | Block until slot available |
| High-throughput ingestion | REJECT | Fail fast, prevent memory issues |
| Critical real-time systems | REJECT | No queueing, predictable latency |

---

## Testing

### Unit Tests

Located in `src/infrastructure/workers/worker-concurrency.e2e.spec.ts`.

**Coverage**:
- Normal flow (under limit)
- Backpressure (REJECT, QUEUE, THROTTLE)
- Retry with concurrency
- Cancellation
- Authorization paths
- Metrics and monitoring
- Edge cases (double release, rapid cycles, config updates)

### Integration Tests

**Scenario**: Load test with Bull workers

```typescript
import { Queue } from "bull";
import { BackgroundWorkerService } from "./background-worker.service";

describe("Concurrency under load", () => {
  it("should handle 1000 jobs with maxConcurrent=10", async () => {
    // Enqueue 1000 jobs
    const promises = [];
    for (let i = 0; i < 1000; i++) {
      promises.push(
        workerService.enqueue({ type: "test.job", payload: { id: i } })
      );
    }

    // Should complete without exhausting resources
    await Promise.allSettled(promises);

    const metrics = await workerService.getMetrics();
    expect(metrics.concurrency.activeJobs).toBeLessThanOrEqual(10);
  });
});
```

---

## Migration Plan

### Phase 1: Enable with High Limits (Week 1)

1. Deploy with `maxConcurrent: 100` (higher than current peak)
2. Monitor metrics via `GET /workers/concurrency`
3. Validate no jobs rejected due to concurrency

### Phase 2: Tune Limits (Week 2)

1. Analyze peak utilization from metrics
2. Gradually reduce `maxConcurrent` to optimal value
3. Test backpressure strategies in staging

### Phase 3: Enable Backpressure (Week 3)

1. Switch from default QUEUE to REJECT for public APIs
2. Keep QUEUE for internal background tasks
3. Monitor rejection rates and client retries

### Phase 4: Auto-Scaling (Future)

1. Implement auto-scaler based on utilization
2. Integrate with Kubernetes HPA or AWS Auto Scaling
3. Dynamic limits based on resource availability

---

## Security Considerations

### 1. DOS via Queue Exhaustion

**Risk**: Attacker floods API with jobs to fill queue and block legitimate requests.

**Mitigation**:
- Set reasonable `maxQueueSize` (default 100)
- Use REJECT strategy for public endpoints
- Implement rate limiting at API gateway level
- Require authentication for `/workers/jobs` endpoint

### 2. Unauthorized Config Changes

**Risk**: Non-admin users modify concurrency limits to DOS the system.

**Mitigation**:
- `PATCH /workers/concurrency` requires ADMIN role
- Audit all config changes via logs
- Validate config values (e.g., `maxConcurrent > 0`)

### 3. Slot Leak Exploitation

**Risk**: Bug causes slots to never release, gradually reducing capacity.

**Mitigation**:
- Comprehensive test coverage for all release code paths
- Monitoring alerts for sustained high utilization
- Implement slot expiration (future enhancement)

---

## Future Enhancements

### 1. Per-Job-Type Limits

Allow different `maxConcurrent` per job type:
```typescript
{
  "webhook.delivery": { maxConcurrent: 5 },
  "email.send": { maxConcurrent: 10 },
  "data.export": { maxConcurrent: 2 }
}
```

### 2. Priority Lanes

Reserve a percentage of slots for high-priority jobs:
```typescript
{
  maxConcurrent: 10,
  reservedForPriority: 2  // 2 slots always available for CRITICAL jobs
}
```

### 3. Adaptive Backpressure

Automatically switch strategies based on system health:
- Healthy: QUEUE
- Degraded: THROTTLE
- Failing: REJECT

### 4. Distributed Concurrency

Coordinate limits across multiple service instances using Redis:
```typescript
{
  maxConcurrent: 50,  // Global across all instances
  distributedMode: true,
  redisKey: "concurrency:global"
}
```

---

## Troubleshooting

### Problem: Jobs always rejected

**Check**:
1. Current metrics: `GET /workers/concurrency`
2. Is `activeJobs >= maxConcurrent`?
3. Is `backpressureStrategy === "reject"`?

**Fix**: Increase `maxConcurrent` or switch to QUEUE strategy.

---

### Problem: High queue wait times

**Check**:
1. Metrics: `avgQueueWaitMs`, `maxQueueWaitMs`
2. Job completion rate vs. enqueue rate

**Fix**: Increase `maxConcurrent` or scale worker instances.

---

### Problem: Memory usage growing

**Check**:
1. `queuedJobs` count
2. Heap usage

**Fix**: Reduce `maxQueueSize` or clear queue manually.

---

### Problem: Metrics show 0 active jobs but limit still reached

**Check**: Slot leak — jobs completed but slots not released.

**Fix**: Restart service. File a bug report with job IDs.

---

## References

- [Bull Documentation](https://github.com/OptimalBits/bull)
- [Backpressure Patterns](https://mechanical-sympathy.blogspot.com/2012/05/apply-back-pressure-when-overloaded.html)
- [Rate Limiting Strategies](https://cloud.google.com/architecture/rate-limiting-strategies-techniques)
- [NestJS Event Emitter](https://docs.nestjs.com/techniques/events)

---

## Changelog

- **2024-11-21**: Initial implementation (Issue #34)
  - ConcurrencyLimiterService with three backpressure strategies
  - Integration with BackgroundWorkerService
  - API endpoints for metrics and configuration
  - Comprehensive test coverage and documentation

# Bounded queue backpressure for expensive background work (#263)

`BoundedWorkQueue` (`src/common/backpressure/bounded-work-queue.ts`) caps how
much expensive work (exports, reconciliations, report builds) one process
accepts. It is opt-in: nothing is wired in by default, so existing contracts
are unchanged.

```ts
const queue = new BoundedWorkQueue({
  name: "export",
  permission: Permission.EXPORT_EXECUTE,
  maxConcurrent: 2,
  maxQueued: 20,
  maxQueuedPerActor: 3,
  maxAttempts: 3,
  retryDelayMs: 200,
});
const result = await queue.submit({ id: user.id, roles: user.roles }, (attempt) => buildExport());
```

## Behavior

| Path | Outcome |
| --- | --- |
| Slot free | Task starts immediately. |
| All slots busy, room to wait | Task waits; started FIFO as slots free up. |
| Waiting room full, or actor over `maxQueuedPerActor` | Rejected at once with `RateLimitException` (HTTP 429, `retryAfterSeconds`). Nothing is buffered. |
| Actor lacks `permission` | `ForbiddenException` (403) before any capacity is consumed. |
| Task fails | Retried up to `maxAttempts` with exponential backoff (`retryDelayMs * 2^(n-1)`), only if `isRetryable(error)`. The final error is surfaced and the slot is released. |

`stats()` exposes `running`, `queued`, `completed`, `failed`, `rejected` for
dashboards; `idle()` resolves when the queue is empty (useful for shutdown).

## Operational edge cases

- **Retries hold their slot.** A retrying task keeps its concurrency slot
  during backoff, so a failing dependency cannot cause a retry flood beyond
  `maxConcurrent`. Size `maxAttempts * retryDelayMs` accordingly.
- **State is per process.** Limits are not shared across replicas; the
  effective cluster limit is `replicas * maxConcurrent`. Callers that get a
  429 should honor `Retry-After` and retry.
- **Restart loses waiting work.** The queue is in-memory. Producers must be
  able to resubmit (use idempotency keys); do not use it for work that must
  survive a crash.
- **Tasks must be idempotent** if `maxAttempts > 1`; the attempt number is
  passed to the task.
- **A stuck task** occupies a slot until it settles. Give tasks their own
  timeout; the queue deliberately does not cancel running work.

## Recovery and rollback

Purely additive and in-memory: removing the queue (or never constructing it)
restores the previous behavior; there is no schema or contract change.
If rejections spike, raise `maxQueued`/`maxConcurrent` via configuration and
restart; rejected callers hold no state and can simply retry.

## Verification

`src/common/backpressure/bounded-work-queue.spec.ts` covers: normal
execution, the concurrency ceiling and FIFO drain, 429 with Retry-After,
per-actor fairness, authorization, retry with backoff, retry exhaustion,
non-retryable errors, failure isolation, and configuration validation. The
spec uses an injected `sleep`, so it is deterministic and time-free.

# Partial-failure triage endpoint

Maintainers can use `GET /retry-scheduler/failures` to page through failed and
dead-letter operations, optionally filtering by `operationType` or a search
string matching operation ID, correlation ID, or the last error. The response
omits operation payloads and includes the cause, retryability, attempt counts,
and a suggested next action. Results are capped at 100 per request.

The route uses the existing JWT and maintainer-role guards. Dead-letter retries
continue through `POST /retry-scheduler/dead-letters/:operationId/retry`, which
is restricted to administrators. Non-retryable failures should be investigated
instead of resubmitted. This first slice covers the retry-scheduler operation
store; integration-specific health and user-action workflows can be added by
their owning modules.

## Dead-letter operator tooling (#269)

| Method | Route | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/retry-scheduler/dead-letters` | `MAINTAINER` | Page dead letters; `limit` is clamped to 1–100 and `offset` to ≥ 0. |
| `GET` | `/retry-scheduler/operations/:operationId` | `MAINTAINER` | Inspect one operation, including `metadata.deadLetter` and `metadata.deadLetterRetries`. |
| `POST` | `/retry-scheduler/dead-letters/:operationId/retry` | `ADMIN` | Re-queue one operation; body `{ maxAttempts?, reason?, force? }`. |
| `POST` | `/retry-scheduler/dead-letters/retry` | `ADMIN` | Re-queue up to 100 of the oldest retryable dead letters; body `{ operationType?, limit?, reason? }`. |

- **Non-retryable failures.** When an operation is dead-lettered, the scheduler
  records `metadata.deadLetter = { reason, retryable }`. A retry of a
  non-retryable failure returns `409` unless `force: true` is sent after the
  cause is fixed. Bulk retry never forces: it reports such items as
  `skipped_non_retryable`.
- **Concurrent retries.** The re-queue is a single `UPDATE … WHERE status = 'dead_letter'`,
  so of two concurrent retries exactly one wins. The other gets `404` (single)
  or `already_retried` (bulk).
- **Audit trail.** Each retry appends `{ at, by, reason, forced, previousAttempts, previousError }`
  to `metadata.deadLetterRetries` (the last 10 are kept) and emits
  `retry.dead_letter_retried`.
- **Rollback.** A re-queued operation that fails again returns to the dead
  letter with its retry history intact. No schema change is involved: both
  fields live in the existing `metadata` JSONB column.

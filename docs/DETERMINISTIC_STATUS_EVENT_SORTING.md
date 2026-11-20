# Deterministic Sorting for Status and Event Lists

`src/common/sorting/status-event-list-sorter.ts` provides a focused vertical slice for reproducible, permutation-invariant ordering of status and event lists (`sortStatusList`, `sortEventList`, `fetchAndSortStatusList`, `fetchAndSortEventList`).

## Covered Paths

- **Normal path**:
  - `sortStatusList` orders by status priority (highest urgency first), optional `severity` ascending, `updatedAt` (default `DESC`), and `id` tie-breaker (`ASC`).
  - `sortEventList` orders by `timestamp` (default `DESC`), optional monotonic `sequence`, `type` (`ASC`), and `id` tie-breaker (`ASC`).
  - Neither function mutates the caller's input array.
- **Retry path**: `fetchAndSortStatusList` and `fetchAndSortEventList` retry transient fetch errors up to `maxAttempts` (default `3`) with exponential backoff (`100 * 2^(attempt - 1)` ms unless `backoffMs` is set).
- **Failure path**:
  - Validation errors (`DeterministicSortValidationError`: missing `id`, invalid timestamp, or duplicate `id` when `rejectDuplicateIds: true`) and errors marked `retryable: false` fail fast without extra retry attempts.
  - Persistent fetch errors surface after exhausting `maxAttempts`.
- **Authorization path**:
  - When `requireAuthorizedActor: true`, `actor`, or `requiredTenantId` is provided, actor role membership (`ADMIN`, `OPERATOR`, `AUDITOR`, `USER` by default) and tenant scope are checked before any fetch executes, throwing `UnauthorizedListSortError` fail-closed.

## Edge Cases

- **Tied timestamps and statuses**: Resolved deterministically via `id` lexicographical tie-breaking, guaranteeing identical output regardless of upstream arrival order.
- **Missing `sequence` on mixed events**: Events with a numeric `sequence` sort ahead of events without one when timestamps tie.
- **Unknown statuses**: Assigned fallback priority `999` so they sort deterministically after known lifecycle states.
- **Malformed timestamps**: Rejected by default (`rejectInvalidTimestamps: true`); when disabled, sorted consistently to the end (`-Infinity`).

## Recovery and Rollback Behavior

- Sorting is pure and stateless; if a fetch fails after retry exhaustion, callers can safely retry the read request without side effects.
- Rolling back this feature requires only reverting the additive module; no database schema or persisted state is modified.

## Contract Preservation

Existing `DeterministicSorter` (`src/common/sorting/deterministic-sorter.ts`) and all existing API endpoints remain untouched and fully backward compatible.

## Automated Tests and Executable Verification

```bash
npx jest src/common/sorting/status-event-list-sorter.spec.ts
node scripts/verify-deterministic-status-event-sorting.js
```

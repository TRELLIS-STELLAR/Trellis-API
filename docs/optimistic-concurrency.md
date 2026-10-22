# Optimistic concurrency

Mutable API resources should expose a numeric `version` (or an HTTP `ETag`)
when they are read. Clients must send that value back with an update. The
server compares it with the current record inside the same transaction and
increments it only after a successful write.

A stale update returns `409 Conflict` with the recovery action `refresh`; it
must not overwrite the newer record. The client should fetch the current
representation, show the user the conflicting changes, and retry with the new
version after the user confirms the merge.

`OptimisticConcurrencyService` contains the shared comparison and version
increment rules. Repository-backed workflows should call `assertCurrent` while
holding the update transaction/lock and use `nextVersion` for the persisted
value.

## Deterministic conflict resolution for multi-client edits (#272)

`POST /portfolio/:portfolioId/allocations?baseVersion=N` merges an edit that
was made against version `N` with the changes stored since then, instead of
silently overwriting them. Target allocations are stored as immutable versions,
so version `N` serves as the merge base.

`threeWayMerge(base, current, proposed)` in `src/common/concurrency/conflict-resolver.ts`
resolves each ticker independently:

| Proposed vs current/base | Result |
| --- | --- |
| proposed = current | keep it (both agree, or the edit is a retry) |
| proposed = base | keep current (only another client changed it) |
| current = base | take proposed (only this client changed it) |
| all three differ | conflict |

Tickers are visited in sorted order, so the outcome depends only on the three
snapshots. Cost is O(k log k) for k tickers.

| Case | Response |
| --- | --- |
| `baseVersion` omitted | Unchanged last-writer-wins behaviour. |
| `baseVersion` = current | Written as version `current + 1`, `merged: false`. |
| Stale but disjoint edit | Merged and written as a new version, `merged: true`. |
| Overlapping edit | `409` with `{ expectedVersion, actualVersion, action: "refresh", conflicts: [{ field, base, current, proposed }] }`. Nothing is written. |
| Merge breaks the 100% sum | `409`. Nothing is written. |
| Retried edit already applied | No new version; returns the current version. |
| Unknown or future `baseVersion` | `409 refresh`. A negative or non-integer value is `400`. |

The current and base versions are read under the portfolio's
`pessimistic_write` lock, so concurrent writers are serialized. The existing
`PortfolioOwnerGuard` still authorizes the route. To roll back to an earlier
allocation, re-post it: history is append-only.

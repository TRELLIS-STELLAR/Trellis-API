# Snapshot restore verification

After restoring PostgreSQL, call `POST /api/v1/snapshots/verify-restore` with
the snapshot ID. The service verifies the snapshot hash, HMAC, and recorded
payload count; compares row counts for critical tables; rebuilds the
Elasticsearch `posts` index from active `search_records`; refreshes the index;
and checks that the indexed document count matches the PostgreSQL source.

```json
{ "snapshotId": "<snapshot-id>" }
```

The response is valid only when the snapshot integrity checks, all critical
table counts, and the rebuilt search index agree. A mismatch returns the
expected and observed counts plus a repair step. Stop writes while critical
table counts differ. If index rebuilding fails, restore Elasticsearch
connectivity and rerun verification; persistent failures should be handled
through the normal search-index repair runbook.

The manifest covers `users`, `portfolios`, `portfolio_assets`, `transactions`,
`agent_reviews`, `agent_events`, `background_jobs`, `retry_operations`,
`audit_logs`, `sensitive_action_events`, `provenance_records`, and
`search_records`. Counts detect incomplete table restores; the signed snapshot
payload protects the captured manifest from unnoticed modification. This check
does not claim to compare every database row byte-for-byte.

Snapshots created before the manifest was added can still be checked with the
existing `POST /api/v1/snapshots/verify` endpoint, but they cannot be used for
restore verification. Create a fresh snapshot before the next restore window.

`SnapshotService` currently keeps snapshot records in process memory. A restore
that restarts the API must retain and reload the signed snapshot record through
the deployment's backup workflow before calling `verify-restore`; durable
snapshot metadata storage is not part of this change.

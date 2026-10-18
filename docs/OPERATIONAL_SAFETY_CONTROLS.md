# Operational safety controls

## Notification and webhook duplicate suppression

Notification dispatch reuses a failed per-channel delivery log and suppresses a retry once that channel is `sent` or `delivered`. This avoids a duplicate provider call when a worker crashes after the provider accepts a request. Failed logs remain retryable; terminal failures still follow the configured retry/dead-letter path. Operators must not delete delivery logs while a notification is queued, because that removes the retry idempotency evidence. Webhook inbound events retain their existing `(sourceSubscriptionId, externalEventId)` uniqueness contract.

Recovery: pause the queue before repairing a corrupted delivery log, then replay only the failed/dead-letter item. Rollback is safe: restore the prior processor version; delivery logs remain compatible and no schema migration is required.

## Sensitive-data retention and deletion

Audit retention previews are read-only and report eligible and protected record IDs. Enforcement deletes only records older than the retention cutoff without an evidence hold, dispute, case, or settlement marker. A repository failure leaves the candidate rows intact for the next scheduled retry. Retention holds must be released before retrying deletion. Deletion is irreversible; recover from the approved archive/evidence export, not from production tables.

## Policy dry runs

`POST /policy/simulations/preview` is read-only and returns masked affected-record previews, side effects, rollback constraints, and a commit token for high-impact changes. Commits reject stale snapshots, invalid policies, and absent/mismatched tokens. Authorization remains enforced by the controller guards. If a commit must be reversed, use the recorded rollback snapshot; manually reconcile declared irreversible side effects such as on-chain actions and revoked sessions.

## Security-event session containment

Refresh-token replay revokes the full token family and uses a TTL-bound revocation store. Redis failures fall back to local state only; multi-replica operators should treat that as degraded containment, restore Redis, then revoke affected families again. Users must re-authenticate after security-event revocation. Do not roll back a revocation by restoring a token row; issue a new authenticated session instead.

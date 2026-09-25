# Operational Data Controls

## Feature flags

Feature flags are server-side and fail closed. `RECONCILIATION_HORIZON_POLLING` must be set to `true` before the scheduled Horizon poller ingests new payments. Roll back by setting it to `false`; no redeploy is required when the environment is managed dynamically.

## Maintainer report

Administrators can request `GET /monitoring/operational-health` with the normal JWT and admin two-factor checks. The report counts unresolved reconciliation transactions, failed invoices, and un-retried webhook dead letters. It returns opaque record IDs and internal investigation links, never webhook payloads, delivery URLs, request headers, or payment payloads.

## Retention

Audit logs are retained for seven years. `previewRetention()` reports the candidate IDs before deletion; the scheduled cleanup deletes only eligible records. Records with `retentionHold`, `activeDisputeId`, `auditCaseId`, or `settlementId` metadata are protected until the associated matter is resolved. Audit exports remain signed and are not deleted by this job.

## Stable lists

Audit-log and review connections use opaque descending keyset cursors ordered by `(createdAt, id)`. Filters are applied before the cursor predicate, so hidden or restricted records cannot change the visible ordering. The legacy page parameters remain available for compatibility.
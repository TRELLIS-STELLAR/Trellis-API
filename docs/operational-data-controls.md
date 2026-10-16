# Operational Data Controls

## Feature flags

Feature flags are server-side and fail closed. `RECONCILIATION_HORIZON_POLLING` must be set to `true` before the scheduled Horizon poller ingests new payments. Roll back by setting it to `false`; no redeploy is required when the environment is managed dynamically.

## Maintainer report

Administrators can request `GET /monitoring/operational-health` with the normal JWT and admin two-factor checks. The report counts unresolved reconciliation transactions, failed invoices, and un-retried webhook dead letters. It returns opaque record IDs and internal investigation links, never webhook payloads, delivery URLs, request headers, or payment payloads.

## Retention

### Operational audit metadata classification

| Class | Fields | Purpose and handling |
| --- | --- | --- |
| Required audit evidence | action, timestamp, resource type, outcome | Keep for the audit record's retention window. |
| Restricted identifiers | user ID, resource ID, IP address, retention/case IDs | Keep only where needed for accountability, access review, or a legal hold; access remains governed by the audit endpoints. |
| Minimized context | details and metadata | Redact email/secret values, cap free-form details at 500 characters, and retain only the approved reason/source and case/impersonation keys. |
| Discarded diagnostics | user-agent string, arbitrary payload/debug fields | Do not persist; these are not used by audit queries or retention decisions. |

Audit logs are retained for seven years. `previewRetention()` reports candidate IDs before deletion; the scheduled cleanup deletes only eligible records. Records with `retentionHold`, `activeDisputeId`, `auditCaseId`, or `settlementId` metadata are protected until the associated matter is resolved. Audit exports remain signed and are not deleted by this job. Cleanup failure leaves source rows in place; operators can rerun the job after restoring database access. For rollback, disable the scheduled audit-retention job in deployment configuration and restore a database backup if an approved deletion removed records unexpectedly. Do not extend retention by changing the cutoff without a compliance review.

## Stable lists

Audit-log and review connections use opaque descending keyset cursors ordered by `(createdAt, id)`. Filters are applied before the cursor predicate, so hidden or restricted records cannot change the visible ordering. The legacy page parameters remain available for compatibility.

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

### Retention Enforcement API & Operational Paths

Compliance officers can query and trigger retention workflows on demand via the API:

```http
# Read-only preview of eligible vs protected audit records
GET /audit-logs/retention/preview
Authorization: Bearer <COMPLIANCE_OFFICER_TOKEN>

# Manual execution of retention cleanup with automated deletion verification
POST /audit-logs/retention/enforce
Authorization: Bearer <COMPLIANCE_OFFICER_TOKEN>

# Explicit verification of permanent record deletion
POST /audit-logs/retention/verify
Authorization: Bearer <COMPLIANCE_OFFICER_TOKEN>
Content-Type: application/json

{
  "ids": ["log-uuid-1", "log-uuid-2"]
}
```

#### Operational Path Guarantees
1. **Normal Path**:
   - The scheduled job runs daily at 3:00 AM UTC (`@Cron(CronExpression.EVERY_DAY_AT_3AM)`) under distributed lock `audit:enforce-retention` (30m TTL).
   - Records older than 7 years (`RETENTION_YEARS = 7`) without active holds are selected and permanently deleted using `repo.remove()`.
   - Post-purge deletion verification (`verifyDeletion`) immediately queries the repository to confirm zero remaining records for the purged IDs, reporting `verificationPassed: true`, `verifiedDeletedCount`, and empty `unverifiedIds: []`.
   - Records containing active legal/dispute holds (`retentionHold: true`, `activeDisputeId`, `auditCaseId`, or `settlementId`) are strictly preserved.
   - `GET /audit-logs/retention/preview` returns `{ cutoff, scanned, eligible, protected, affectedIds, protectedIds }` with zero deletions.
2. **Failure Path**:
   - If `repo.remove()` or the database fails, the transaction aborts cleanly without partial writes. Protected rows are never deleted.
   - If records are partially deleted or linger in storage after deletion, `verifyDeletion` flags `verificationPassed: false` and lists all `unverifiedIds` in the `RetentionReport` without misreporting success.
   - Malformed metadata (null, non-object, missing keys) fails safe: records without active hold keys are eligible for deletion, and malformed entries never crash the retention scanner.
3. **Retry Path**:
   - Retention enforcement is completely idempotent: if an execution fails midway, rerunning `enforceRetention()` picks up remaining eligible records.
   - Running retention back-to-back produces `{ scanned: N, eligible: 0, protected: P, affectedIds: [], verifiedDeletedCount: 0 }` on the second run.
   - `verifyDeletionWithRetry` retries transient verification queries with exponential backoff (up to 3 attempts).
   - Distributed lock ensures cluster nodes do not run concurrent retention tasks.
4. **Authorization Path**:
   - Guarded by `JwtAuthGuard` and `ComplianceOfficerGuard`.
   - Access to `preview`, `enforce`, and `verify` endpoints is restricted to `Role.ADMIN` and `Role.KYC_OPERATOR` (compliance officers).
   - Standard users and operators receive 403 Forbidden; unauthenticated callers receive 401 Unauthorized.
5. **Rollback & Edge-Case Recovery**:
   - **Emergency Hold**: If records must be urgently protected from purge, apply an active dispute ID or set `retentionHold: true` in metadata via evidence bundle generation.
   - **Hold Release**: When a dispute, settlement, or case is closed, the hold flag is removed, allowing the record to become eligible during the next scheduled run.
   - **Accidental Deletion Rollback**: If records were deleted in error, disable the scheduled retention cron in deployment configuration and restore the affected partition from the point-in-time PostgreSQL backup. Signed audit exports remain immutable in object storage and are never deleted by this job.

## Stable lists

Audit-log and review connections use opaque descending keyset cursors ordered by `(createdAt, id)`. Filters are applied before the cursor predicate, so hidden or restricted records cannot change the visible ordering. The legacy page parameters remain available for compatibility.

## Evidence Bundles for Support Investigations

Exportable evidence bundles for customer disputes and compliance investigations are generated via `POST /api/v1/audit-trail/evidence-bundles/generate`. Bundles sanitize secrets, tokens, PII, and client network fingerprints while preserving verifiable transaction hashes, monetary amounts, and timestamps. When requested with `placeRetentionHold: true`, records receive `auditCaseId` metadata protecting them from scheduled retention purge until the investigation concludes. See [`docs/audit-evidence-bundles.md`](audit-evidence-bundles.md) for complete specification and rollback procedures.

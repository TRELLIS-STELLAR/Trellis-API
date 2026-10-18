# Release Readiness Checklist

This document outlines the release readiness process for Trellis API. All **critical changes** must pass the release checklist before merge and deployment.

## Overview

The release readiness checklist ensures that changes meet production standards across five key areas:
- **Tests**: Unit, integration, and edge case coverage
- **Migrations**: Reversibility, locking behavior, and safe backfills
- **Configuration**: Environment validation and secrets management
- **Documentation**: API contracts, deployment steps, breaking changes
- **Rollback**: Procedure definition, data safety, and monitoring

## What Counts as Critical?

A change is critical if it touches:
- Schema or database migrations
- Authentication or authorization logic
- Payment, billing, or financial features
- Data export or privacy-sensitive features
- Core configuration or deployment procedures

Non-critical changes require only the subset of **CRITICAL** severity checks.

## Checklist Categories

### Tests (CRITICAL & HIGH)
- **Unit Test Coverage** (CRITICAL): ≥80% coverage for changed files; `npm run test:coverage` passes
- **Integration Tests** (HIGH): `npm run test:integration` passes; no flaky tests
- **Edge Case Tests** (HIGH): 2+ edge cases per feature; sad path testing

### Migrations (CRITICAL & HIGH)
- **Migration Reversibility** (CRITICAL): Every migration has a `down()` function; tested: up → down → up
- **No Long Locks** (HIGH): Avoid `LOCK TABLE` on large tables; use `CONCURRENTLY` for indexes
- **Safe Backfill** (HIGH): Tested with ≥100k rows; no timeouts or OOM

### Configuration (CRITICAL & MEDIUM)
- **Environment Validation** (HIGH): `.env.example` updated; ConfigService validates on boot
- **Secrets Not Committed** (CRITICAL): No secrets in code; `.env` in `.gitignore`; `npm audit` passes
- **Feature Flags** (MEDIUM): Risky features behind toggles; no redeployment to disable

### Documentation (HIGH & MEDIUM)
- **API Contract Updated** (HIGH): OpenAPI/GraphQL schema and docs match changes
- **Deployment Steps** (HIGH): Step-by-step instructions in docs or PR description
- **Breaking Changes** (HIGH): CHANGELOG.md updated; migration guide linked

### Rollback (CRITICAL & HIGH)
- **Rollback Procedure** (CRITICAL): Clear steps in docs/RUNBOOK.md; tested on staging
- **Data Safety** (CRITICAL): Backward compatible; new columns can be null
- **Rollback Monitoring** (HIGH): Error rate, latency, and consistency metrics monitored

### Performance (HIGH & MEDIUM)
- **No Regression** (HIGH): Benchmark tests pass; no O(n²) algorithms; queries indexed
- **Scaling** (MEDIUM): Known limits documented (max rows, rate limits, job queue behavior)

## Automatable Checks & Verification Suite

Trellis API provides an automated verification runner and CLI suite:

```bash
# Full automated release readiness invariant verification (migrations, smoke tests, rollback)
npm run verify:release-readiness

# Automated unit tests for release readiness
npx jest src/common/release/release-readiness.spec.ts

# Unit test coverage
npm run test:coverage

# Integration tests
npm run test:integration

# Secrets audit
npm audit
```

### Automated Verification API

Maintainers and CI/CD pipelines can trigger automated verification via the REST API:

```http
POST /api/v1/admin/release-checklist/{prNumber}/verify
Content-Type: application/json
Authorization: Bearer <ADMIN_JWT>

{
  "migrations": [
    { "filename": "1787313600000-create-module-registry.ts", "content": "..." }
  ],
  "smokeProbes": [
    { "name": "health-check", "endpoint": "/health", "required": true }
  ],
  "schemaChanges": [
    { "table": "users", "column": "avatarUrl", "isNew": true, "isNullable": true, "hasDefault": false }
  ],
  "options": {
    "maxAttempts": 3,
    "backoffMs": 150
  }
}
```

The endpoint runs migration safety parsing, executes smoke probes with retry/backoff, and evaluates rollback backward-compatibility, automatically updating checklist statuses.

## Verification Invariants & Rules

### 1. Migrations
- **Reversibility**: Every migration must define an operational `down()` method. Migrations with empty down bodies or `throw new Error("irreversible")` fail verification.
- **Locking Safety**: Rejects `LOCK TABLE` or `ACCESS EXCLUSIVE` in `up()`. These acquire table-level exclusive locks that stall live requests.
- **Concurrent Indexing**: PostgreSQL `CREATE INDEX` queries must use `CONCURRENTLY` to avoid read/write locks on live tables.
- **Column Defaults**: New columns added to existing tables must be `NULLABLE` or have a `DEFAULT`. `NOT NULL` without `DEFAULT` breaks concurrent writes from old application versions and prevents zero-downtime rollback.

### 2. Smoke Tests with Automated Retry
- **Transient Recovery**: Network probes and preflight endpoints are retried up to `maxAttempts` (default 3) with exponential backoff (multiplier 100-200ms) before reporting failure.
- **Attempt Tracking**: Metrics distinguish immediate successes from retry recoveries (`succeeded on retry attempt N`).
- **Required vs Optional**: Required probes (database ping, auth challenge, health live) fail the gate if retries exhaust. Optional probes (third-party analytics, external webhook pings) record warnings without blocking release.

### 3. Zero-Downtime Rollback Safety
- **Backward Compatibility**: In a rolling deployment, version N-1 code runs alongside version N database. Any schema change that breaks version N-1 queries is flagged as a breaking change.
- **Column Lifecycle**:
  - *Phase 1*: Add column as nullable or defaulted. Deploy code that writes both versions.
  - *Phase 2*: Backfill historical rows.
  - *Phase 3*: Add `NOT NULL` constraints only after 100% population.
- **Revert Safety**: Down migrations must not drop tables or truncate records without an approved runbook and explicit waiver.

### 4. Authorization & Waiver Audit Trail
- All checklist mutations require `Role.ADMIN` enforced by `JwtAuthGuard` and `RolesGuard`.
- Waivers require an approver identity and a detailed justification (minimum 10 characters).
- Every state transition (`CREATE`, `CHECK_UPDATE`, `WAIVE`, `APPROVE`, `AUTOMATED_VERIFY`) is recorded in an audit log with actor and timestamp.

## Release Gate

Issue #372. `evaluateReleaseGate` in `src/common/release/release-gate.ts` turns
the three kinds of release evidence into one decision. It reuses the migration
and rollback analysis above and performs no I/O.

```bash
npm run release:gate -- evidence.json   # exit 0 PASS, 1 BLOCKED, 2 bad input
```

```json
{
  "releaseId": "v1.2.3",
  "tests": {
    "requiredSuites": ["unit", "e2e"],
    "suites": [{ "name": "unit", "passed": 100, "failed": 0 }, { "name": "e2e", "passed": 20, "failed": 0, "retries": 1 }]
  },
  "migrations": [{ "filename": "1-add-col.ts", "content": "..." }],
  "schemaChanges": [{ "table": "users", "column": "flag", "isNew": true, "isNullable": true, "hasDefault": false }],
  "rollback": {
    "rehearsedAt": "2026-10-15T10:00:00Z",
    "rehearsedBy": "ops@example.com",
    "previousVersion": "v1.2.2",
    "revertCommand": "npm run migration:revert",
    "outcome": "passed",
    "evidenceUrl": "https://..."
  },
  "waivers": []
}
```

| Gate | Blocks when |
| --- | --- |
| `tests` | No required suites are declared, a required suite has no result, a suite has failures or ran nothing. A suite that passed only after `retries` is a warning. |
| `migrations` | Any migration lacks a working `down()`, takes an exclusive lock, or adds a `NOT NULL` column without a default. |
| `rollback` | Schema changes have no rehearsal, the rehearsal failed, is older than 14 days, is dated in the future, or lacks the previous version, revert command, or rehearser; or the schema changes break rollback. |

Authorization: a blocked gate can be waived only by an entry with
`approverRole: "ADMIN"`, an approver, and a reason of at least 10 characters.
A waiver covers only its own gate, and the waived findings stay in the output as
warnings for the audit trail. Rejected waivers add the reason to the blocking
list. The CLI trusts the evidence document, so CI must build it from the real
test run and keep waiver entries out of contributor-editable files.

Edge cases and recovery:

- Rerunning the gate on the same evidence gives the same result, so it is safe to
  retry in CI.
- A stale rehearsal is not a code failure; rehearse the rollback again and
  update `rehearsedAt`.
- A flaky suite does not block, but repeated `retries` warnings should be
  investigated before they hide a real failure.
- If the gate itself is wrong or unavailable, release with an ADMIN waiver and
  open a follow-up issue; do not delete the failing evidence.
- Rollback of this change is removing `release:gate`; nothing else depends on
  it and no data or API contracts change.

Verify with `npx jest src/common/release/release-gate.spec.ts`.

## Checklist API

### Create Checklist

```http
POST /api/v1/admin/release-checklist
Content-Type: application/json

{
  "prNumber": "123",
  "title": "Add Redis Sentinel support",
  "files": ["src/common/cache/cache-redis.factory.ts"]
}

Response:
{
  "checklist": { ... },
  "summary": {
    "total": 12,
    "passed": 0,
    "failed": 0,
    "blocked": 0,
    "waived": 0,
    "notStarted": 12,
    "readinessPercent": 0,
    "overallStatus": "NEEDS_ATTENTION"
  }
}
```

### Update Check Result

```http
PATCH /api/v1/admin/release-checklist/{prNumber}/checks/{checkId}
Content-Type: application/json

{
  "status": "PASSED",
  "evidenceUrl": "https://github.com/.../runs/123456",
  "notes": "All tests passed locally and in CI"
}
```

### Get Checklist Status

```http
GET /api/v1/admin/release-checklist/{prNumber}

Response:
{
  "checklist": { ... },
  "summary": { ... },
  "markdown": "## Release Readiness Checklist\n..."
}
```

### Waive Check

```http
PATCH /api/v1/admin/release-checklist/{prNumber}/waive/{checkId}
Content-Type: application/json

{
  "reason": "Not applicable to this deployment phase",
  "approvedBy": "maintainer@example.com"
}
```

### Approve Release

```http
PATCH /api/v1/admin/release-checklist/{prNumber}/approve
Content-Type: application/json

{
  "approvedBy": "maintainer@example.com"
}

Response:
{
  "status": "success",
  "message": "Release approved",
  "canDeploy": true
}
```

## Exception Handling

### Emergency Fixes

If a critical production issue requires bypassing the checklist:

1. Document the severity and justification
2. Obtain approval from at least **2 maintainers**
3. Create a follow-up issue to audit the change
4. Post-merge, run deferred checks and waive with justification

### Partial Deployments

If deploying to staging first:

1. Checklist must pass before staging deployment
2. Staging observations may inform rollback plans
3. Same checklist requirement for production deployment

## Maintainer Sign-Off

Maintainer approval confirms:

- ✅ All critical checks passed or waived with justification
- ✅ Tests cover the intended behavior and edge cases
- ✅ Migrations are safe and reversible
- ✅ Rollback procedure is documented and tested
- ✅ No secrets or sensitive data in code
- ✅ Documentation is complete and accurate

## Examples

### Critical Change: Schema Migration

```yaml
PR: "Add user_preferences table and foreign key from users"
Files:
  - src/auth/entities/user-preference.entity.ts
  - db/migrations/20250127_create_user_preferences.ts

Checklist Status:
  - test_unit_coverage: PASSED (82%)
  - test_integration: PASSED
  - migration_reversibility: PASSED (tested up/down/up)
  - migration_locking: PASSED (CONCURRENTLY used)
  - docs_deployment: PASSED
  - rollback_procedure: PASSED
  - performance_no_regression: PASSED

Approval: ✅ READY for deployment
```

### Non-Critical: Documentation Update

```yaml
PR: "Update API documentation for portfolio endpoint"
Files:
  - docs/API.md

Checklist Status:
  - test_unit_coverage: NOT_APPLICABLE
  - docs_api_contracts: PASSED

Approval: ✅ READY to merge
```

## See Also

- [MIGRATION_SAFETY.md](./MIGRATION_SAFETY.md) — Detailed migration guidelines
- [OPERATIONAL_RUNBOOK.md](./OPERATIONAL_RUNBOOK.md) — Incident and rollback procedures
- [docs/DEPLOYMENT.md](./DEPLOYMENT.md) — Deployment playbook

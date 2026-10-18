# Release Readiness Gate & Rollback Runbook

This document defines the release readiness checklist, operational gates, failure modes, and rollback runbooks for Trellis API. All deployments to staging and production must satisfy this gate.

---

## 1. Release Readiness Gate Architecture

The automated Release Readiness Gate (`scripts/release-readiness-gate.ts`) evaluates the candidate release against five verification pillars before authorizing a deployment:

```
+-----------------------------------------------------------------------------------+
|                        TRELLIS API RELEASE READINESS GATE                         |
+-----------------------------------------------------------------------------------+
  |
  +---> [1] Database Migration Verification
  |         - Symmetric `up()` and `down()` hooks present in every migration
  |         - No empty, stubbed, or irreversible operations without waiver
  |         - Unit tests (`.spec.ts`) validate forward and inverse schema mutations
  |
  +---> [2] Automated Rollback Rehearsal
  |         - Simulated execution of `down()` methods via mock QueryRunner
  |         - Detection of schema asymmetry (tables/indexes created but not dropped)
  |         - Verification of reverse dependency ordering (foreign keys, views)
  |
  +---> [3] Security & Perimeter Audits
  |         - Scanning for hardcoded credentials, Stellar secret keys, or RSA keys
  |         - Enforcement of global KycGuard & AuthGuard perimeter
  |         - Prohibition of class-level `@SkipKyc()` bypasses
  |
  +---> [4] Smoke Tests & Operational Invariants
  |         - Verification of Kubernetes liveness and readiness probe endpoints
  |         - Disaster recovery domain invariant engine (`scripts/validate-dr-invariants.ts`)
  |         - Observability configuration (Sentry, Prometheus metrics, tracing)
  |
  +---> [5] Documentation & Rollback Plan Completeness
            - Verification that operational recovery and rollback runbooks are present
            - Verified rollback rehearsed with clear runbook steps
```

---

## 2. Pre-Release Readiness Checklist

Use this checklist prior to merging pull requests and cutting a production release:

### Database & Migrations
- [ ] Every new TypeORM migration has been generated with timestamp prefix.
- [ ] Both `up(queryRunner)` and `down(queryRunner)` are fully implemented.
- [ ] A matching `src/migrations/<timestamp>-<name>.spec.ts` exists and tests both `up()` and `down()`.
- [ ] Destructive schema changes (e.g. dropping columns/tables) follow the multi-phase Expand/Contract release pattern.
- [ ] Migration rollback rehearsal passed: `npm run release:gate`.

### Security & Perimeter
- [ ] No secrets, Stellar secret seeds (`S...`), or private keys committed to source.
- [ ] Sensitive endpoints are protected by `JwtAuthGuard`, `KycGuard`, and RBAC roles.
- [ ] No controller uses class-level `@SkipKyc()`.
- [ ] Dependencies scanned with `npm audit --audit-level=moderate`.

### Smoke & Integration
- [ ] `/health/liveness` returns `200 OK`.
- [ ] `/health/readiness` verifies database and Redis connectivity.
- [ ] Disaster recovery invariants pass cleanly: `npm run dr:validate`.
- [ ] OpenAPI schema shows 0 unintended drift: `npm run openapi:drift`.

---

## 3. Operational Failure Modes & Edge Cases

| Failure Mode | Root Cause | Impact | Mitigation / Early Detection |
| :--- | :--- | :--- | :--- |
| **Partial Migration Failure** | DDL statement failure midway through `up()` on a database engine without transactional DDL | Database left in half-migrated state; application fails to boot | Use non-destructive, idempotent DDL (`IF NOT EXISTS`), encapsulate statements in transactions where supported, and run `npm run release:gate` rollback rehearsal. |
| **Lock Contention / Table Lock Timeout** | Adding an index or column with heavy default values on large production tables | Query backlog, API latency spikes, HTTP 504 timeouts | Use `CONCURRENTLY` for Postgres index creation, add columns as `NULL` first before backfilling in background batches. |
| **Breaking Schema Drift During Rolling Deploy** | New application version expects new column that old version doesn't handle, or old application crashes on missing column when new DB version applies | Elevated error rate for in-flight requests during rolling update | Follow the two-phase **Expand / Contract** deployment pattern: Version N introduces nullable columns; Version N+1 backfills and enforces constraints. |
| **Rollback Execution Blocked by Dependent Data** | Rollback `down()` drops a table or column that has received new production foreign keys or constraints while running | `down()` fails with foreign key constraint violation | Rollback rehearsal tests reverse topological drop ordering; ensure cascade or manual child deletion logic in `down()`. |
| **Secret or Key Rotation Disruption** | Missing or malformed environment variables (`JWT_SECRET`, Stellar signing keys) upon cold start | Authentication failures, inability to sign on-chain transactions | Configuration validation runs at application bootstrap (`validateEnv`), failing fast before accepting user traffic. |

---

## 4. Rollback & Recovery Runbook

If a release exhibits severe anomalies, latency spikes, or elevated error rates, execute the following phased rollback procedure.

### Phase 1: Triage & Halt Traffic
1. **Divert Traffic or Pause Canary**: If deploying via canary or blue/green, switch router back to the stable baseline version immediately.
2. **Engage Incident Commander**: Post notification in `#incident-management` with initial error metrics and release commit hash.

### Phase 2: Application Rollback (Zero Schema Change)
If the release did **not** include database migrations:
1. Re-deploy previous container image tag:
   ```bash
   kubectl rollout undo deployment/trellis-api -n production
   kubectl rollout status deployment/trellis-api -n production
   ```
2. Verify application health:
   ```bash
   curl -f http://trellis-api:3000/health/readiness
   ```

### Phase 3: Database Migration Rollback (With Schema Change)
If the release included database migrations:
1. Check the currently applied migration status:
   ```bash
   npm run typeorm -- migration:show -d src/config/typeorm.config.ts
   ```
2. Revert the last applied migration:
   ```bash
   npm run migration:revert
   ```
3. If multiple migrations were applied, run `migration:revert` once for each applied migration in reverse order.
4. Verify database domain invariants:
   ```bash
   npm run dr:validate
   ```
5. Deploy previous application version:
   ```bash
   kubectl rollout undo deployment/trellis-api -n production
   ```

### Phase 4: Post-Rollback Smoke Verification
1. Run smoke tests:
   ```bash
   npm run test:contract
   ```
2. Check Sentry / monitoring dashboards for error resolution.
3. Conduct root-cause analysis (RCA) and document findings in incident report.

---

## 5. Automated CI Integration

The release readiness gate is executed automatically in CI via `.github/workflows/build-check.yml`:

```bash
# Run locally before submitting PR or cutting release
npm run release:gate

# JSON output for automated CD pipelines
npm run release:gate -- --json
```

A non-zero exit code blocks the release pipeline and generates detailed remediation instructions for failing checks.

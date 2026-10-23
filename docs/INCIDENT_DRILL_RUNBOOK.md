# Trellis API Incident Drill Runbook & Executable Verification Guide

This runbook defines repeatable, executable incident drills for the **Trellis API** across its core backend subsystems: **Authentication & Identity**, **Portfolio & Valuation**, **DeFi Protocol Adapters**, **Blockchain & Oracle Submissions**, **Stellar Settlement & Reconciliation**, **Notifications**, **Observability**, and **Public API Contracts**.

Every phase in this runbook is backed by automated, deterministic verification checks in [`IncidentDrillService`](../src/infrastructure/disaster-recovery/incident-drill.service.ts), CLI runners ([`scripts/run-incident-drill.ts`](../scripts/run-incident-drill.ts) and [`scripts/verify-incident-drill.js`](../scripts/verify-incident-drill.js)), and unit tests ([`incident-drill.service.spec.ts`](../src/infrastructure/disaster-recovery/incident-drill.service.spec.ts)).

For live production triage roles and severity definitions, use this document alongside the [Operational Runbook](OPERATIONAL_RUNBOOK.md) and [Disaster Recovery Invariants Guide](disaster-recovery-invariants.md).

---

## 1. Drill Objectives & Acceptance Gates

An incident drill passes only when all four operational capabilities are proven end-to-end:

1. **Containment & Rollback Safety**: Risky write scopes are paused with audit logs, pre-mitigation state is captured in a signed/redacted snapshot, unsafe schema or mutable-tag rollbacks are blocked, and post-rollback health probes (`live`, `ready`, `startup`, `metrics`) recover cleanly.
2. **Cross-Domain Data Validation**: Pre-repair corruption or drift across all 7 domain invariant categories (`AUTH_AND_IDENTITY`, `PORTFOLIO_AND_INVESTMENT`, `BLOCKCHAIN_AND_ORACLE`, `RECONCILIATION_AND_SETTLEMENT`, `DEFI_AND_POSITIONS`, `NOTIFICATIONS_AND_ALERTS`, `AUDIT_AND_PROVENANCE`) is detected, and post-repair state achieves `0` `CRITICAL` and `0` `ERROR` violations.
3. **Idempotent Recovery Execution**: Impacted user operations are registered in the Recovery Center, retried idempotently without duplicating irreversible side effects (payments, on-chain submissions, notifications), and transitioned to terminal `resolved` state with residual actions cleared.
4. **Redacted User-Impact Reporting**: Blast radius (unique users, operations, 7-decimal exposure units, normalized routes) is quantified accurately, notifications are queued with deterministic deduplication keys, and all secrets/tokens/keys are scrubbed before emission.

---

## 2. Quick-Start: Executable Verification Commands

Run the verification suite locally or in CI without requiring external network dependencies or mutating any database state:

```bash
# Run standalone zero-dependency verification (validates runbook, contracts, and all 5 drill scenarios)
npm run incident:drill:verify

# Run full TypeScript CLI incident drill suite (human-readable report)
npm run incident:drill

# Run CLI incident drill suite with machine-readable JSON output
npm run incident:drill -- --json

# Run a single targeted drill scenario
npm run incident:drill -- --scenario=SEV1_SETTLEMENT_AND_PORTFOLIO_DRIFT

# Run Jest unit & scenario tests for the incident drill harness
npx jest src/infrastructure/disaster-recovery/incident-drill.service.spec.ts

# Run live read-only database domain invariant checks (requires PostgreSQL)
npm run dr:validate
```

---

## 3. End-to-End Drill Execution Phases

### Phase 1: Emergency Write-Path Containment (`CONTAINMENT`)

Before attempting any rollback, migration fix, or manual reconciliation, isolate the affected subsystem using `PauseControlService`:

| Subsystem Under Drill | Recommended `PausableScope` | Effect |
| :--- | :--- | :--- |
| Settlement / Payments | `payments`, `settlements` | Halts new invoice settlements and payment dispatches while preserving read access |
| DeFi / Oracle | `oracle_submissions`, `webhooks` | Stops automated Soroban/Stellar price submissions and outbound webhook deliveries |
| Data Export / Snapshots | `exports` | Prevents concurrent bulk exports during state recovery |
| Auth / Key Compromise | `all` | Freezes all mutating operations protected by `@UseGuards(PauseControlGuard)` |

**Verification check**:
- Confirm every paused scope emits a `pause.activated` event and persists an immutable `PauseAuditLog` entry recording `actorId`, `actorRole`, and `reason`.

### Phase 2: Pre-Mitigation Signed State Snapshot (`SNAPSHOT_VERIFICATION`)

Capture a canonical, secret-redacted state snapshot via `SnapshotService` before modifying application binaries or running data repairs:

1. Collect bounded state (`limit <= 500`) for the affected scope (`auth`, `settlements`, `defi-oracle`, `full`).
2. Strip sensitive keys (`password`, `secret`, `token`, `privateKey`, `apiKey`, `jwtSecret`, `webhookSecret`, `authorization`, `mnemonic`, `seed`) and replace with `[REDACTED]`.
3. Canonicalize JSON keys alphabetically, compute the `SHA-256` `integrityHash`, and sign with `HMAC-SHA256` using `SNAPSHOT_SIGNING_KEY`.
4. Verify the snapshot via `verifySnapshot({ snapshotId })` before proceeding.

**Verification check**:
- `hashMatch === true` and `signatureMatch === true` (using `crypto.timingSafeEqual`).
- If either check fails, the drill harness immediately aborts rollback with strategy `blocked_tampered_snapshot`.

### Phase 3: Rollback Safety Gate & Probe Verification (`ROLLBACK`)

Evaluate whether the degraded release can be rolled back via immutable container digest or requires a forward-fix migration:

1. **Immutable Target Check**: Reject mutable tags such as `latest` or empty target digests. Always specify an immutable release SHA/digest (e.g., `sha256:good8811a`).
2. **Migration Compatibility Check**:
   - **Additive / Compatible Schema**: Proceed with `binary_rollback` to the previous validated release digest.
   - **Destructive / Incompatible Schema** (e.g., dropped/renamed column or table): **Block binary rollback** (`strategy: 'forward_fix_required'`). Old application binaries cannot safely read or write against a destructively mutated schema. Apply a forward-fix migration or execute a Data-Owner-approved point-in-time restore.
3. **API Contract Compatibility Check**: Confirm public OpenAPI routes and schemas remain compatible (`npm run test:contract`).
4. **Post-Rollback Health & Observability Gate**:
   - `GET /api/v1/health/live` returns `200`
   - `GET /api/v1/health/ready` returns `200` (PostgreSQL & Redis healthy)
   - `GET /api/v1/health/startup` returns `200`
   - `GET /api/v1/observability/metrics` reports error rate `< 1.0%` and normal queue depth.

### Phase 4: Cross-Domain Data Validation & Reconciliation (`DATA_VALIDATION`)

Before resuming paused write scopes, run read-only domain invariant validation (`DisasterRecoveryValidatorService`) and dry-run settlement reconciliation (`DryRunReconciliationService`):

1. Execute all 19 invariant checks across the 7 domain categories:
   - `AUTH_AND_IDENTITY`: `AUTH_ORPHANED_WALLETS`, `AUTH_STELLAR_KEY_FORMAT`, `AUTH_DUPLICATE_WALLETS`, `AUTH_ORPHANED_PROFILES`
   - `PORTFOLIO_AND_INVESTMENT`: `PORTFOLIO_ORPHANED_ASSETS`, `PORTFOLIO_ORPHANED_TRANSACTIONS`, `PORTFOLIO_VALUATION_CONSISTENCY`, `PORTFOLIO_ALLOCATION_RANGE`, `PORTFOLIO_TARGET_OVERSUBSCRIPTION`
   - `BLOCKCHAIN_AND_ORACLE`: `ORACLE_DUPLICATE_PRICE_RECORDS`, `ORACLE_MALFORMED_SIGNED_PAYLOADS`, `ORACLE_SUBMISSION_INTEGRITY`
   - `RECONCILIATION_AND_SETTLEMENT`: `RECONCILIATION_ORPHANED_AUDITS`, `RECONCILIATION_INVOICE_SETTLEMENT_CONSISTENCY`, `RECONCILIATION_STELLAR_TX_HASH_FORMAT`
   - `DEFI_AND_POSITIONS`: `DEFI_ORPHANED_POSITIONS`
   - `NOTIFICATIONS_AND_ALERTS`: `GROWTH_ORPHANED_ALERTS`, `NOTIFICATIONS_ORPHANED_RECORDS`
   - `AUDIT_AND_PROVENANCE`: `AUDIT_PROVENANCE_HASH_INTEGRITY`
2. Execute `DryRunReconciliationService.runDryRun()` to verify invoice-to-transaction matching, detect overpayments/missing payments, and check user balance drift.
3. **Gate condition**: `criticalFailures === 0`, `errorFailures === 0`, and `reconciliationCriticalCount === 0`.

### Phase 5: Idempotent Operation Replay & Recovery Center Lifecycle (`RECOVERY_EXECUTION`)

For operations interrupted by the incident:

1. Register affected operations in `RecoveryService` (`rec-<operationId>`).
2. Verify on-chain inspection links (`view-on-chain`) are attached for `payment`, `submission`, and `staking` operation types.
3. Enforce tenant isolation: a user can view, retry, or transition only their own recovery entries. Verify owner access succeeds and a second tenant receives `ForbiddenException` on cross-tenant access before performing recovery actions.
4. Replay operations guarded by `idempotencyKey`. Even if a retry action is dispatched multiple times, irreversible side effects (ledger credits, Stellar transaction submissions, outbound notifications) execute **at most once**.
5. Transition verified operations to `resolved` state, which automatically strips residual `availableActions` and prevents further state transitions.

The executable verification reports an owner-allowed and cross-tenant-denied
check for every registered operation. A failed authorization check blocks the
recovery gate; do not work around it by using an administrator identity in a
tenant-scoped request. Route the incident through the authorized recovery
operator procedure and retain the access-denial audit event.

### Phase 6: User-Impact Reporting & Stakeholder Communications (`USER_IMPACT_REPORTING`)

Generate a deterministic `UserImpactReport` for the incident lead and communications lead:

1. **Blast Radius Calculation**:
   - Count distinct affected users (`affectedUserCount`) and operations (`affectedOperationCount`).
   - Sum financial exposure at risk using 7-decimal fixed-point precision (`SCALE = 7`, matching Stellar stroops).
   - Normalize high-cardinality route parameters (`/:stellarAddress`, `/:ethAddress`, `/:txHash`, `/:uuid`) so metrics and status summaries never leak user addresses or transaction hashes.
2. **Notification Deduplication**:
   - Generate deterministic deduplication keys (`incident:<incidentId>:user:<hmacHash>:status`) so repeated drill/incident updates do not spam users.
3. **Mandatory Secret Redaction**:
   - Scrub all structured metadata and free-text status summaries against sensitive field names and regex patterns (`S[A-Z2-7]{55}` Stellar secret seeds, JWTs, `Bearer` tokens, `postgresql://` connection strings).
   - Assert `containsUnredactedSecrets === false`.
4. **Update Cadence SLA**:
   - `SEV-1`: Next update scheduled within **30 minutes**.
   - `SEV-2`: Next update scheduled within **60 minutes**.
   - `SEV-3` / `SEV-4`: Next update scheduled within **240 minutes**.

### Phase 7: Post-Incident Resume & Closure (`POST_INCIDENT_CLOSURE`)

Once Phases 1–6 pass:
1. Resume paused scopes via `PauseControlService.resumePause(scope, reason, actorId, actorRole)` and verify `pause.resumed` audit entries are written.
2. Publish final resolution summary and archive the signed drill report JSON artifact.

---

## 4. Catalog of Executable Drill Scenarios

| Scenario ID | Severity | Subsystems Exercised | What It Proves |
| :--- | :---: | :--- | :--- |
| `SEV1_SETTLEMENT_AND_PORTFOLIO_DRIFT` | `SEV-1` | `settlement`, `portfolio`, `notifications`, `observability` | Pauses `payments` & `settlements`, verifies snapshot HMAC, rolls back release, repairs `RECONCILIATION_INVOICE_SETTLEMENT_CONSISTENCY` & `PORTFOLIO_ORPHANED_ASSETS`, replays payment/rebalance idempotently, and emits a redacted SEV-1 impact report. |
| `SEV1_AUTH_KEY_ROTATION_AND_SESSION_CONTAINMENT` | `SEV-1` | `auth`, `notifications`, `observability` | Freezes `all` scopes on suspected key exposure, scrubs `apiKey` & Stellar secret seeds (`S...`), repairs `AUTH_ORPHANED_WALLETS` & `AUTH_STELLAR_KEY_FORMAT`, and verifies wallet challenge recovery. |
| `SEV2_DEFI_ORACLE_STALE_FEED_AND_ROLLBACK` | `SEV-2` | `defi`, `api_contracts`, `observability` | Pauses `oracle_submissions` & `webhooks`, validates contract compatibility, rolls back DeFi/Oracle release, repairs `ORACLE_MALFORMED_SIGNED_PAYLOADS` & `DEFI_ORPHANED_POSITIONS`, and replays staking/oracle submissions. |
| `EDGE_CASE_UNSAFE_SCHEMA_ROLLBACK_BLOCKED` | `SEV-2` | `settlement`, `api_contracts` | Proves that attempting a binary rollback across a destructive schema migration (`hasDestructiveSchemaChanges: true`) is **blocked** (`strategy: 'forward_fix_required'`) and write scopes remain safely paused until forward-fixed. |
| `EDGE_CASE_TAMPERED_SNAPSHOT_REJECTED` | `SEV-2` | `observability`, `auth` | Proves that any post-capture modification to a pre-rollback snapshot payload is caught by SHA-256 / HMAC-SHA256 verification (`strategy: 'blocked_tampered_snapshot'`), halting unsafe rollback. |

---

## 5. Operational Edge Cases, Failure Modes & Recovery Procedures

### 5.1 Destructive Schema Migration Fails Mid-Deploy or Incompatible Binary Rollback
- **Failure Mode**: A release drops, renames, or alters column types (e.g., `1729000020-DropLegacyColumn`) and then exhibits elevated 5xx errors. Rolling back the application container to the previous binary would cause immediate TypeORM query failures because the old entity metadata references dropped columns.
- **Detection**: `verifyRollbackAndContainment` inspects `hasDestructiveSchemaChanges` and blocks binary rollback (`allowed: false`, `strategy: 'forward_fix_required'`).
- **Recovery Steps**:
  1. Keep `payments` and `settlements` paused.
  2. Do **not** run `npm run migration:revert` blindly in production.
  3. Deploy an additive forward-fix migration that restores compatibility, or have the Data Owner execute a verified point-in-time database restore.
  4. Run `npm run dr:validate` to confirm schema and invariant consistency before unpausing writes.

### 5.2 Tampered or Corrupted Pre-Rollback State Snapshot
- **Failure Mode**: A state snapshot exported prior to mitigation is truncated, modified in transit, or signed with an invalid `SNAPSHOT_SIGNING_KEY`.
- **Detection**: Canonical SHA-256 hash or timing-safe HMAC-SHA256 comparison fails (`snapshotVerified: false`, `strategy: 'blocked_tampered_snapshot'`).
- **Recovery Steps**:
  1. Abort rollback and quarantine the corrupted snapshot artifact.
  2. Verify `SNAPSHOT_SIGNING_KEY` integrity in the secret manager.
  3. Capture a fresh snapshot via `SnapshotService.createSnapshot` and confirm `verifySnapshot` returns `valid: true`.

### 5.3 Split-Brain Stellar Settlement / Horizon Confirmation Timeout
- **Failure Mode**: An oracle submission or payment transaction was broadcast to Stellar Horizon, the HTTP connection timed out before receiving a response, and the local database record lacks a confirmed `txHash` or settlement audit. Automated retries risk submitting a duplicate payment if the original transaction is still confirming on-ledger.
- **Detection**: `ORACLE_SUBMISSION_INTEGRITY` or `DryRunReconciliationService` flags `MISSING_PAYMENT` / `STATUS_MISMATCH`.
- **Recovery Steps**:
  1. Immediately pause `settlements` and `oracle_submissions` scopes.
  2. Query Stellar Horizon by source account sequence number / memo / payment reference before re-submitting.
  3. If settled on-chain, backfill the authoritative `txHash` and reconcile via `ReconciliationService`.
  4. If absent on-chain after ledger close bounds expire, retry via `RecoveryService.executeAction(entryId, 'retry', userId)` using the original `idempotencyKey`.

### 5.4 Redis / Queue Reconnection Storm & Duplicate Side-Effect Risk
- **Failure Mode**: Redis connectivity flaps during an incident, causing Bull workers or retry schedulers to re-process stalled jobs.
- **Detection**: `SideEffectLedger` / `RecoveryVerificationResult.duplicateSideEffectsDetected` monitors for any repeated execution of an `idempotencyKey`.
- **Recovery Steps**:
  1. Never run `FLUSHALL` or `FLUSHDB` on production Redis—doing so erases idempotency locks (`IdempotencyRecord`) and rate-limit state.
  2. Restore Redis health and verify `GET /api/v1/health/ready`.
  3. Replay stalled jobs only after confirming `IdempotencyModule` deduplication keys are intact.

### 5.5 Suspected JWT, API Key, or Stellar Signing Key Exposure
- **Failure Mode**: Unusual authentication spikes, unauthorized role transitions, or suspected leakage of a signing secret in logs/diagnostics.
- **Detection**: `AUTH_ORPHANED_WALLETS`, `AUTH_DUPLICATE_WALLETS`, or `AUTH_STELLAR_KEY_FORMAT` invariant violations; security audit log anomalies.
- **Recovery Steps**:
  1. Declare `SEV-1` and activate global pause (`scope: 'all'`).
  2. Rotate secrets via the deployment secret manager (`npm run security:generate-secrets` for local/staging reference).
  3. Verify `generateUserImpactReport` redacts all sensitive fields (`containsUnredactedSecrets === false`) so incident updates never echo compromised credentials.
  4. Audit `SensitiveActionEvent` hash chain before resuming operations.

### 5.6 Stale DeFi Adapter or Oracle Price Feed Valuation Drift
- **Failure Mode**: An external DeFi protocol adapter or oracle price feed returns stale or malformed payloads (`ORACLE_MALFORMED_SIGNED_PAYLOADS`), causing `PORTFOLIO_VALUATION_CONSISTENCY` drift (`ABS(totalValue - SUM(amount * currentPrice)) > 0.05`).
- **Detection**: `DisasterRecoveryValidatorService` flags `ORACLE_MALFORMED_SIGNED_PAYLOADS` (`CRITICAL`) and `PORTFOLIO_VALUATION_CONSISTENCY` (`WARNING`).
- **Recovery Steps**:
  1. Pause `oracle_submissions` and quarantine malformed `signed_payloads` rows.
  2. Roll back the faulty adapter release if introduced by a recent deploy.
  3. Ingest fresh verified oracle price records and trigger portfolio re-valuation via the Recovery Center (`OperationType.Rebalance`).

---

## 6. Compatibility Guarantee

The incident drill verification system is **100% additive and read-only**:
- It introduces zero breaking changes to existing REST controllers, GraphQL resolvers, OpenAPI schemas (`docs/openapi.json`), or database migrations.
- All drill simulations execute deterministically in memory using injected state doubles, leaving production and development databases untouched.

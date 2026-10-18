# Trellis API operational runbook

This runbook is for incidents affecting the Trellis API, its PostgreSQL and
Redis dependencies, background jobs, observability stack, or Stellar-facing
operations. It is intentionally safe to follow from a production shell: use
the deployment's secret manager and approved observability tools rather than
copying credentials into commands or issue comments.

## Operating principles

1. Protect users and funds first. Stop or drain risky writes before attempting
   a repair.
2. Prefer reversible mitigations. Record the exact release, configuration
   change, migration, and operator who made each change.
3. Preserve evidence. Capture request IDs, release IDs, timestamps, error
   classes, queue names, and transaction hashes, but never log tokens, private
   keys, passwords, or complete authorization headers.
4. Keep the incident channel current. The incident lead owns the timeline and
   the communications lead gives the next update time.

## Roles and hand-off

| Role | Responsibility | Minimum hand-off information |
| --- | --- | --- |
| Incident lead | Declares severity, chooses mitigation, coordinates recovery | Impact, start time, current hypothesis, next decision time |
| API owner | Application errors, deploys, feature flags, rollback | Release SHA, affected route, recent code/config changes |
| Data owner | Database health, migrations, reconciliation, backups | Migration state, backup/restore point, affected tables |
| Chain/settlement owner | Stellar submission, confirmation, reconciliation | Network, contract, transaction hashes, retry status |
| Communications lead | Status updates and stakeholder notifications | User impact, workaround, next update time |

One person may fill more than one role for a small incident. The incident lead
must explicitly name a replacement before handing over.

## Severity and declaration

| Severity | Criteria | Target action |
| --- | --- | --- |
| SEV-1 | Unauthorized activity, suspected key exposure, incorrect settlement, or broad write/data loss | Page all relevant owners, stop risky writes, preserve evidence, update every 30 minutes |
| SEV-2 | Production writes degraded, queue backlog growing, or a major API flow unavailable | Page API and data owners, mitigate within 30 minutes, update hourly |
| SEV-3 | Localised degradation, elevated errors, or a non-critical integration unavailable | Assign an owner during business hours and track to resolution |
| SEV-4 | Documentation, alert, or low-impact defect with a workaround | Create a ticket and schedule normal maintenance |

Declare the highest applicable severity. Lower it only after impact is bounded
and the mitigation is stable.

## First 15 minutes: triage checklist

### 1. Establish impact and timeline

- Record when the first alert or report arrived and the last known healthy time.
- Identify affected routes, tenants, networks, job types, and percentage of
  requests or settlements affected.
- Check whether the issue is ongoing, intermittent, or already recovering.
- Assign the incident lead, API owner, data owner, and communications lead.

### 2. Check process, dependencies, and probes

Run these from a trusted network. The probe endpoints are public and do not
require credentials:

```bash
BASE_URL="https://api.example.invalid"
curl -fsS "$BASE_URL/api/v1/health/live"
curl -fsS "$BASE_URL/api/v1/health/ready"
curl -fsS "$BASE_URL/api/v1/health/startup"
```

Interpretation:

- `live` failing usually means the process is unhealthy; restart only after
  checking for a crash loop or resource exhaustion.
- `ready` returning `503` means traffic should remain drained while PostgreSQL 
  or Redis is unavailable.
- `startup` returning `503` means the instance has not completed initialization;
  check migrations and connection-pool errors before replacing it.

For a checked-out release, run the safe diagnostic command without printing
the environment:

``bash
npm run diagnostics:quick
```

### 3. Check observability

Use the release dashboard and the following signals together:

- error rate and status-code distribution from
  `/api/v1/observability/metrics`;
- request latency and in-flight requests;
- `trellis_database_query_duration_seconds` and active connections;
- `trellis_job_*` and queue length metrics;
- Sentry errors grouped by release and route;
- Jaeger traces for a request ID or trace ID.

The local stack is documented in [monitoring.md](monitoring.md). In production,
protect the metrics endpoint with `METRICS_AUTH_TOKEN` and use the configured
Prometheus/Grafana and Sentry access controls.

## Incident categories and decision points

### Authentication, authorization, or suspected key exposure

Symptoms include a sudden authentication failure spike, unexpected role
changes, invalid signatures, or suspected exposure of a JWT/signing key.

1. Treat suspected key exposure as SEV-1.
2. Disable the affected integration or risky write path using the approved
   gateway/feature-flag mechanism; do not edit production code in place.
3. Rotate the affected secret through the secret manager. Never paste the new
   value into logs, tickets, or chat.
4. Invalidate sessions/tokens according to the deployment's auth policy.
5. Preserve audit events and determine whether any request was accepted before
   rotation. Coordinate with the chain/settlement owner before replaying work.

Do not delete audit records while investigating. A credential rotation is not
complete until health checks and a known-good authenticated request succeed.

### Database failure, corruption, or migration risk

Symptoms include readiness failures, connection-pool exhaustion, lock waits,
constraint errors, or a migration that fails part-way through.

1. Stop deploys and drain write traffic if data correctness is at risk.
2. Check the database provider's health, connections, storage, locks, and
   replication/backup status.
3. Confirm the migration currently recorded by the application before running
   any repair. Do not run `migration:revert` as a first response.
4. If the migration is additive and safe, complete it during the approved
   change window. Otherwise restore to an approved point-in-time copy or use a
   reviewed forward-fix migration.
5. Run reconciliation and invariant checks before re-enabling writes.

Useful commands against an approved environment:

``bash
npm run migration:run
npm run dr:validate
```

Only the data owner may approve a restore or destructive database operation.
Verify the target database, backup timestamp, and restore plan twice before
executing it.

### Redis, queue, or worker degradation

Symptoms include growing queue depth, delayed jobs, repeated retries, dead
letters, or workers failing readiness.

1. Stop enqueueing the affected job type if retries could duplicate a payment,
   settlement, webhook, or other side effect.
2. Inspect queue depth, active/stalled jobs, retry counts, and dead-letter
   entries. Preserve job IDs and idempotency keys.
3. Restore worker capacity or Redis connectivity. Do not flush Redis in
   production; it removes retry and deduplication state.
4. Replay only jobs whose idempotency and external confirmation state are
   known. Reconcile with the chain or provider before retrying a side effect.
5. Watch queue depth and error rate until they return to the normal range.

### Stellar, provider, or settlement incident

Symptoms include submission failures, confirmation timeouts, network errors,
or a mismatch between local state and the ledger/provider.

1. Identify the network, contract, account, operation, and transaction hash.
2. Check the provider and network status before changing retry behaviour.
3. Pause automated retries when the result is unknown; an accepted transaction
   may still be confirming.
4. Query the authoritative ledger/provider and reconcile local state before
   resubmitting. Use the existing idempotency/deduplication controls.
5. Never ask an operator to paste a secret key into a shell or ticket.

### Elevated API errors or latency

Compare the first bad release/configuration change with the last healthy one.
Use request IDs and route-level metrics to distinguish an application defect
from a dependency outage. If the impact began immediately after a release and
the previous release is known healthy, use the rollback procedure below.

## Tamper-evident audit ledger

Privileged and financial events are written to a hash-chained audit ledger.
Each entry stores the SHA-256 hash of the previous entry plus its own
serialized payload, so any modification or deletion breaks the chain and is
detected by verification. The ledger is exportable and is covered by tamper
detection tests.

Events covered include authentication/authorization changes, role and
permission updates, secret rotations, portfolio and DeFi adapter writes,
notification dispatches, and settlement/chain operations.

### Verifying the ledger

Run verification against an approved environment and record the result in the
incident timeline:

```bash
npm run audit:verify
```

The verification walks the chain in sequence, recomputes each entry hash from it
stored payload and the previous hash, and reports the first entry that does not
match. A non-zero exit code means the chain is broken or an entry is missing;
treat this as SEV-1 evidence tampering until proven otherwise.

### Exporting the ledger

Export a signed jsonl bundle for an incident record or audit request:

```bash
npm run audit:export -- --from "${FROM_ISO}" --to "${TO_ISO}" > audit-export.jsonl
```

The export includes each entry's sequence number, timestamp, actor, action,
payload, and hash chain fields. Store it in the approved evidence bucket with
retention and access controls applied. Do not attach the export to a
public ticket if it contains tenant identifiers or financial details.

### Operational edge cases and failure modes

- Concurrent writes. Ledger appends are serialized; if two writers collide, the
  loser retries against the new head. Never manually insert an entry with a
  stale previous hash.
- Partial failure. If a business write succeeds but the ledger append fails, the
  application returns an error and the operation is retried with the same
  idempotency key; the ledger append is idempotent on that key.
- Clock skew. Entry ordering is determined by sequence number, not wall clock,
  so clock skew does not break verification. Use timestamps for investigation
  only.
- Truncation or deletion. Any deleted or modified row breaks the chain at that
  sequence number. Restore from the export bundle or an approved backup and
  re-run verification.
- Long chains. Verification streams entries in sequence order and is safe to
  run against production read replicas.

### Rollback and recovery

1. Freeze privileged and financial writes before touching the ledger.
2. Export the current ledger and preserve it as evidence.
3. If a bad entry was appended, do not edit it in place. Append a corrective
   entry that references the bad entry, then re-verify the chain.
4. If the chain is broken by data loss or corruption, restore the ledger table
   from the last verified export bundle or approved backup, replay any events from
   the application audit logs that are known good, and re-run verification.
5. Record the restore point, operator, and verification result in the incident
   timeline and resume writes only after the chain verifies clean.

## Rollback procedure

1. Drain traffic or disable the affected write path through the approved gateway/feature
   flag mechanism.
2. Deploy the previous known-good release artifact by immutable digest; do not
   rebuild from a branch during the incident.
3. Confirm the rolled-back release passes liveness, readiness, startup, and a
   known-good authenticated request.
4. If a migration is involved, follow the database section above instead of
   running a destructive revert.
5. Record the rollback time, release digest, and result in the incident timeline.

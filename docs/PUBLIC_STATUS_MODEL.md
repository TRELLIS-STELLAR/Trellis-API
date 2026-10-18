# Safe Public-Status Model (`operational`, `degraded`, `paused`, `maintenance`)

This document specifies the design, security boundaries, cross-path propagation (UI, API, and background workers), operational edge cases, failure modes, and rollback/recovery procedures for the Trellis API public-status model.

---

## 1. State Taxonomy & Severity Precedence

Trellis computes a deterministic system state from four underlying sources:
1. **Maintenance Windows** (`PublicStatusService.activateMaintenance`)
2. **Scoped Operational Pauses** (`PauseControlService` — `trading`, `payments`, `withdrawals`, `defi`, `oracle`, `reconciliation`, `all`)
3. **Component Degradations** (manual operator declarations and `DependencyHealthService` latency/availability checks)
4. **Core Readiness Probes** (`HealthService.getReadiness()` for PostgreSQL and Redis)

| State | Severity | HTTP Code (`GET /status`) | Meaning |
| --- | --- | --- | --- |
| `operational` | `0` | `200 OK` | All critical dependencies and operational scopes are healthy. |
| `degraded` | `1` | `200 OK` | Partial degradation: elevated dependency latency, optional dependency outage, or a subsystem-only pause (`defi`, `oracle`, `reconciliation`). Core API reads and unaffected write scopes remain operational. |
| `paused` | `2` | `200 OK` (`503` if `all` paused) | High-impact financial scope (`trading`, `payments`, `withdrawals`, or `all`) is paused via `PauseControlService`. Writes to paused scopes are halted with `Retry-After`. |
| `maintenance` | `3` | `503 Service Unavailable` | Planned or emergency maintenance window is active. Non-admin mutating API requests are rejected (`readOnly: true`), UI displays a non-dismissible maintenance banner, and non-essential background jobs are deferred. |

When multiple conditions overlap, the model resolves to the highest severity state (`maintenance > paused > degraded > operational`).

---

## 2. Public vs. Operator Views & Secret-Redaction Boundary

Status payloads are rendered in public status pages, browser UI banners, logs, and monitoring dashboards. Both public and operator views pass through the redaction boundary in [`src/health/public-status.model.ts`](../src/health/public-status.model.ts):

### Public View (`GET /status`, `GET /health/status`, `GET /status/ui-banner`)
- **Accessible to**: Unauthenticated callers, status page pollers, and frontend UI clients (`@Public()`, rate-limited).
- **Contains**:
  - `state`, `httpStatusCode`, `summary`, `generatedAt`, `retryAfterSeconds`
  - `maintenanceWindow` (`active`, `publicMessage`, `scheduledStartAt`, `estimatedEndAt`, `affectedScopes`)
  - `pausedScopes` (`scope`, `state`, `publicReason`, `expiresAt`)
  - `components` (`api`, `database`, `cache`, `trading`, `payments`, `withdrawals`, `defi`, `oracle`, `reconciliation`, `background_workers`)
  - `capabilities` (`readOnly`, `tradingEnabled`, `paymentsEnabled`, `withdrawalsEnabled`, `defiEnabled`, `oracleEnabled`, `reconciliationEnabled`, `backgroundJobsProcessing`)
- **Never Exposes**:
  - Database or Redis connection strings (`postgresql://...`, `redis://...`)
  - Credentials, passwords, JWTs (`eyJ...`), Bearer/Basic tokens, API keys (`sk-...`, `pk_...`), Stellar secret seeds (`S...`), Ethereum private keys (`0x...`), or PEM private key blocks
  - Environment variable names (`configKeys`) or secret values
  - Internal IPv4/IPv6 addresses (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `127.0.0.1`) or internal hostnames (`*.internal`, `*.local`, `localhost`)
  - Raw SQL statements (`SELECT ... FROM`, `INSERT INTO`, etc.) or Node.js stack trace frames
  - Unescaped HTML / XSS payloads (`<script>`, `onerror=`, `javascript:`)
  - Operator identifiers (`activatedBy`, `declaredBy`)

### Operator View (`GET /status/operator`, `GET /health/status/operator`)
- **Accessible to**: Authenticated `ADMIN` and `MAINTAINER` users with 2FA (`JwtAuthGuard`, `RolesGuard`, `AdminTwoFactorGuard`).
- **Adds**:
  - `rawStateSources`: Exact breakdown of active overrides, pause scopes, readiness status, and background worker mode.
  - `activePauses`: Full pause metadata (`activatedBy`, `activatedByRole`, `activatedAt`, `expiresAt`, `environment`) with secret-scrubbed `reason`.
  - `dependencyDiagnostics`: Per-dependency latency, `sanitizedTarget` (userinfo, query string, and fragment stripped), `configKeys` (`{ key, configured }` booleans only — never values), and actionable `remediation` hints.
  - `backgroundPath`: Current worker mode (`processing`, `throttled`, `deferred`), `deferredScopes`, and `activeBackoffMultiplier`.
  - `stateHistory`: Bounded audit log of recent state transitions (`fromState`, `toState`, `trigger`, `changedAt`, `actorId`, `publicSummary`, `operatorNote`).
  - `runbook`: Contextual verification, rollback/recovery steps, and edge-case warnings for the active state.

---

## 3. Cross-Path State Propagation (UI, API, Background)

### UI Path
- `GET /status/ui-banner` and `evaluateUiStatusContract(publicStatus)` return a deterministic UI banner contract:
  - `operational`: `visible: false`, `severity: "none"`
  - `degraded`: `visible: true`, `severity: "warning"`, `dismissible: true`
  - `paused`: `visible: true`, `severity: "error"`, `dismissible: false`
  - `maintenance`: `visible: true`, `severity: "info"`, `dismissible: false`
- Every state change in `PublicStatusService` emits a `"status.state_changed"` event containing `{ previousState, currentState, publicStatus, uiContract }` and a WebSocket envelope (`event: "system:status:update"`) so connected dashboard clients update banners and disable paused action buttons immediately.

### API Path
- `evaluateApiRequestGate(publicStatus, context)` enforces consistent HTTP behavior:
  - Always attaches `X-Trellis-System-Status: <state>` and `Retry-After: <seconds>` (when applicable).
  - Status and health routes (`/status/*`, `/health/*`) and read-only methods (`GET`, `HEAD`, `OPTIONS`) remain allowed across all states.
  - Users with the `ADMIN` role bypass write blocks (`bypassReason: "admin_override"`) so operators can execute recovery actions.
  - In `maintenance` (or global `all` pause), non-admin mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) receive `503 Service Unavailable` with RFC 7807 Problem Details (`errorCode: "SERVICE_UNAVAILABLE"`, `retryable: true`, `retryAfterSeconds`).
  - In `paused` or `degraded` states, mutating requests targeting a paused scope receive `503 Service Unavailable`, while requests targeting unpaused scopes succeed normally.

### Background Worker Path
- `evaluateBackgroundJobGate(publicStatus, context)` prevents background queues from amplifying incidents or exhausting retry budgets into dead-letter queues:
  - `operational`: `decision: "execute"`, `backoffMultiplier: 1`.
  - `degraded`: `decision: "execute_with_backoff"`, `backoffMultiplier: 2`, `delayMs: 2000` (unless the job's specific scope is paused, in which case it is deferred).
  - `paused`: Jobs mapped to a paused scope (e.g. `payments.settle` -> `payments`, `trading.execute` -> `trading`) return `decision: "defer"` with `retryAfterSeconds`, while unaffected jobs (e.g. `email.send`) continue executing.
  - `maintenance`: All non-essential jobs return `decision: "defer"` until maintenance completes; jobs marked `isEssentialRecovery: true` execute immediately.

---

## 4. Operational Edge Cases & Failure Modes

1. **Overlapping States & Step-Down Transitions**:
   - If an operator activates a maintenance window while `trading` is paused and `cache` is degraded, the public state is `maintenance`.
   - When the maintenance window is cleared, the state steps down to `paused` (not `operational`) because `trading` is still paused.
   - When `trading` is resumed, the state steps down to `degraded` until `cache` recovers, and only then transitions to `operational`.
2. **Premature Auto-Expiry During Long Maintenance or Migrations**:
   - Both `PauseScope.expiresAt` and `MaintenanceWindow.estimatedEndAt` auto-expire when their timestamp passes.
   - **Mitigation**: If a database migration or settlement reconciliation takes longer than planned, re-POST `/status/maintenance` with an updated `estimatedEndAt` before expiry so write locks and background job deferrals do not lift mid-migration.
3. **Credential Leaks in Operator Reason Strings or Driver Exceptions**:
   - Operators or automated circuit breakers might accidentally include a raw DSN, API key, SQL error, or internal IP in a pause/maintenance `reason`.
   - **Mitigation**: `sanitizePublicReason` and `sanitizeStatusText` scrub secrets, internal hosts, SQL statements, and stack traces before storing or returning any public or operator payload.
4. **Health/Database Probe Failure While Querying Status**:
   - If PostgreSQL or `PauseControlService` throws during `getPublicStatus()`, `PublicStatusService` catches the error, logs a sanitized warning, and degrades gracefully rather than returning an unhandled `500`.

---

## 5. Rollback & Recovery Procedures

### Recovering from `maintenance`
1. Verify all migrations and infrastructure changes are complete:
   ```bash
   curl -fsS -H "Authorization: Bearer $ADMIN_JWT" "$BASE_URL/api/v1/health/dependencies/diagnostics?refresh=true"
   ```
2. Clear the maintenance window:
   ```bash
   curl -fsS -X POST "$BASE_URL/api/v1/status/maintenance/clear" \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -H "Content-Type: application/json" \
     -d '{"reason": "Maintenance complete and readiness verified"}'
   ```
3. Confirm public status returns `200 OK` and `state: "operational"`:
   ```bash
   curl -fsS "$BASE_URL/api/v1/status"
   ```

### Recovering from `paused`
1. Inspect active pauses and operator diagnostics:
   ```bash
   curl -fsS -H "Authorization: Bearer $ADMIN_JWT" "$BASE_URL/api/v1/status/operator"
   ```
2. Resume the paused scope via `PauseControlController`:
   ```bash
   curl -fsS -X POST "$BASE_URL/api/v1/pause-control/resume" \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -H "Content-Type: application/json" \
     -d '{"scope": "trading", "reason": "Upstream feed stabilized"}'
   ```
3. Verify deferred background jobs drain normally and `GET /status` reflects the updated state.

### Recovering from `degraded`
1. If caused by a manual component degradation, clear it once metrics recover:
   ```bash
   curl -fsS -X POST "$BASE_URL/api/v1/status/degradation/clear" \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -H "Content-Type: application/json" \
     -d '{"componentId": "defi", "reason": "RPC latency back within budget"}'
   ```
2. If caused by an automatic dependency check, resolve the upstream latency/outage and force a cache refresh via `GET /health/dependencies/diagnostics?refresh=true`.

---

## 6. Verification

Run the standalone executable verification suite:

```bash
npm run validate:public-status
```

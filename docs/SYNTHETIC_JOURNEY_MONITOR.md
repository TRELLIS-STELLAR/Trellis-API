# Synthetic Journey Monitor: Core Happy Path & Dependency Blame

## Overview

The **Synthetic Journey Monitor** continuously exercises Trellis API's highest-value, business-critical end-to-end happy path across auth, portfolio, DeFi adapters, settlement/reconciliation, and notifications. It proactively reports latency, SLA breaches, failures, and attributes root-cause dependency blame before customer transactions are impacted.

---

## 1. Monitored Critical Happy Path Workflow

The synthetic journey (`E2E_CORE_HAPPY_PATH_JOURNEY`) sequentially executes 5 critical steps representing the end-to-end investor and settlement pipeline:

| Step | Operation Name | Target Subsystem | Blame Target | SLA Budget | Description |
|---|---|---|---|---|---|
| 1 | `step_auth_verify` | `AuthService` | `AUTH_SERVICE` | 300ms | Authenticates principal & provisions active session |
| 2 | `step_portfolio_rebalance` | `PortfolioRebalancingService` | `POSTGRES_DB` | 500ms | Loads target allocations & checks rebalance variance |
| 3 | `step_defi_yield` | `DeFiProtocolRegistry` | `DEFI_PROTOCOL_RPC` | 700ms | Queries Aave / Compound adapter yield opportunities |
| 4 | `step_settlement_reconcile` | `ReconciliationService` | `STELLAR_HORIZON` | 600ms | Validates Stellar ledger settlement & ledger matching |
| 5 | `step_notification_dispatch` | `NotificationService` | `NOTIFICATION_GATEWAY` | 400ms | Emits real-time trade/settlement notification |

Total E2E SLA Budget: **2,500ms**.

---

## 2. Dependency Blame Taxonomy & Root Cause Attribution

When any step degrades (exceeding SLA) or errors out, the monitor inspects error signatures and latency distributions to attribute blame:

- **`POSTGRES_DB`**: Connection timeouts, transaction locks, or read replica lag.
  - *Remediation*: Check PostgreSQL connection pool saturation and active long-running locks.
- **`REDIS_CACHE`**: Cache miss spikes or Redis cluster socket timeouts.
  - *Remediation*: Inspect Redis memory limits, evictions, and cluster connectivity.
- **`STELLAR_HORIZON`**: Horizon 429 rate limit or 504 gateway timeout.
  - *Remediation*: Verify Horizon rate limit quotas or failover to secondary Horizon RPC.
- **`DEFI_PROTOCOL_RPC`**: Upstream Ethereum/Polygon JSON-RPC rate limits or timeouts.
  - *Remediation*: Switch to backup RPC provider and check circuit breakers.
- **`NOTIFICATION_GATEWAY`**: WebSocket socket drop or message queue backpressure.
  - *Remediation*: Check notification broker queues and WebSocket ingress connections.
- **`AUTH_SERVICE`**: JWT verification failure or token expiration.
  - *Remediation*: Validate JWT signing key rotation and auth strategy validation services.

---

## 3. Operational Edge Cases & Failure Modes

1. **Upstream Cascade Skipping**:
   - If Step 1 (`step_auth_verify`) fails, downstream operations that depend on credentials (`step_portfolio_rebalance`, `step_settlement_reconcile`, etc.) are safely marked `SKIPPED` rather than creating misleading downstream cascade errors.
2. **Transient Network Jitter vs. Real Outage**:
   - Latency breaches mark the step `DEGRADED` rather than `FAILED`, keeping the workflow operational while alerting operators to rising dependency latency.
3. **Double Scheduler Initialization**:
   - `SyntheticJourneyMonitorService.startScheduler()` is idempotent and guards against multiple interval timers if called concurrently.
4. **Credential & Secret Redaction**:
   - Synthetic identity tokens (`synth_jwt_*`) and IDs are synthetic markers that never touch real private keys or customer secrets.

---

## 4. Rollback and Recovery Steps

### Rollback Procedure
If synthetic monitoring introduces unexpected operational overhead:
1. **Disable Background Scheduler**:
   - Set environment variable `SYNTHETIC_MONITOR_ENABLED=false` or call `service.stopScheduler()`.
2. **Revert Binary / Commit**:
   - Roll back to the preceding deployment tag. Since all synthetic metrics and controllers are non-breaking additive features with no destructive schema changes, rolling back incurs zero database downtime.

### Recovery Procedure
When a failure report is triggered:
1. Query `GET /monitoring/synthetic/status` to identify `dependencyBlame` and the failing `stepId`.
2. Apply the recommended remediation suggested in `step.error.remediation`.
3. Trigger an on-demand verification run via `POST /monitoring/synthetic/run`.
4. Ensure the returned overall status is `SUCCESS` and latency is within SLA.

---

## 5. API Contracts & Endpoints

- **`GET /monitoring/synthetic/status`**:
  - Fetches the latest synthetic journey report (returns HTTP 200).
- **`POST /monitoring/synthetic/run`**:
  - Triggers an immediate synthetic journey run. Returns HTTP 200 on `SUCCESS` or `DEGRADED`; returns HTTP 503 on `FAILED`.
  - Supports `?simulateFailureStep=<step_id>` for fault-injection testing.

---

## 6. Prometheus Telemetry Reference

- `trellis_synthetic_journey_runs_total{journey_name, status, trigger}`: Counter of journey executions.
- `trellis_synthetic_journey_duration_ms{journey_name, status}`: Gauge of total journey duration.
- `trellis_synthetic_journey_step_duration_ms{step_id, target_service, dependency, status}`: Gauge of individual step latencies.

---

## 7. Running Verification Locally

```bash
# Execute standalone synthetic journey CLI
npm run synthetic:run

# Execute full 8-invariant verification suite
npm run synthetic:verify
```

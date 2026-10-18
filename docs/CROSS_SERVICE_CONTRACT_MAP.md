# Trellis Cross-Service Contract Map & Integration Boundaries

> Resolves Issue #227 — Cross-service contract map for domain events and integration boundaries across the NestJS backend, auth, portfolio, DeFi adapters, notifications, observability, and Stellar settlement.

---

## 1. Executive Summary & Purpose

Trellis API relies on asynchronous messaging and domain events to coordinate decoupled microservices and domain boundaries. To prevent schema drift, payload incompatibilities, unhandled consumer failures, and state discrepancies, this document and its companion executable contract map (`src/common/contract/cross-service/`) establish:

1. **Producer & Consumer Topologies**: Explicit cataloging of every domain event, its emitting service, and consuming subscribers.
2. **Payload Wire Schemas & Required Fields**: Strict typing and field requirements enforced at runtime and in automated CI.
3. **Semver Evolution Rules**: Compatibility guarantees and deprecation lifecycle rules across services.
4. **Resilience & Allowed Failure Behaviors**: Exponential retry policies, dead-letter queues (DLQs), and circuit breakers for each consumer.
5. **Operational Edge Cases**: Deduplication keys, clock drift tolerances, out-of-order handling, and network partition strategies.
6. **Rollback & State Recovery Runbooks**: Automated compensation steps and manual operational recovery runbooks.

---

## 2. Integration Boundary Architecture

```
+------------------+         auth.security.lockout          +-----------------------+
|   Auth Service   | -------------------------------------> | Notifications Service |
+------------------+                                        +-----------------------+
        |                                                               |
        | auth.user.authenticated                 notifications.failed  |
        v                                                               v
+-----------------------+   observability.state_changed     +-----------------------+
| Observability Service | <-------------------------------- | Observability Telemetry|
+-----------------------+                                   +-----------------------+
        ^                                                               ^
        | portfolio.drawdown                                            | tvl.growth
        |                                                               |
+-----------------------+         rebalance.requested       +-----------------------+
|   Portfolio Service   | --------------------------------> |  DeFi Adapter Service |
+-----------------------+                                   +-----------------------+
        ^                                                               |
        | settlement.drift_detected                                     | defi.supplied
        |                                                               v
+-----------------------+                                   +-----------------------+
|  Settlement (Stellar) | --------------------------------> |   Stellar Soroban     |
+-----------------------+                                   +-----------------------+
```

---

## 3. Cross-Service Contract Matrix

| Event Name                                 | Producer Service        | Transport     | Schema Version | Consumer Service(s)                              | Required Fields                                                                              | Allowed Fallback Behavior                    |
| ------------------------------------------ | ----------------------- | ------------- | -------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `auth.user.authenticated`                  | `auth-service`          | Event Emitter | `1.0.0`        | `observability-service`, `notifications-service` | `userId`, `authMethod`, `ipAddress`, `sessionId`, `authenticatedAt`                          | `drop-with-alert` / `queue-offline`          |
| `auth.security.lockout`                    | `auth-service`          | Event Emitter | `1.0.0`        | `notifications-service`, `observability-service` | `userId`, `lockoutReason`, `lockoutDurationMinutes`, `triggeredByIp`, `lockedAt`             | `queue-offline` / `drop-with-alert`          |
| `portfolio.rebalance.requested`            | `portfolio-service`     | Bull Queue    | `1.0.0`        | `defi-adapter-service`, `observability-service`  | `portfolioId`, `userId`, `targetAllocations`, `currentDriftBps`, `requestId`, `requestedAt`  | `compensate-transaction` / `drop-with-alert` |
| `portfolio.critical_drawdown.detected`     | `portfolio-service`     | Event Emitter | `1.0.0`        | `notifications-service`, `defi-adapter-service`  | `portfolioId`, `userId`, `drawdownPct`, `previousValueUsd`, `currentValueUsd`, `detectedAt`  | `queue-offline` / `degrade-gracefully`       |
| `defi.adapter.circuit_breaker_tripped`     | `defi-adapter-service`  | Event Emitter | `1.0.0`        | `portfolio-service`, `observability-service`     | `protocol`, `reason`, `affectedPools`, `trippedAt`, `incidentId`                             | `degrade-gracefully` / `drop-with-alert`     |
| `defi.liquidity.supplied`                  | `defi-adapter-service`  | Event Emitter | `1.0.0`        | `portfolio-service`, `observability-service`     | `protocol`, `asset`, `amount`, `sharesReceived`, `txHash`, `userId`, `completedAt`           | `compensate-transaction` / `drop-with-alert` |
| `notifications.dispatch.failed`            | `notifications-service` | Event Emitter | `1.0.0`        | `observability-service`                          | `notificationId`, `userId`, `channel`, `failureReason`, `failedAt`                           | `drop-with-alert`                            |
| `observability.health.state_changed`       | `observability-service` | Event Emitter | `1.0.0`        | `notifications-service`                          | `component`, `previousStatus`, `currentStatus`, `transitionReason`, `timestamp`              | `degrade-gracefully`                         |
| `settlement.reconciliation.drift_detected` | `settlement-service`    | Event Emitter | `1.0.0`        | `portfolio-service`, `observability-service`     | `reconciliationId`, `asset`, `expectedBalance`, `actualBalance`, `driftAmount`, `detectedAt` | `compensate-transaction` / `drop-with-alert` |

---

## 4. Versioning and Schema Evolution Rules

1. **Semver Standard**: All events publish a `schemaVersion` string adhering to `MAJOR.MINOR.PATCH`.
2. **Minor Updates (Additive)**:
   - Adding optional fields or metadata properties is non-breaking.
   - Minor versions increment (e.g., `1.0.0` -> `1.1.0`).
   - Consumers must ignore unknown fields without throwing deserialization errors (`forwardCompatible: true`).
3. **Major Updates (Breaking)**:
   - Renaming or removing fields, altering data types, or changing field cardinality requires bumping `MAJOR` (e.g., `1.x.x` -> `2.0.0`).
   - Services must support dual-publishing or version translation adapters during a **90-day deprecation grace period**.
4. **Consumer Fallbacks**:
   - Every consumer implementation must register fallback handlers (`CrossServiceContractRegistry.validateEventEnvelope`) to validate incoming payloads before executing critical business logic.

---

## 5. Failure Behaviors, Retries, and Circuit Breakers

Every consumer specifies explicit failure handling policies:

1. **Retry Policies**:
   - **Exponential Backoff**: Jittered exponential retries (e.g., 500ms initial interval, up to 10s max, 3-5 retries) prevent thundering herd problems during downstream outages.
   - **Fixed Retries**: Applied to non-critical telemetry consumers.
2. **Dead-Letter Queues (DLQ)**:
   - Any message exhausting its maximum retries is routed to a designated Redis/Bull dead-letter queue (e.g. `dlq.portfolio.rebalance_execution`).
   - DLQ alerts trigger high-priority alerts in PagerDuty and the observability dashboard.
3. **Circuit Breakers**:
   - Configured with failure thresholds (2 to 5 consecutive errors) and recovery timeouts (15s to 60s).
   - Once tripped, consumers enter safe fallback behavior (`degrade-gracefully` or `compensate-transaction`) rather than compounding failure rates.

---

## 6. Operational Edge Cases & Mitigation

| Edge Case               | Root Cause                                     | Mitigation Strategy                                                                                                                     |
| ----------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Duplicate Delivery**  | Transport redelivery, consumer retry           | Mandatory idempotency key field (`idempotencyKeyField`) deduplicated in Redis with TTL ranging from 15 minutes to 7 days.               |
| **Out-of-Order Events** | Multi-worker concurrency, network latency      | Consumers compare event sequence timestamps (`timestamp` / `authenticatedAt`) against local entity state; older messages are discarded. |
| **Clock Drift**         | NTP synchronization discrepancies across nodes | Tolerance threshold (15s to 60s) allowed before rejecting future-dated payloads.                                                        |
| **Network Partition**   | Redis or transport disconnection               | Fail-safe local isolation: critical locks persist, non-critical metrics buffer locally, and state reconcilers run upon reconnection.    |

---

## 7. Rollback & State Compensation Runbooks

1. **Portfolio Rebalance Reversal**:
   - _Trigger_: Downstream liquidity exhaustion or slippage violation during multi-leg trade execution.
   - _Compensation_: Automated compensatory swap reversal restoring original weights and releasing portfolio execution locks.
   - _Runbook_: `docs/PORTFOLIO_INTEGRATION.md#rebalance-rollback`.
2. **DeFi Circuit Breaker Reset**:
   - _Trigger_: Upstream oracle or protocol RPC endpoint recovers.
   - _Compensation_: Verification of liquidity pool reserves followed by signed operator reset event.
   - _Runbook_: `docs/INCIDENT_DRILL_RUNBOOK.md#defi-circuit-breaker`.
3. **Settlement Ledger Reconciliation Repair**:
   - _Trigger_: Discrepancy detected between internal database balances and Stellar Horizon ledger state.
   - _Compensation_: Immediate quarantine of affected asset positions, pause of automated withdrawals, and execution of `scripts/reconciliation-repair.ts`.
   - _Runbook_: `docs/stellar-reconciliation.md#drift-resolution`.

---

## 8. Verification & CI Invariants

The contract map is executable and continuously verified:

- Run contract unit tests: `npm test src/common/contract/cross-service/cross-service-contract-map.spec.ts`
- Verifies full topology coverage, semver compliance, schema integrity, and failure policy declarations.

---

## 9. Contract Drift Detection

Issue #371. `detectContractDrift(baseline, current)` in
`src/common/contract/cross-service/cross-service-contract-drift.ts` compares the
last released definitions with the working tree (defaults to
`CROSS_SERVICE_EVENT_DEFINITIONS`) and returns `{ ok, findings }`.

| Finding | Breaking | Meaning |
| --- | --- | --- |
| `event-removed` | yes | An event consumers may rely on is gone. Not waivable by a version bump; deprecate it first. |
| `producer-changed` | yes | The producing service changed. |
| `required-field-removed` / `required-field-added` | yes | Consumers or existing producers break. |
| `payload-type-changed` | yes | A payload field changed its declared type. |
| `consumer-removed` | yes | A registered consumer was dropped. |
| `version-regressed` | yes | `schemaVersion` went backwards or is not `MAJOR.MINOR.PATCH`. |
| `breaking-without-major-bump` | yes | A breaking change kept the same major version. |
| `event-added` | no | New event; informational. |

A breaking change that ships with a major `schemaVersion` bump is reported as
non-breaking and annotated as acknowledged, matching the dual-publish and
90-day deprecation rules in section 4. Findings are sorted, so results are
deterministic and safe to retry.

Recovery: when `ok` is false, either restore the removed field, event, or
consumer, or bump the event's major version and follow the deprecation grace
period. The baseline must be the definitions of the last release (for example
the registry at the previous release tag); the function performs no I/O and
never mutates the registry.

Verify with `npx jest src/common/contract/cross-service/cross-service-contract-drift.spec.ts`.

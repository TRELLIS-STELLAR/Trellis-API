# Deterministic Chaos Test Suite

> **Issue #207** — Implement deterministic chaos test suite for interrupted user and background workflows.

---

## Overview

The chaos test suite verifies that Trellis API workflows survive the failures that actually page people: network timeouts, connection resets, process kills mid-flight, stale database reads, and retry storms. Every test is **deterministic** — no random failure probability, no wall-clock waiting, no real network calls, no real database.

The suite is built on top of the existing fault-injection harness (`src/testing/fault-injection/`) and adds a higher-level orchestrator (`src/testing/chaos/chaos-scenario.ts`) that models process restarts, stale reads, and synchronisation kill-points.

---

## Architecture

### Existing harness (`src/testing/fault-injection/`)

| Export | Purpose |
|---|---|
| `FaultController` | Scripts exactly how many times a collaborator fails and with which fault kind |
| `FaultyRepository<T>` | In-memory TypeORM double that can simulate partial writes and constraint violations |
| `createFaultyFetch` | `fetch` drop-in that throws or returns bad responses on demand |
| `SideEffectLedger` | Records irreversible side effects; `assertNoDuplicates()` proves a retry did not pay/submit twice |
| `ManualClock` | Virtual clock; `advance(ms)` resolves pending sleeps without wall-clock time |
| `retryWithFaults` | Generic retry loop wired to the injected clock |

### New orchestrator (`src/testing/chaos/`)

| Export | Purpose |
|---|---|
| `SimulatedRestart` | Clears ephemeral in-process state (locks, timers, caches) while leaving durable rows intact — identical to a cold SIGKILL + re-start |
| `StaleReadInjector<T>` | Wraps a `FaultyRepository` so specific `findOne` calls return an out-of-date snapshot, modelling replica lag and cache divergence |
| `ProcessKillPoint` | A named synchronisation barrier; `armKill("name")` makes the next call throw `ProcessKillError`, simulating a kill signal arriving between two durable writes |
| `ChaosScenario` | Convenience façade that bundles `ManualClock`, `SideEffectLedger`, `SimulatedRestart`, and `ProcessKillPoint` and provides lazy `controller()` / `repository()` / `staleReader()` factories |

---

## Test Files

| File | Workflow Under Test | Fault Categories |
|---|---|---|
| `src/testing/chaos/chaos-scenario.spec.ts` | Orchestrator self-tests | — |
| `src/testing/chaos/stale-read.spec.ts` | Cross-cutting stale reads | Replica lag, cache divergence, optimistic-lock conflict |
| `src/notifications/chaos/notification-workflow.chaos.spec.ts` | Notification delivery pipeline | Network faults, process kills, stale preference reads, duplicate suppression |
| `src/infrastructure/retry-scheduler/retry-scheduler.chaos.spec.ts` | Retry scheduler | Network faults, back-off scheduling, dead-letter, process kills, idempotent scheduling, concurrent worker race |
| `src/infrastructure/workers/background-worker.chaos.spec.ts` | Background job worker | Process kills, retry exhaustion, missing handler, stale payload, concurrent claim guard, persistence failures |
| `src/defi/chaos/defi-workflow.chaos.spec.ts` | DeFi position sync and yield optimisation | Network faults, process kills, DB constraint violations, stale position reads, double-submit guard |

---

## Running the Chaos Tests

```bash
# Run all chaos specs
npx jest --testPathPattern="chaos|stale-read" --runInBand

# Run a single workflow
npx jest src/notifications/chaos/notification-workflow.chaos.spec.ts --runInBand

# Run with coverage
npx jest --testPathPattern="chaos|stale-read" --coverage --runInBand
```

> `--runInBand` is recommended for chaos tests to prevent interference between scenario clock states in parallel workers.

---

## Failure Mode Reference

### Network Failures

| Fault Kind | Retryable | What It Simulates |
|---|---|---|
| `timeout` | Yes | Provider did not answer before the deadline |
| `connection-reset` | Yes | TCP RST mid-request (e.g. load balancer restart) |
| `network-unreachable` | Yes | DNS failure, egress firewall, TLS error |
| `http-status` | Yes | Upstream 429 / 503 / 502 |
| `malformed-body` | No | Response is not valid JSON |
| `malformed-payload` | No | Response is valid JSON but wrong shape |

**Recovery steps:**
1. The failing operation must be left in a re-runnable state (PENDING or QUEUED) with a non-null `nextRetryAt`.
2. The retry budget is consumed only for retryable faults. Malformed responses must not burn retry attempts — they indicate a protocol mismatch and should alert the on-call engineer.
3. On retry, the handler must check whether its side effects were already committed (via idempotency key or by reading the delivery log) before re-executing.

### Process Kill / Restart

A process kill (SIGKILL, OOM kill, container eviction) can interrupt execution at any point between two durable writes. The test suite covers four named kill-points:

| Kill-point name | State left behind | Recovery action |
|---|---|---|
| `after-fetch-before-db-write` | No row written | Re-run the full operation; nothing to clean up |
| `after-db-write-before-event` | Row written, event not emitted | Re-emit the event using the row as the source of truth |
| `after-status-update` | Row status = SENDING, no delivery log | Re-run from the beginning; the status reset is idempotent |
| `after-claim-before-handler` | Job/operation row = IN_PROGRESS | Recovery scanner resets IN_PROGRESS rows older than `claimTtlMs` back to PENDING |
| `after-handler-before-ack` | Handler ran, completion not persisted | Re-run with an idempotency guard in the handler (check the delivery log or a processed-IDs set) |

**Rollback/recovery steps for each kill-point:**

1. **After fetch, before DB write** — The simplest case. No durable state was written. The operation can be replayed without any cleanup. Bull's `at-least-once` delivery semantics handle this automatically.

2. **After DB write, before event** — The row is authoritative. A startup reconciler should scan for rows in intermediate states (e.g. `SENDING`, `IN_PROGRESS`) older than a configurable threshold and re-emit events for them. This is safe because the event consumers must be idempotent.

3. **After handler, before acknowledgement** — The most dangerous case. The handler may have produced an irreversible side effect (payment, email, webhook). The handler MUST guard against re-execution using one of:
   - An idempotency key stored in the DB before the side effect is produced.
   - A check of the delivery log (if the log shows SENT, skip re-delivery).
   - A processed-IDs in-memory set (valid for single-process deployments).

### Stale Reads

Stale reads occur in three contexts:

| Context | Root cause | Detection |
|---|---|---|
| Read-your-own-write | Replica lag after a write on the primary | Compare `updatedAt` or use a version column |
| Cache divergence | In-process cache not invalidated after an external update | Cache TTL + optimistic version check on read-through |
| Optimistic-lock conflict | Two writers read the same version, last writer wins | `OptimisticLockError` on version mismatch; caller re-reads and retries |

**Recovery steps:**
1. Any code path that reads a row and then makes a decision based on it (e.g. "should I send this notification?") must tolerate receiving a stale snapshot.
2. Mandatory alerts (priority=critical, category=security) must bypass disabled preferences regardless of what the read returns — the override logic must be in the processor, not in the preference record.
3. Optimistic-lock conflicts are not retryable automatically. The caller must re-read the record, re-apply the patch, and re-attempt the save with the new version number.

### Dead-Letter Queue

An operation reaches the dead-letter queue when:
- Its `maxAttempts` is exhausted, or
- It throws a non-retryable error (e.g. `malformed-payload`, `execution-reverted`)

**Recovery steps:**
1. Use `RetrySchedulerService.retryDeadLetter(operationId)` (or the admin endpoint) to revive the operation. This resets `attempts = 0` and `nextRetryAt = now()`.
2. Before reviving, investigate the `lastError` field to confirm the root cause is resolved.
3. For non-retryable faults, fix the root cause first — reviving a `malformed-payload` operation without updating the adapter will dead-letter it again immediately.

---

## Operational Edge Cases

### 1. Notification Processor: SENDING stuck state

**Cause:** The process was killed between the `status = SENDING` write and the provider call.

**Detection:** A periodic scan for notifications with `status = SENDING` and `sentAt IS NULL` older than `N` minutes.

**Recovery:** Reset `status = QUEUED` and re-enqueue. The processor will increment `attemptCount` and try again. If `attemptCount >= maxAttempts`, the status will be set to `FAILED`.

**Safe guard:** Before calling the provider, the processor checks the `delivery_logs` table. If a log already exists in `SENT` or `DELIVERED` state for the same `(notificationId, channel)`, the provider call is skipped.

---

### 2. Retry Scheduler: IN_PROGRESS stuck operations

**Cause:** A worker was killed between claiming a row (`IN_PROGRESS`) and completing the handler.

**Detection:** A background scanner checks for `status = IN_PROGRESS` rows where `updatedAt < now() - claimTtlMs`. The default claim TTL should be 5× the expected maximum handler duration.

**Recovery:** Reset `status = PENDING` and `nextRetryAt = now()`. Do not increment `attempts` — the kill counts as a non-attempt. The handler must be idempotent to tolerate a re-run.

**Rollback:** If investigation reveals the handler did produce a side effect before the kill, manually inspect the side effect target (e.g. the delivery log, the blockchain transaction) and either mark the operation SUCCEEDED or skip it in the next run via an idempotency key.

---

### 3. DeFi Position Sync: Kill after DB write, event not emitted

**Cause:** The process was killed between writing the `DeFiPosition` row and emitting the `position.synced` domain event.

**Detection:** Scan for positions where `lastSyncedAt > eventLastEmittedAt` (if this timestamp is tracked separately) or where the outbox record is missing.

**Recovery:** Re-emit the event from the stored row. All consumers of `position.synced` must be idempotent — processing the same event twice must not produce a duplicate rebalance transaction.

**Rollback:** If a duplicate event was already processed, the rebalance guard (`rebalanceQueued = true`) in the `DeFiYieldRecord` prevents a second queue entry for the same position at the same clock tick.

---

### 4. Background Worker: Kill after handler, before acknowledgement

**Cause:** Bull uses at-least-once delivery. If the worker process dies after calling `done()` internally but before Bull receives the ack, the job is re-delivered.

**Detection:** The job appears with `status = ACTIVE` and `completedAt IS NULL` after restart.

**Recovery:** Re-run the job. The handler MUST be idempotent. Use a `processedJobIds` set, a database flag, or check the delivery log before re-executing the side effect.

**Safe guard (tested):** The `PaymentProcessor` in the test suite demonstrates a `processedIds` guard that prevents double-payment even when the job is re-delivered after a kill-before-ack.

---

### 5. Concurrent Worker Race (claim collision)

**Cause:** Two worker instances dequeue the same job simultaneously (e.g. Redis `BRPOPLPUSH` race with ack timeout).

**Detection:** Both workers attempt to set `status = IN_PROGRESS`. The second write will observe `status = IN_PROGRESS` already and must bail out.

**Recovery:** The worker checks `if (job.status !== PENDING) return` immediately after the claim write. A stale read that returns PENDING when the row is already IN_PROGRESS results in a double-execution — this is the scenario tested in `retry-scheduler.chaos.spec.ts` under "concurrent worker race".

**Prevention:** Use a `SELECT FOR UPDATE SKIP LOCKED` query (PostgreSQL advisory lock) in the poller to ensure only one worker claims each row. The `DistributedLockModule` (`src/infrastructure/distributed-lock/`) provides Redis-backed locks for this purpose.

---

## Design Principles

1. **No timing assumptions.** Every sleep is resolved by `ManualClock.advance()`. A test that passes only with `await new Promise(r => setTimeout(r, 100))` is a flaky test.

2. **No shared global state.** Each test creates its own `ChaosScenario` instance. Fault controllers and repositories are not shared between tests.

3. **Scripts are fully consumed.** `scenario.assertClean()` (or `FaultController.unconsumed()`) verifies that every scripted fault fired at least once. A test that queues a fault it never triggers is a dead test.

4. **No duplicate side effects.** `SideEffectLedger.assertNoDuplicates()` is called at the end of every multi-attempt scenario. A retry that pays an invoice twice is a production incident; the test must catch it.

5. **Small, vertical slices.** Each test covers exactly one workflow step. A test that requires 50 lines of setup before the first assertion is a design smell — extract a helper or split the test.

---

## Adding a New Chaos Test

1. Identify the workflow and its durable steps (what writes to the DB, what emits events, what calls external services).
2. Create a minimal copy of the service that accepts injected collaborators (repos, fetch, clock, kill-point) instead of using NestJS DI.
3. For each durable step boundary, add a `killPoint.checkpoint("step-name")` call.
4. Write one test per failure scenario:
   - Network fault → assert the DB state is consistent and the side-effect count is 0.
   - Kill at each checkpoint → assert which rows survived and which did not.
   - Stale read → assert the conditional logic produces the correct outcome.
   - Retry after any of the above → assert side effects are not duplicated.
5. Call `scenario.assertClean()` or `expect(() => scenario.ledger.assertNoDuplicates()).not.toThrow()` at the end of every multi-attempt test.

---

## Related Documentation

- [`docs/IDEMPOTENCY.md`](./IDEMPOTENCY.md) — Replay protection for mutating requests
- [`docs/DOMAIN_EVENTS.md`](./DOMAIN_EVENTS.md) — Domain event contracts and consumers
- [`docs/OPERATION_QUEUE.md`](./OPERATION_QUEUE.md) — In-process operation queue and conflict resolution
- [`docs/OPERATION_RECEIPTS_AND_STATE_DRIFT.md`](./OPERATION_RECEIPTS_AND_STATE_DRIFT.md) — State drift detection and reconciliation
- [`docs/LIFECYCLE_STATE_MACHINES.md`](./LIFECYCLE_STATE_MACHINES.md) — Notification and retry state machine diagrams
- [`src/testing/fault-injection/fault-injection.ts`](../src/testing/fault-injection/fault-injection.ts) — Fault injection harness source
- [`src/testing/chaos/chaos-scenario.ts`](../src/testing/chaos/chaos-scenario.ts) — Chaos orchestrator source

# Guarded feature-flag rollouts

`FeatureFlagRolloutGuard` provides a small canary primitive for code paths that
need an explicit health check and compensating action. It is available from
`ReconciliationModule` and uses the existing `FeatureFlagsService`.

## Execution model

Call `run` with a bounded `scopeId`, one feature flag, an `execute` callback, a
post-change `verify` callback, a compensating `rollback` callback, and a
`verifyRollback` callback. `execute` and `verify` run with the selected flag
enabled. On success, the result is returned and the environment-configured flag
value remains unchanged. The override is async-local: concurrent requests and
jobs keep seeing their own configured value, and the override is removed when
the guarded async chain finishes.

If execution throws or verification reports unhealthy, the guard calls
`rollback` with the partial result (or `undefined` if execution did not return)
and the failure cause. Compensation and rollback verification run with the flag
disabled. A verified recovery rejects with `GuardedRolloutAbortedError` and
`rolledBack: true`. If compensation throws, verification throws, or the
pre-rollout invariant is not restored, the guard rejects with
`RolloutRecoveryError` and `rolledBack: false`; this is an operator escalation,
not a successful rollback.

The guard retries the rollback invariant check up to three times by default,
with a short increasing delay. Set `rollbackVerificationAttempts` (1-5) and
`rollbackVerificationBackoffMs` (0-10000 ms) when a subsystem needs a different
bounded window. Both a `false` result and a thrown check are retried. Exhausting
the attempts still raises `RolloutRecoveryError`; a transient verification
failure must never be interpreted as a verified rollback.

```ts
const result = await rolloutGuard.run({
  scopeId: "example-change-canary",
  flag: FeatureFlag.RECONCILIATION_HORIZON_POLLING,
  execute: () => applyScopedChange(scopeId),
  verify: async () => ({
    healthy: await healthCheck(scopeId),
    details: "Describe the measured invariant if the health check fails",
  }),
  rollback: (partialResult) => compensateScopedChange(scopeId, partialResult),
  verifyRollback: () => confirmPreChangeInvariant(scopeId),
});
```

The callback names above are illustrative; the owning subsystem supplies its
actual scoped write, health check, compensator, and invariant check.

The callbacks are responsible for narrowing their work to the intended tenant,
account, or other safe unit. The guard does not choose a traffic percentage or
persist a rollout plan. Its override is scoped to this process's async call
chain; it is not a distributed flag store and does not automatically change
other workers or instances. Use deployment configuration or an existing
distributed control plane for fleet-wide changes.

## Failure handling and recovery

- Make `rollback` idempotent and safe after partial execution. If the operation
  writes to a database, prefer a transaction for atomic writes; use explicit
  compensating actions for effects outside that transaction.
- Keep `verify` independent of the implementation's claimed success. Check
  observable invariants such as lag, error rate, affected-row counts, and
  required records. A thrown check is treated as unhealthy.
- `GuardedRolloutAbortedError` means the compensator completed and
  `verifyRollback` returned `true`. Record the scope and original cause, then
  leave the configured flag unchanged while investigating.
- `RolloutRecoveryError` means the state is uncertain. Stop repeating the
  rollout, contain the affected scope, inspect the original and recovery causes,
  and run the subsystem's reconciliation or repair procedure. Do not report the
  rollout as rolled back until the invariant is checked manually.
- If the rollback check remains false or unavailable after its bounded retries,
  the rollout is not considered restored. Keep the affected scope contained and
  follow the subsystem's recovery procedure before retrying the release.
- If execution fails before returning a result, rollback receives
  `undefined`. The compensator must still inspect scope state and undo partial
  effects; it must not assume `execute` was atomic.
- A process restart clears async-local context. The guard does not persist
  rollout state; use durable operational state for long-running or multi-step
  releases.

The guard logs the scope when verification succeeds, when rollback begins, and
when rollback succeeds or requires operator recovery. Avoid putting user data,
credentials, or sensitive payloads in `scopeId` or health-check details.

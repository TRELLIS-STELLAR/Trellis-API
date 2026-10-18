# Versioned event replay for rebuilding projections (#278)

Projections (read models) are pure folds over the domain event stream. The
replay tool rebuilds one from the full event history: it upcasts events stored
with old schema versions, verifies ordering and the ledger hash chain, and
publishes the result only when the rebuild finishes cleanly.

Code: `src/common/events/replay/`. Builds on the schema registry and
`TamperEvidentLedger` in [DOMAIN_EVENTS.md](DOMAIN_EVENTS.md) and the version
policy in [SCHEMA_EVOLUTION.md](SCHEMA_EVOLUTION.md).

## Concepts

* **Projection** (`ProjectionDefinition`): `name`, a `version`, the schema
  version it expects per event (`handles`), `initialState()` and a pure
  `apply(state, event)`. Bump `version` whenever `apply` or the state shape
  changes; the published version then shows as `stale` until it is rebuilt.
* **Upcaster** (`EventUpcasterRegistry`): pure `fromVersion → toVersion` steps,
  applied in sequence until the projection's version is reached. The result is
  validated against the target schema. Missing paths, duplicate steps and cycles
  are refused. Default: `user.created 1.0 → 2.0` (adds `kycTier: "unverified"`).
* **Source**: an ordered iterable of stored events (`sequence` plus the
  envelope), started after a given sequence.
* **Stores**: a checkpoint store for resume, and a projection store holding the
  active version plus the previous one for rollback. The in-memory defaults can
  be replaced by binding `PROJECTION_CHECKPOINT_STORE` / `PROJECTION_STORE`.

## Running a rebuild

Admin API (ADMIN role + admin 2FA; `@Idempotent()`):

| Route | Purpose |
| --- | --- |
| `GET /admin/projections` | registered projections, code version, published version, `stale`, `running` |
| `POST /admin/projections/:name/rebuild` | body `{ dryRun?, resume?, onPoisonEvent?: "halt"\|"skip", checkpointEvery? }` → replay report |
| `POST /admin/projections/:name/rollback` | restore the previously published version (409 if none) |

CLI (read-only, safe to run against a production export):

```bash
npm run events:replay -- --list
npm run events:replay -- --projection user-directory --input events.ndjson --print-state
npm run events:replay -- --projection user-directory --input ledger-export.json --on-poison skip
```

Exit codes: `0` clean, `1` halted or aborted, `2` usage error.

The report includes `eventsRead`, `applied`, `ignored`, `duplicates`,
`upcasts` (per event and version path), `poisonEvents`, `checkpoints`,
`resumedFromSequence`, `lastSequence` and `stateHash`. Two rebuilds of the same
stream produce the same `stateHash`, so a dry-run of a new projection version
can be compared with a known-good run.

## Failure handling

| Situation | Behaviour |
| --- | --- |
| Handler throws | Retried (`maxApplyAttempts`, default 3) on a fresh copy of the state, so a half-applied mutation cannot leak. |
| Event fails schema validation, has an unknown version or no upcast path | **Poison event.** `halt` (default): stop, publish nothing, keep the last checkpoint. `skip`: record it in `poisonEvents` and continue. |
| Process or source crashes | Restart the rebuild: it resumes from the last checkpoint (every `checkpointEvery` events, default 500). `resume: false` starts from zero. |
| Same sequence delivered twice | Counted in `duplicates` and skipped (at-least-once sources). |
| Sequence goes backwards | **Abort** (`ReplayAbortedError`); the source is mis-ordered. |
| Ledger `previousHash` or `hash` mismatch | **Abort**; the history was altered. Investigate before rebuilding. |
| Second rebuild of the same projection while one runs | Refused (409). |

## Rollback

Publishing is blue/green: the new version becomes active only after a complete
rebuild, and the previous active version is retained. `POST .../rollback` (or
`ProjectionReplayService.rollback()`) restores it in one step. A halted or
aborted rebuild never changes what is served.

## Adding a projection

```ts
// in the owning module
constructor(replay: ProjectionReplayService) {
  replay.register(myProjection, (after) => myEventStore.streamAfter(after));
}
```

Rules: `apply` must be pure and deterministic (no clocks, randomness or I/O),
must not mutate its input, and must tolerate an event delivered twice. Keep PII
out of projected state unless the read model needs it; the example
`user-directory` projection deliberately drops email addresses.

## Contracts

Existing event schemas, producers and consumers are unchanged. The admin routes
and CLI are new; removing them is a plain revert. Published projection state
lives in the configured store, so with the in-memory default a restart means
rebuilding.

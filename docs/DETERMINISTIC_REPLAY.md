# Deterministic replay tests for concurrent writes and retries (#262)

`src/testing/concurrency/deterministic-replay.ts` complements the race
harness in [CONCURRENCY_HARNESS.md](CONCURRENCY_HARNESS.md). The harness
races real async flows; this module controls the interleaving, so a failing
schedule is a value you can print, commit and replay.

An actor is a small state machine; each `step()` is one atomic unit (a read,
a conditional write, a retry decision) and returns `true` when finished. A
schedule is the list of actor indices to step.

| Function | Purpose |
| --- | --- |
| `replaySchedule(create, schedule)` | Replay a recorded schedule on a fresh scenario; remaining actors then run in index order. Returns `{ state, trace, done }`. |
| `exploreInterleavings(create, onComplete)` | Visit every interleaving (bounded by `maxSchedules`), calling `onComplete` with each result so invariants can be asserted. Retry loops are handled because runnable actors are discovered dynamically. |
| `runSeeded(create, seed)` | One pseudo-random interleaving derived from a seed; replaying its `trace` yields the same state. |

## Reproducing a failure

1. `exploreInterleavings` or a seed loop reports a violated invariant.
2. Log `result.trace` (or the seed) in the failure message.
3. Paste the trace into `replaySchedule(create, trace)` in a regression test.

## Covered scenarios (`deterministic-replay.spec.ts`)

Using the real `OptimisticConcurrencyService` for version checks:

- normal path: two contending writers keep every write in all interleavings
- retry path: a stale write conflicts, re-reads and succeeds; exhausted
  retries give up without corrupting the ledger
- duplicate path: a client retry with the same idempotency key is applied once
- authorization path: an unauthorized actor never writes in any interleaving
- the explorer detects a real lost update from an unversioned writer, and the
  failing trace replays to the same wrong state (proves the tool bites)
- seeds are reproducible; non-terminating actors fail with a step-limit error

## Operational notes

- Test-only code; no runtime, schema or contract impact. Rolling back means
  deleting the two files.
- Exhaustive exploration is exponential. Keep scenarios to about 3 actors with
  a few steps each, or use `maxSchedules` and seeded runs; `truncated: true`
  in the summary means coverage was cut short.
- Model each critical write as ONE step. If a real write is not atomic
  (read-modify-write in application code), split it into separate steps so the
  explorer can interleave it.
- Steps must be deterministic: no timers, `Date.now()` or random values.

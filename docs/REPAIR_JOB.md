# Resumable repair job for orphaned and inconsistent records (#266)

`RepairJob` (`src/common/repair/repair-job.ts`) is a generic, checkpointed
repair runner. A domain supplies a `RepairAdapter` (scan, detect, repair,
restore) and a `RepairCheckpointStore`; the job supplies paging, retries,
resume, dry-run, authorization and rollback. Nothing is scheduled or wired
automatically, so existing behavior and contracts are unchanged.

## Adapter contract

- `scan(cursor, limit)` returns a page and the next opaque cursor (`null` at end).
- `detect(record)` is pure and returns a finding (`orphaned` or
  `inconsistent`) or `null`.
- `repair(record, finding)` must be **idempotent**: a repaired record must no
  longer match `detect`. It returns the before-image.
- `restore(recordId, before)` writes the before-image back.

## Behavior

| Path | Outcome |
| --- | --- |
| `run` as `dryRun` | Counts findings in `detected`; changes nothing |
| `run` | Repairs findings, journaling each before-image; checkpoint saved per repair and per batch |
| Transient repair error | Retried `maxRepairRetries` (default 2) times |
| Persistent repair error | Recorded in `failures`; the job continues |
| Scan / store error | Job saved as `failed` at the last committed cursor and the error is rethrown; calling `run` with the same `jobId` resumes there |
| `run` on a completed job | Returns the stored result (no-op) |
| Same `jobId` running twice in a process | `ConflictException` (409) |
| Resuming with a different `dryRun` | `ConflictException` (409) |
| Caller lacks `SYSTEM_MAINTENANCE` | `ForbiddenException` (403) before any read or write |
| `rollback` | Restores before-images newest-first, saving after each; re-runnable if interrupted; job ends `rolled_back` |

## Operational edge cases

- **Crash mid-batch:** the cursor stays at the batch start, the batch is
  re-scanned, and already-repaired records are skipped because `detect` no
  longer matches them. This is why idempotent repair is required.
- **Lost before-image window:** if the process dies after `repair()` but
  before its journal entry is saved, that single record is repaired but not
  journaled and cannot be rolled back by the job. Keep audit/backup data for
  destructive repairs, or make `repair` write its own undo record.
- **Persistent failures** are not retried automatically. Fix the cause and
  start a new job id; detection is state-based so it picks up exactly the
  records still broken.
- **Concurrent writers:** records can change between scan and repair. Make
  `repair` conditional (version check or `WHERE` guard) and let it throw on
  mismatch; the job then retries or records a failure.
- The in-process lock does not span replicas. Run the job from one worker or
  add a lock in the checkpoint store.
- A rolled-back job cannot be resumed; start a new `jobId`.

## Recovery and rollback

1. `run(..., { dryRun: true })` first and review `detected`.
2. Run for real. On failure, fix the cause and call `run` with the same id.
3. To undo, `rollback(actor, jobId)`; if it fails part way, fix the cause and
   call it again.

No schema or API change; not invoking the job reverts to the prior state.

## Verification

`repair-job.spec.ts` uses an in-memory table and covers dry run, full repair,
no-op rerun, resume after a scan failure, no double repair after a
checkpoint-store failure, repair retries and recorded failures,
authorization, concurrent runs, dry-run mismatch, rollback, interrupted
rollback and unknown jobs.

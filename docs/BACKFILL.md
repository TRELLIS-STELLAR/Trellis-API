# Operator-safe backfill tool with dry-run diff and resumable checkpoints (#209)

`npm run backfill` runs domain backfills as checkpointed, resumable jobs.
Every run is a **dry-run preview by default** — it prints the per-record diff
and writes nothing until you pass `--apply`. Progress is stored as one JSON
file per job under `.backfill/` (git-ignored), so an interrupted run resumes
from its last committed cursor instead of starting over.

The tool is a thin vertical slice: it touches no public API, no schema and no
user-facing behavior. Existing endpoints keep working unchanged.

| Piece | Location |
| --- | --- |
| Engine (paging, retries, write-ahead journal, dry-run diff, resume, rollback, RBAC) | `src/common/backfill/backfill-job.ts` |
| Durable checkpoint store (atomic JSON files) | `src/common/backfill/file-checkpoint-store.ts` |
| CLI argument parsing and report rendering | `src/common/backfill/backfill-cli.ts` |
| CLI entry point | `scripts/backfill.ts` |
| First job: `notification-channels` | `src/notifications/backfill/notification-channels.backfill.ts` |
| Runbook | `docs/BACKFILL.md` (this file) |

## Usage

```bash
npm run backfill -- --list                        # checkpoints on disk
npm run backfill -- --job notification-channels   # dry-run preview (default)
npm run backfill -- --job notification-channels --id notification-channels-apply --apply
npm run backfill -- --job notification-channels --id notification-channels-apply --report
npm run backfill -- --job notification-channels --id notification-channels-apply --rollback
npm run backfill -- --job notification-channels --id notification-channels-apply --restart --force
npm run backfill -- --help
```

`--job` selects the backfill (`notification-channels`); `--id` selects the
checkpoint (defaults to `--job`). Give the apply run a fresh `--id` after
reviewing a preview — a completed preview checkpoint can never be applied in
place.

Options: `--batch-size <n>` (default 100), `--diff-limit <n>` (default 500),
`--checkpoint-dir <path>` (default `.backfill`).

Exit codes: `0` completed with no failed records, `1` the job failed or
recorded failures, `2` usage error.

The job runs with `MAINTAINER` privileges (it needs
`system:maintenance`); override the operator identity with
`BACKFILL_OPERATOR_ID`. A checkpoint holds rollback data, so `--restart` on a
job that already applied records requires `--force`.

## Checkpoint contract

One file per job: `<checkpoint-dir>/<jobId>.json`, where `jobId` is `--id`
(defaults to `--job`). Saves are atomic (temp
file + rename), so a crash mid-save never corrupts the previous checkpoint.

```jsonc
{
  "jobId": "notification-channels-1",
  "job": "notification-channels",   // adapter guard: a checkpoint can only be resumed by its own adapter
  "status": "running | completed | failed | rolled_back",
  "dryRun": false,
  "cursor": null,                   // last committed scan cursor
  "scanned": 42, "planned": 7, "applied": 7, "skipped": 35,
  "conflicts": 0,                   // guarded write lost a race; nothing written
  "diffs": [ ... ],                 // capped preview: { recordId, field, before, after }
  "diffTruncated": 0,               // diffs past --diff-limit (counted, not stored)
  "failures": [ { "recordId", "phase": "plan | "apply", "error" } ],
  "journal": [ { "recordId", "undo": { "before", "after" } } ]  // rollback data
}
```

Counter semantics:

- `scanned` — rows read. After resuming an interrupted batch the batch is
  re-scanned, so `scanned` can count rows from that batch twice while
  `planned + skipped` does not line up exactly. The journal, not the
  counters, is the authoritative record of what was written.
- `planned = applied + conflicts + apply-failures` plus `plan-failures`
  (records whose `plan` threw).
- `skipped` — rows already up to date at `plan` time.
- `applied` — guarded writes that succeeded (always 0 in a dry run).

## Behavior

| Path | Outcome |
| --- | --- |
| `run` without `--apply` | Dry-run: prints the diff, writes nothing |
| `run` with `--apply` | Writes each change; undo payload journaled **before** the write (write-ahead) |
| Transient apply error | Retried twice (`maxApplyRetries`) |
| Persistent apply error | Recorded in `failures[phase=apply]`; the job continues |
| `plan` throws | Recorded in `failures[phase=plan]`; the job continues |
| Guarded write matches no row (concurrent change/deleted row) | Counted as `conflicts`, not journaled, not written |
| Scan / checkpoint-store error | Job saved as `failed` at the last committed cursor and the error is rethrown; re-running the same command resumes there |
| Re-run a completed job | No-op (returns the stored checkpoint) |
| Re-run a completed dry-run with `--apply` (same `--id`) | `409` — start the apply with a fresh `--id` (e.g. `notification-channels-apply`), the preview id stays a preview |
| Resume under a different adapter name | `409` |
| Same job id running twice in one process | `409` |
| Caller lacks `system:maintenance` | `403` before any read or write |
| `rollback` | Restores undo payloads newest-first, saving after each; re-runnable if interrupted; job ends `rolled_back` |

## The `notification-channels` job

Backfills legacy `notifications` rows where `channels IS NULL` (rows created
before the `channels` column existed) to `channels = [primaryChannel]`.

Why this is behavior-preserving: the processor already derives channels as
`channels || [primaryChannel]` at delivery time
(`src/notifications/services/notification-processor.service.ts`) and the
broadcast query already falls back to `primaryChannel`
(`notification.service.ts`), so the stored row is only being made to match
what the API already does. No endpoint, response shape or schema changes.

## Operational edge cases and failure modes

- **Crash mid-batch.** The cursor stays at the batch start; the batch is
  re-scanned and rows already written plan to `null` (idempotent), so they
  are re-scanned as `skipped`, never written twice.
- **Checkpoint store down.** The write-ahead journal is saved *before* each
  write, so an applied row always has rollback data. If the store is still
  down at resume time, fix the store (disk, permissions) and re-run — the
  last committed cursor is intact.
- **Corrupt checkpoint file.** The store refuses to guess: restore the file
  from a backup, or delete it and re-run with `--restart --force`. A fresh
  job id is the safest option once a checkpoint is suspect.
- **Concurrent writers.** Writes are guarded (`UPDATE … WHERE channels IS
  NULL` / restore only when the row still holds what the job wrote). Lost
  races are reported as `conflicts`; records changed after the job are never
  clobbered by rollback.
- **Persistent failures** are not retried automatically. Fix the cause and
  start a new job id; the scan is state-based, so it picks up exactly the
  records that still need work.
- **Dry-run then apply.** The preview and the apply run under different job
  ids by design — a completed preview cannot be "upgraded" in place. Review
  the printed diff, then apply with a fresh id.
- **In-process lock only.** The concurrency guard does not span replicas.
  Run the job from one worker, or add a lock to the checkpoint store.
- **Diff growth.** `diffs` is capped at `--diff-limit` (default 500);
  everything beyond the cap is counted in `diffTruncated`, not stored.
- **A rolled-back job cannot be resumed**; start a new job id.

## Rollback and recovery

1. Preview: `npm run backfill -- --job <name>` and review the diff.
2. Apply: add `--apply` under a fresh `--id` (e.g. `notification-channels-apply`).
3. If the run fails: fix the cause and re-run the same command — it resumes
   from the last committed cursor. `--report` shows where it stopped.
4. To undo: `npm run backfill -- --job <name>-apply --rollback`. If the
   rollback itself is interrupted, fix the cause and run it again — it picks
   up where it stopped.
5. Nothing runs automatically; not invoking the tool leaves the prior state
   untouched, and no migration is required to roll back.

## Verification

- `src/common/backfill/backfill-job.spec.ts` — dry-run diff, applied run with
  journal, diff cap, completed no-op, dry-run/apply conflict guards, adapter
  name guard, resume after scan failure, write-ahead durability across a
  checkpoint-save failure, plan/apply failures, retries, conflicts,
  authorization, concurrent runs, report, rollback and interrupted rollback.
- `src/common/backfill/file-checkpoint-store.spec.ts` — atomic saves, corrupt
  file detection, job-id path-traversal rejection, delete/list.
- `src/common/backfill/backfill-cli.spec.ts` — argument parsing and report
  rendering.
- `src/notifications/backfill/notification-channels.backfill.spec.ts` —
  paging, plan/apply/restore semantics, conflict signalling, and an
  end-to-end preview → apply → rollback through the engine.

```bash
npx jest src/common/backfill src/notifications/backfill
npm run lint
```

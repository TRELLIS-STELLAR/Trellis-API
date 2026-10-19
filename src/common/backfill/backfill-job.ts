import {
  ConflictException,
  ForbiddenException,
} from "src/common/errors/app.exception";
import { Permission, Role, hasPermission } from "src/common/guard/roles.enum";

/**
 * Operator-safe backfill runner with dry-run diff and resumable checkpoints (#209).
 *
 * A domain supplies a `BackfillAdapter` (scan, plan, apply, restore) and a
 * `BackfillCheckpointStore`; the job supplies paging, retries, write-ahead
 * journaling, dry-run diff capture, resume, authorization and rollback.
 * Nothing is scheduled or wired automatically, so existing behavior,
 * contracts and schemas are unchanged. See `docs/BACKFILL.md`.
 */
export interface BackfillActor {
  id: string;
  roles: Role[];
}

/** A single proposed (or applied) change to one record. */
export interface BackfillChange {
  recordId: string;
  field: string;
  before: unknown;
  after: unknown;
  reason?: string;
}

export interface BackfillPage<R> {
  records: R[];
  /** `null` when the last page has been returned. */
  nextCursor: string | null;
}

/**
 * Returned by `apply` when its guarded write matched no row (the record was
 * deleted or changed concurrently). Nothing was written, so the job counts a
 * conflict and drops the write-ahead journal entry for that record.
 */
export const BACKFILL_CONFLICT = Symbol.for("trellis.backfill.conflict");

export interface BackfillAdapter<R> {
  scan(cursor: string | null, limit: number): Promise<BackfillPage<R>>;
  /** Stable identifier for a record, used in failures and journal entries. */
  recordId(record: R): string;
  /**
   * Pure: the change this record needs, or `null` when it is already up to
   * date. Must be idempotent — after a successful `apply`, `plan` must return
   * `null` for the same record. May throw; the job records a `plan` failure
   * and continues.
   */
  plan(record: R): BackfillChange | null;
  /**
   * Performs the guarded write. Returns `BACKFILL_CONFLICT` when the guard
   * matched no row (nothing was written), otherwise resolves with no value.
   * Must be idempotent: re-running an already-applied change is safe.
   */
  apply(record: R, change: BackfillChange): Promise<unknown>;
  /**
   * Puts the record back to the state described by `undo` — the
   * `{ before, after }` pair journaled ahead of the write. A guarded restore
   * that matches no row (the record changed after the job) is a no-op.
   */
  restore(recordId: string, undo: unknown): Promise<void>;
}

export type BackfillStatus = "running" | "completed" | "failed" | "rolled_back";
export type BackfillFailurePhase = "plan" | "apply";

export interface BackfillDiffEntry {
  recordId: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface BackfillFailure {
  recordId: string;
  phase: BackfillFailurePhase;
  error: string;
}

export interface BackfillJournalEntry {
  recordId: string;
  undo: unknown;
}

export interface BackfillCheckpoint {
  jobId: string;
  /** Adapter name the checkpoint was created for; guards against reuse. */
  job: string;
  status: BackfillStatus;
  dryRun: boolean;
  cursor: string | null;
  scanned: number;
  planned: number;
  applied: number;
  skipped: number;
  conflicts: number;
  /** Dry-run preview / applied-change diff, capped at `diffLimit`. */
  diffs: BackfillDiffEntry[];
  diffTruncated: number;
  failures: BackfillFailure[];
  journal: BackfillJournalEntry[];
  error?: string;
}

export interface BackfillCheckpointStore {
  load(jobId: string): Promise<BackfillCheckpoint | null>;
  save(checkpoint: BackfillCheckpoint): Promise<void>;
}

export interface BackfillRunOptions {
  dryRun?: boolean;
  batchSize?: number;
  /** Extra attempts per record before it is recorded as a failure. */
  maxApplyRetries?: number;
  /** Maximum diff entries kept in the checkpoint (rest are counted only). */
  diffLimit?: number;
}

export interface BackfillJobOptions {
  requiredPermission?: Permission;
  /** Adapter name stored in the checkpoint; defaults to `backfill`. */
  jobName?: string;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_DIFF_LIMIT = 500;

type ApplyOutcome = "applied" | "conflict" | "failed";

export class BackfillJob<R> {
  private readonly active = new Set<string>();

  constructor(
    private readonly adapter: BackfillAdapter<R>,
    private readonly store: BackfillCheckpointStore,
    private readonly options: BackfillJobOptions = {},
  ) {}

  /**
   * Starts the job, or resumes it from its checkpoint. A completed job is
   * returned unchanged, so repeating the call is a no-op. A scan or
   * checkpoint failure marks the job `failed` and rethrows; calling `run`
   * again with the same `jobId` continues from the last saved cursor.
   */
  async run(
    actor: BackfillActor,
    jobId: string,
    options: BackfillRunOptions = {},
  ): Promise<BackfillCheckpoint> {
    this.authorize(actor);
    return this.exclusive(jobId, async () => {
      const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
      const retries = options.maxApplyRetries ?? DEFAULT_MAX_RETRIES;
      const diffLimit = options.diffLimit ?? DEFAULT_DIFF_LIMIT;
      const jobName = this.options.jobName ?? "backfill";
      const existing = await this.store.load(jobId);

      if (existing && existing.status === "rolled_back") {
        throw new ConflictException(
          `Backfill job ${jobId} was rolled back; use a new job id`,
        );
      }
      if (existing && existing.job !== jobName) {
        throw new ConflictException(
          `Backfill job ${jobId} belongs to '${existing.job}', not '${jobName}'; use a new job id`,
        );
      }
      if (
        existing &&
        options.dryRun !== undefined &&
        existing.dryRun !== options.dryRun
      ) {
        throw new ConflictException(
          existing.dryRun
            ? `Backfill job ${jobId} was a dry-run preview; use a new job id to apply`
            : `Backfill job ${jobId} was started with dryRun=false; use a new job id to preview`,
        );
      }
      if (existing && existing.status === "completed") return existing;

      const checkpoint: BackfillCheckpoint = existing
        ? { ...clone(existing), status: "running", error: undefined }
        : {
            jobId,
            job: jobName,
            status: "running",
            dryRun: options.dryRun ?? false,
            cursor: null,
            scanned: 0,
            planned: 0,
            applied: 0,
            skipped: 0,
            conflicts: 0,
            diffs: [],
            diffTruncated: 0,
            failures: [],
            journal: [],
          };

      let committed: BackfillCheckpoint = clone(checkpoint);
      const persist = async (scanned: number): Promise<void> => {
        const next = { ...clone(checkpoint), scanned };
        await this.store.save(clone(next));
        committed = next;
      };

      try {
        do {
          const batchStartScanned = checkpoint.scanned;
          const page = await this.adapter.scan(checkpoint.cursor, batchSize);
          for (const record of page.records) {
            checkpoint.scanned += 1;
            let change: BackfillChange | null;
            try {
              change = this.adapter.plan(record);
            } catch (error) {
              this.recordFailure(
                checkpoint,
                this.adapter.recordId(record),
                "plan",
                error,
              );
              continue;
            }
            if (!change) {
              checkpoint.skipped += 1;
              continue;
            }
            checkpoint.planned += 1;
            if (checkpoint.dryRun) {
              this.recordDiff(checkpoint, change, diffLimit);
              continue;
            }
            // Write-ahead journaling: the undo payload is persisted before the
            // write, so a crash can never leave an applied record without
            // rollback data.
            this.journal(checkpoint, change);
            await persist(batchStartScanned);
            const outcome = await this.applyOne(
              record,
              change,
              retries,
              checkpoint,
            );
            if (outcome === "conflict") {
              checkpoint.conflicts += 1;
              this.dropJournal(checkpoint, change.recordId);
            } else if (outcome === "applied") {
              checkpoint.applied += 1;
              this.recordDiff(checkpoint, change, diffLimit);
            }
          }
          checkpoint.cursor = page.nextCursor;
          if (checkpoint.cursor === null) checkpoint.status = "completed";
          await persist(checkpoint.scanned);
        } while (checkpoint.cursor !== null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        checkpoint.status = "failed";
        checkpoint.error = message;
        try {
          await this.store.save({
            ...clone(committed),
            status: "failed",
            error: message,
          });
        } catch {
          // Store unavailable: the last saved checkpoint is still resumable.
        }
        throw error;
      }
      return checkpoint;
    });
  }

  /**
   * Loads the stored checkpoint for inspection (`--report`); returns `null`
   * when the job has never run.
   */
  async report(
    actor: BackfillActor,
    jobId: string,
  ): Promise<BackfillCheckpoint | null> {
    this.authorize(actor);
    return this.store.load(jobId);
  }

  /**
   * Restores journaled undo payloads newest-first. The journal shrinks as
   * records are restored and is saved after each one, so an interrupted
   * rollback can be re-run and will pick up where it stopped. An undo payload
   * whose guarded restore matches no row (the record changed after the job)
   * is a no-op.
   */
  async rollback(
    actor: BackfillActor,
    jobId: string,
  ): Promise<BackfillCheckpoint> {
    this.authorize(actor);
    return this.exclusive(jobId, async () => {
      const checkpoint = await this.store.load(jobId);
      if (!checkpoint)
        throw new ConflictException(`Backfill job ${jobId} does not exist`);

      const journal = [...checkpoint.journal];
      while (journal.length) {
        const entry = journal[journal.length - 1];
        await this.adapter.restore(entry.recordId, entry.undo);
        journal.pop();
        await this.store.save(clone({ ...checkpoint, journal }));
      }
      const done: BackfillCheckpoint = {
        ...checkpoint,
        status: "rolled_back",
        journal: [],
        applied: 0,
      };
      await this.store.save(clone(done));
      return done;
    });
  }

  private async applyOne(
    record: R,
    change: BackfillChange,
    retries: number,
    checkpoint: BackfillCheckpoint,
  ): Promise<ApplyOutcome> {
    let lastError = "";
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const undo = await this.adapter.apply(record, change);
        if (undo === BACKFILL_CONFLICT) return "conflict";
        return "applied";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.recordFailure(checkpoint, change.recordId, "apply", lastError);
    return "failed";
  }

  private journal(
    checkpoint: BackfillCheckpoint,
    change: BackfillChange,
  ): void {
    if (checkpoint.journal.some((entry) => entry.recordId === change.recordId))
      return;
    checkpoint.journal.push({
      recordId: change.recordId,
      undo: { before: change.before, after: change.after },
    });
  }

  private dropJournal(checkpoint: BackfillCheckpoint, recordId: string): void {
    checkpoint.journal = checkpoint.journal.filter(
      (entry) => entry.recordId !== recordId,
    );
  }

  private recordDiff(
    checkpoint: BackfillCheckpoint,
    change: BackfillChange,
    diffLimit: number,
  ): void {
    if (checkpoint.diffs.length < diffLimit) {
      checkpoint.diffs.push({
        recordId: change.recordId,
        field: change.field,
        before: change.before,
        after: change.after,
      });
      return;
    }
    checkpoint.diffTruncated += 1;
  }

  private recordFailure(
    checkpoint: BackfillCheckpoint,
    recordId: string,
    phase: BackfillFailurePhase,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    checkpoint.failures = checkpoint.failures.filter(
      (failure) => !(failure.recordId === recordId && failure.phase === phase),
    );
    checkpoint.failures.push({ recordId, phase, error: message });
  }

  private authorize(actor: BackfillActor): void {
    const required =
      this.options.requiredPermission ?? Permission.SYSTEM_MAINTENANCE;
    if (!hasPermission(actor.roles, required)) {
      throw new ForbiddenException("Not allowed to run backfill jobs");
    }
  }

  private async exclusive<T>(
    jobId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.active.has(jobId)) {
      throw new ConflictException(`Backfill job ${jobId} is already running`);
    }
    this.active.add(jobId);
    try {
      return await work();
    } finally {
      this.active.delete(jobId);
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

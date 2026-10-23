import { ConflictException, ForbiddenException } from "../errors/app.exception";
import { Permission, Role, hasPermission } from "../guard/roles.enum";

/**
 * Resumable repair job for orphaned and inconsistent records (#266).
 *
 * The job pages through records with an opaque cursor, asks the adapter's pure
 * `detect` whether each record is broken, and applies the adapter's `repair`.
 * Progress is checkpointed after every batch, so a crash or a failed scan
 * resumes from the last committed cursor instead of starting over. Repairs
 * must be idempotent (a repaired record no longer matches `detect`), which
 * makes re-processing the one batch that was in flight at crash time safe.
 * Each repair journals the record's before-image so `rollback` can undo it.
 */
export interface RepairActor {
  id: string;
  roles: Role[];
}

export type RepairFindingKind = "orphaned" | "inconsistent";

export interface RepairFinding {
  recordId: string;
  kind: RepairFindingKind;
  reason: string;
}

export interface RepairPage<R> {
  records: R[];
  /** `null` when the last page has been returned. */
  nextCursor: string | null;
}

export interface RepairAdapter<R> {
  scan(cursor: string | null, limit: number): Promise<RepairPage<R>>;
  /** Pure: returns a finding when the record is broken, else `null`. */
  detect(record: R): RepairFinding | null;
  /** Idempotent fix. Returns the before-image needed by `restore`. */
  repair(record: R, finding: RepairFinding): Promise<unknown>;
  /** Puts back the before-image captured by `repair`. */
  restore(recordId: string, before: unknown): Promise<void>;
}

export type RepairStatus = "running" | "completed" | "failed" | "rolled_back";

export interface RepairJournalEntry {
  recordId: string;
  before: unknown;
}

export interface RepairFailure {
  recordId: string;
  error: string;
}

export interface RepairCheckpoint {
  jobId: string;
  status: RepairStatus;
  dryRun: boolean;
  cursor: string | null;
  scanned: number;
  repaired: number;
  /** Findings seen in dry-run mode (nothing was changed). */
  detected: number;
  failures: RepairFailure[];
  journal: RepairJournalEntry[];
  error?: string;
}

export interface RepairCheckpointStore {
  load(jobId: string): Promise<RepairCheckpoint | null>;
  save(checkpoint: RepairCheckpoint): Promise<void>;
}

export interface RepairRunOptions {
  dryRun?: boolean;
  batchSize?: number;
  /** Extra attempts per record before it is recorded as a failure. */
  maxRepairRetries?: number;
}

const DEFAULT_BATCH_SIZE = 100;

export class RepairJob<R> {
  private readonly active = new Set<string>();

  constructor(
    private readonly adapter: RepairAdapter<R>,
    private readonly store: RepairCheckpointStore,
    private readonly requiredPermission: Permission = Permission.SYSTEM_MAINTENANCE,
  ) {}

  /**
   * Starts the job, or resumes it from its checkpoint. A completed job is
   * returned unchanged, so repeating the call is a no-op. A scan or
   * checkpoint failure marks the job `failed` and rethrows; calling `run`
   * again with the same `jobId` continues from the last saved cursor.
   */
  async run(
    actor: RepairActor,
    jobId: string,
    options: RepairRunOptions = {},
  ): Promise<RepairCheckpoint> {
    this.authorize(actor);
    return this.exclusive(jobId, async () => {
      const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
      const retries = options.maxRepairRetries ?? 2;
      const existing = await this.store.load(jobId);

      if (existing && existing.status === "rolled_back") {
        throw new ConflictException(`Repair job ${jobId} was rolled back; use a new job id`);
      }
      if (existing && existing.status === "completed") return existing;
      if (existing && options.dryRun !== undefined && existing.dryRun !== options.dryRun) {
        throw new ConflictException(
          `Repair job ${jobId} was started with dryRun=${existing.dryRun}; use a new job id`,
        );
      }

      const checkpoint: RepairCheckpoint = existing
        ? { ...clone(existing), status: "running", error: undefined }
        : {
            jobId,
            status: "running",
            dryRun: options.dryRun ?? false,
            cursor: null,
            scanned: 0,
            repaired: 0,
            detected: 0,
            failures: [],
            journal: [],
          };

      let committed: RepairCheckpoint = clone(checkpoint);
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
            const finding = this.adapter.detect(record);
            if (!finding) continue;
            if (checkpoint.dryRun) {
              checkpoint.detected += 1;
              continue;
            }
            if (await this.repairOne(checkpoint, record, finding, retries)) {
              // Persist the before-image immediately, keeping the cursor at the
              // batch start: a crash mid-batch re-scans the batch (repaired
              // records no longer match `detect`) without losing rollback data.
              await persist(batchStartScanned);
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
          await this.store.save({ ...clone(committed), status: "failed", error: message });
        } catch {
          // Store unavailable: the last saved checkpoint is still resumable.
        }
        throw error;
      }
      return checkpoint;
    });
  }

  /**
   * Restores journaled before-images newest-first. The journal shrinks as
   * records are restored and is saved after each one, so an interrupted
   * rollback can be re-run and will pick up where it stopped.
   */
  async rollback(actor: RepairActor, jobId: string): Promise<RepairCheckpoint> {
    this.authorize(actor);
    return this.exclusive(jobId, async () => {
      const checkpoint = await this.store.load(jobId);
      if (!checkpoint) throw new ConflictException(`Repair job ${jobId} does not exist`);

      const journal = [...checkpoint.journal];
      while (journal.length) {
        const entry = journal[journal.length - 1];
        await this.adapter.restore(entry.recordId, entry.before);
        journal.pop();
        await this.store.save(clone({ ...checkpoint, journal }));
      }
      const done: RepairCheckpoint = {
        ...checkpoint,
        status: "rolled_back",
        journal: [],
        repaired: 0,
      };
      await this.store.save(clone(done));
      return done;
    });
  }

  private async repairOne(
    checkpoint: RepairCheckpoint,
    record: R,
    finding: RepairFinding,
    retries: number,
  ): Promise<boolean> {
    let lastError = "";
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const before = await this.adapter.repair(record, finding);
        checkpoint.journal.push({ recordId: finding.recordId, before });
        checkpoint.repaired += 1;
        return true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    checkpoint.failures = checkpoint.failures.filter(
      (failure) => failure.recordId !== finding.recordId,
    );
    checkpoint.failures.push({ recordId: finding.recordId, error: lastError });
    return false;
  }

  private authorize(actor: RepairActor): void {
    if (!hasPermission(actor.roles, this.requiredPermission)) {
      throw new ForbiddenException("Not allowed to run record repair jobs");
    }
  }

  private async exclusive<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    if (this.active.has(jobId)) {
      throw new ConflictException(`Repair job ${jobId} is already running`);
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

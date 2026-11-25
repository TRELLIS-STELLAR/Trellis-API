import { ForbiddenException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import { Permission, hasPermission } from "../guard/roles.enum";
import { BatchActor } from "./bounded-batch-processor";

/**
 * Recovery checkpoint journal for interrupted batch disbursements (#529).
 *
 * Every disbursement item is written to an append-only JSONL journal *before*
 * the external call (`intent`) and again *after* it returns (`confirmed`, or
 * `failed`). The journal is the only source of truth on restart. It makes three
 * states distinguishable that a plain "done" checkpoint cannot:
 *
 *  - never journaled             -> safe to execute
 *  - `confirmed`                 -> already paid; must never run again
 *  - `intent` with no terminal   -> INDETERMINATE: the process died between the
 *    intent write and the confirmation write, so the external system may or may
 *    not have accepted the payout. Resubmitting blindly is how a payout is paid
 *    twice, so these are reconciled against the external system first, and the
 *    run halts if no reconciler is supplied.
 *
 * Failure contract for a live run:
 *  - `isRetryable(error) === true` means the error was raised *before* the
 *    payout was submitted. Only then is an automatic retry safe.
 *  - Any other error has an unknown outcome. It is journaled as a
 *    non-retryable failure and the run halts for operator review. It is never
 *    retried automatically, because a timeout can hide a payout that landed.
 *
 * Durability: each append is `write` + `fsync` on one file descriptor, so a
 * confirmed line the caller observed is on disk. A torn final line (crash
 * mid-write) was never acknowledged and is ignored on replay. A corrupt or
 * out-of-sequence line anywhere else throws, because skipping it could hide a
 * confirmed payout.
 *
 * Single writer: one process owns a batch id at a time. This file does not
 * coordinate concurrent writers; the caller must prevent them.
 */

export type JournalState = "intent" | "confirmed" | "failed";

export interface JournalEntry {
  /** 1-based and contiguous per batch. */
  seq: number;
  batchId: string;
  itemKey: string;
  state: JournalState;
  attempt: number;
  at: string;
  /** External reference returned by the processor (confirmed entries). */
  ref?: string;
  /** Failure message (failed entries). */
  error?: string;
  /** Whether the failed attempt was rejected before submission (failed entries). */
  retryable?: boolean;
  /** True when the confirmation came from reconciliation, not a live call. */
  reconciled?: boolean;
}

export interface ResumePlan {
  /** Never journaled, or last failed with a retryable error: safe to execute. */
  toExecute: string[];
  /** Confirmed earlier: must be skipped. */
  confirmed: string[];
  /** Intent with no terminal entry: outcome unknown, needs reconciliation. */
  indeterminate: string[];
  /** Last failed non-retryably: needs operator review, never retried automatically. */
  permanentlyFailed: string[];
}

const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class CheckpointJournal {
  private readonly lastSeqByBatch = new Map<string, number>();

  constructor(private readonly dir: string) {}

  /** Append one entry durably (write + fsync). */
  append(
    batchId: string,
    itemKey: string,
    state: JournalState,
    attempt: number,
    extra: Partial<
      Pick<JournalEntry, "ref" | "error" | "retryable" | "reconciled">
    > = {},
  ): JournalEntry {
    const file = this.fileFor(batchId);
    const seq = this.lastSeq(batchId) + 1;
    const entry: JournalEntry = {
      seq,
      batchId,
      itemKey,
      state,
      attempt,
      at: new Date().toISOString(),
      ...extra,
    };

    fs.mkdirSync(this.dir, { recursive: true });
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.lastSeqByBatch.set(batchId, seq);
    return entry;
  }

  /**
   * Read every entry for a batch. A torn final line is dropped because it was
   * never acknowledged. Any other malformed or out-of-sequence line throws.
   */
  replay(batchId: string): JournalEntry[] {
    const file = this.fileFor(batchId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const lines = raw.split("\n");
    const endsCleanly = raw.endsWith("\n");
    const entries: JournalEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "") continue;
      const isLast = i === lines.length - 1;
      let parsed: JournalEntry;
      try {
        parsed = JSON.parse(line) as JournalEntry;
      } catch {
        if (isLast && !endsCleanly) break; // torn tail: never acknowledged
        throw new Error(
          `Checkpoint journal ${file} is corrupt at line ${i + 1}; restore it from a backup before resuming`,
        );
      }
      if (parsed.seq !== entries.length + 1) {
        throw new Error(
          `Checkpoint journal ${file} has a sequence gap at line ${i + 1} (expected ${entries.length + 1}, got ${parsed.seq})`,
        );
      }
      entries.push(parsed);
    }
    return entries;
  }

  /**
   * Classify item keys against the journal. Writes nothing. Each key is judged
   * by its latest entry, so an item that was retried and then confirmed reports
   * as confirmed, not indeterminate.
   */
  plan(batchId: string, itemKeys: string[]): ResumePlan {
    return this.planFromEntries(this.replay(batchId), itemKeys);
  }

  private planFromEntries(
    entries: JournalEntry[],
    itemKeys: string[],
  ): ResumePlan {
    const latest = new Map<string, JournalEntry>();
    for (const entry of entries) latest.set(entry.itemKey, entry);

    const plan: ResumePlan = {
      toExecute: [],
      confirmed: [],
      indeterminate: [],
      permanentlyFailed: [],
    };
    for (const key of itemKeys) {
      const last = latest.get(key);
      if (!last) plan.toExecute.push(key);
      else if (last.state === "confirmed") plan.confirmed.push(key);
      else if (last.state === "intent") plan.indeterminate.push(key);
      else if (last.retryable) plan.toExecute.push(key);
      else plan.permanentlyFailed.push(key);
    }
    return plan;
  }

  private lastSeq(batchId: string): number {
    const cached = this.lastSeqByBatch.get(batchId);
    if (cached !== undefined) return cached;
    const entries = this.replay(batchId);
    const last = entries.length === 0 ? 0 : entries[entries.length - 1].seq;
    this.lastSeqByBatch.set(batchId, last);
    return last;
  }

  private fileFor(batchId: string): string {
    if (!BATCH_ID_PATTERN.test(batchId)) {
      throw new Error(
        `Invalid batch id '${batchId}'; use 1-64 characters from [A-Za-z0-9._-] starting with a letter or digit`,
      );
    }
    return path.join(this.dir, `${batchId}.journal.jsonl`);
  }
}

export interface DisbursementExecution {
  /** External reference (for example a transaction hash). */
  ref: string;
}

export interface DisbursementReport<TItem> {
  batchId: string;
  /** Keys confirmed by a live call in this run. */
  confirmed: string[];
  /** Keys confirmed in an earlier run and skipped. */
  skipped: string[];
  /** Keys found already paid during reconciliation. */
  reconciled: string[];
  /** Keys whose outcome is unknown; the run halted before them. */
  indeterminate: string[];
  /** Keys that need operator review (non-retryable, or already failed for good). */
  permanentlyFailed: string[];
  /** Failures recorded in this run. */
  failed: { key: string; error: string; retryable: boolean }[];
  /** True when the run stopped early. */
  halted: boolean;
  /** Items not attempted in this run. */
  pending: TItem[];
}

export interface DisbursementRunOptions<TItem> {
  batchId: string;
  items: TItem[];
  keyOf: (item: TItem) => string;
  /**
   * Performs the external call. `idempotencyKey` is stable across retries and
   * resumes (`<batchId>:<itemKey>`) and must be used by the processor to
   * dedupe.
   */
  execute: (
    item: TItem,
    idempotencyKey: string,
  ) => Promise<DisbursementExecution>;
  /**
   * Asks the external system whether an indeterminate item already took effect.
   * `confirmed` means do not resubmit. `absent` means it is safe to execute.
   * Without a reconciler, indeterminate items halt the run.
   */
  reconcile?: (
    item: TItem,
    idempotencyKey: string,
  ) => Promise<"confirmed" | "absent">;
  /** True only for errors raised before the payout was submitted. */
  isRetryable?: (error: unknown) => boolean;
  /** Attempts per item for retryable errors. Defaults to 1 (no retry). */
  maxAttempts?: number;
  /** Base backoff in ms; doubles per attempt. */
  retryDelayMs?: number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  actor: BatchActor;
}

/**
 * Runs a batch disbursement resumably. Items run strictly in order, and the run
 * halts on the first unresolved item, so later items cannot overtake one that
 * is still in doubt.
 *
 * Authorization: the actor must hold `PAYMENT_PROCESS`. The check runs before
 * any journal write, so an unauthorized caller leaves no trace.
 */
export async function runResumableDisbursement<TItem>(
  journal: CheckpointJournal,
  options: DisbursementRunOptions<TItem>,
): Promise<DisbursementReport<TItem>> {
  if (!hasPermission(options.actor.roles, Permission.PAYMENT_PROCESS)) {
    throw new ForbiddenException(
      "Actor lacks payment:process permission for disbursement",
    );
  }

  const {
    batchId,
    items,
    keyOf,
    execute,
    reconcile,
    isRetryable = () => false,
    maxAttempts = 1,
    retryDelayMs = 0,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const keys = items.map(keyOf);
  const itemByKey = new Map(items.map((item) => [keyOf(item), item]));
  const history = journal.replay(batchId);
  const plan = journal.plan(batchId, keys);

  // Attempt counter continues from the journal so attempt numbers stay unique.
  const attemptsSoFar = new Map<string, number>();
  for (const entry of history) {
    attemptsSoFar.set(
      entry.itemKey,
      Math.max(entry.attempt, attemptsSoFar.get(entry.itemKey) ?? 0),
    );
  }
  const nextAttempt = (key: string) => (attemptsSoFar.get(key) ?? 0) + 1;

  const report: DisbursementReport<TItem> = {
    batchId,
    confirmed: [],
    skipped: [...plan.confirmed],
    reconciled: [],
    indeterminate: [],
    permanentlyFailed: [...plan.permanentlyFailed],
    failed: [],
    halted: false,
    pending: [],
  };

  // Work in input order. Each key is executed, skipped, or held back.
  const queue: string[] = [];
  for (const key of keys) {
    if (plan.confirmed.includes(key)) continue;

    // A prior run stopped on this item. Nothing after it may run until an
    // operator resolves it, so later items cannot overtake it.
    if (plan.permanentlyFailed.includes(key)) {
      report.halted = true;
      break;
    }

    if (plan.indeterminate.includes(key)) {
      if (!reconcile) {
        report.indeterminate.push(key);
        report.halted = true;
        break;
      }
      const outcome = await reconcile(itemByKey.get(key)!, `${batchId}:${key}`);
      if (outcome === "confirmed") {
        const attempt = nextAttempt(key);
        attemptsSoFar.set(key, attempt);
        journal.append(batchId, key, "confirmed", attempt, {
          reconciled: true,
        });
        report.reconciled.push(key);
        continue;
      }
      // "absent": the payout did not land, so it is safe to execute.
    }
    queue.push(key);
  }

  for (let index = 0; index < queue.length && !report.halted; index++) {
    const key = queue[index];
    const item = itemByKey.get(key)!;
    const idempotencyKey = `${batchId}:${key}`;

    let finished = false;
    for (let round = 1; round <= maxAttempts && !finished; round++) {
      const attempt = nextAttempt(key);
      attemptsSoFar.set(key, attempt);
      journal.append(batchId, key, "intent", attempt);

      try {
        const result = await execute(item, idempotencyKey);
        journal.append(batchId, key, "confirmed", attempt, { ref: result.ref });
        report.confirmed.push(key);
        finished = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = isRetryable(error);
        journal.append(batchId, key, "failed", attempt, {
          error: message,
          retryable,
        });
        report.failed.push({ key, error: message, retryable });

        if (!retryable) {
          // Unknown outcome: stop, do not retry automatically.
          report.permanentlyFailed.push(key);
          report.halted = true;
          break;
        }
        if (round === maxAttempts) {
          report.halted = true;
          break;
        }
        if (retryDelayMs > 0) {
          await sleep(retryDelayMs * 2 ** (round - 1));
        }
      }
    }
  }

  // Everything not resolved in this run is pending, whatever stopped the run.
  const resolved = new Set<string>([
    ...report.confirmed,
    ...report.skipped,
    ...report.reconciled,
    ...report.permanentlyFailed,
  ]);
  report.pending = items.filter((item) => !resolved.has(keyOf(item)));
  return report;
}

import { createHash } from "crypto";
import {
  DomainEventEnvelope,
  DomainEventRegistry,
  DomainEventValidationError,
  UnknownEventVersionError,
} from "../domain-event-schema";
import { EventUpcasterRegistry, UpcastError } from "./event-upcaster";

/**
 * Versioned event replay for rebuilding projections (#278).
 *
 * A projection is a pure fold over the event stream. Rebuilding one means
 * reading every stored event in order, upcasting old schema versions to the
 * versions the projection understands, and applying them to a fresh state —
 * *without* disturbing the projection that is currently serving reads.
 *
 * Guarantees:
 * - **Versioned.** Each projection declares a `version` and the schema version
 *   it expects per event. Rebuilt state is stored under that version; the live
 *   version is only switched after the rebuild completes (blue/green), and the
 *   previous version is kept for `rollback()`.
 * - **Ordered and tamper-checked.** Events must have strictly increasing
 *   sequence numbers; a repeated sequence is skipped (at-least-once sources),
 *   a regression aborts. When events carry ledger hashes the chain is verified.
 * - **Resumable.** State is checkpointed every N events, so a crashed or
 *   interrupted rebuild resumes from the last checkpoint instead of from zero.
 * - **Explicit failure policy.** A transient handler error is retried; an event
 *   that cannot be validated, upcast or applied either halts the rebuild
 *   (`halt`, the default — nothing is published) or is recorded and skipped
 *   (`skip`, for operators who accept a known gap).
 * - **Deterministic.** The report includes a hash of the final state, so two
 *   rebuilds of the same stream can be compared.
 */

/** A stored event: an envelope plus its position in the stream. */
export interface StoredEvent<
  T = Record<string, unknown>,
> extends DomainEventEnvelope<T> {
  sequence: number;
}

/** Ordered event stream starting after `afterSequence`. */
export type EventSource = (
  afterSequence: number,
) => AsyncIterable<StoredEvent> | Iterable<StoredEvent>;

export interface ProjectionDefinition<S> {
  name: string;
  /** Bump whenever `apply` or the state shape changes; forces a rebuild. */
  version: number;
  /** Schema version this projection expects for each event it handles. */
  handles: Record<string, string>;
  initialState(): S;
  /** Pure: returns the next state. Must not mutate `state`. */
  apply(state: S, event: StoredEvent): S;
}

export interface ProjectionCheckpoint<S = unknown> {
  projection: string;
  version: number;
  sequence: number;
  state: S;
  savedAt: string;
}

export interface CheckpointStore {
  load(
    projection: string,
    version: number,
  ): Promise<ProjectionCheckpoint | null>;
  save(checkpoint: ProjectionCheckpoint): Promise<void>;
  clear(projection: string, version: number): Promise<void>;
}

export interface PublishedProjection<S = unknown> {
  projection: string;
  version: number;
  sequence: number;
  state: S;
  stateHash: string;
  publishedAt: string;
}

/** Where rebuilt projections are published, with one level of rollback. */
export interface ProjectionStore {
  getActive(projection: string): Promise<PublishedProjection | null>;
  /** Makes `next` active and keeps the previous active version for rollback. */
  swap(next: PublishedProjection): Promise<PublishedProjection | null>;
  /** Restores the previous version. Returns it, or null when there is none. */
  rollback(projection: string): Promise<PublishedProjection | null>;
}

export type PoisonPolicy = "halt" | "skip";

export interface ReplayOptions {
  /** Resume from the last checkpoint for this projection version (default true). */
  resume?: boolean;
  /** Persist a checkpoint every N applied events (default 500). */
  checkpointEvery?: number;
  /** What to do with an event that cannot be processed (default `halt`). */
  onPoisonEvent?: PoisonPolicy;
  /** Attempts per event when `apply` throws (default 3). */
  maxApplyAttempts?: number;
  /** Rebuild and report without publishing or checkpointing. */
  dryRun?: boolean;
  /** Stop after this many events (for sampling a long stream). */
  limit?: number;
}

export interface PoisonEventRecord {
  sequence: number;
  eventId: string;
  eventName: string;
  schemaVersion: string;
  reason: string;
}

export type ReplayOutcome = "published" | "dry-run" | "halted" | "aborted";

export interface ReplayReport {
  projection: string;
  version: number;
  outcome: ReplayOutcome;
  resumedFromSequence: number;
  lastSequence: number;
  eventsRead: number;
  applied: number;
  ignored: number;
  duplicates: number;
  /** Count of events upcast, keyed by `eventName fromVersion->toVersion`. */
  upcasts: Record<string, number>;
  poisonEvents: PoisonEventRecord[];
  checkpoints: number;
  stateHash: string | null;
  durationMs: number;
  /** Set when the rebuild stopped early. */
  error?: string;
}

export class ReplayAbortedError extends Error {
  constructor(
    message: string,
    public readonly report: ReplayReport,
  ) {
    super(message);
    this.name = "ReplayAbortedError";
  }
}

export class ReplayInProgressError extends Error {
  constructor(public readonly projection: string) {
    super(`A rebuild of projection '${projection}' is already running`);
    this.name = "ReplayInProgressError";
  }
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function hashState(state: unknown): string {
  return createHash("sha256").update(canonicalize(state)).digest("hex");
}

/** Hash rule of `TamperEvidentLedger`, so ledger exports can be replayed and verified. */
function ledgerHash(event: StoredEvent): string {
  const payloadHash = createHash("sha256")
    .update(canonicalize(event.payload))
    .digest("hex");
  return createHash("sha256")
    .update(`${event.sequence}:${event.previousHash ?? ""}:${payloadHash}`)
    .digest("hex");
}

export class EventReplayEngine {
  private readonly running = new Set<string>();

  constructor(
    private readonly checkpoints: CheckpointStore,
    private readonly projections: ProjectionStore,
    private readonly upcasters: EventUpcasterRegistry = new EventUpcasterRegistry(),
    private readonly schemas: DomainEventRegistry = DomainEventRegistry.getInstance(),
  ) {}

  isRunning(projection: string): boolean {
    return this.running.has(projection);
  }

  async rebuild<S>(
    projection: ProjectionDefinition<S>,
    source: EventSource,
    options: ReplayOptions = {},
  ): Promise<ReplayReport> {
    if (this.running.has(projection.name))
      throw new ReplayInProgressError(projection.name);
    this.running.add(projection.name);
    try {
      return await this.run(projection, source, options);
    } finally {
      this.running.delete(projection.name);
    }
  }

  /** Restores the previously published version of a projection. */
  rollback(projection: string): Promise<PublishedProjection | null> {
    return this.projections.rollback(projection);
  }

  private async run<S>(
    projection: ProjectionDefinition<S>,
    source: EventSource,
    options: ReplayOptions,
  ): Promise<ReplayReport> {
    const started = Date.now();
    const checkpointEvery = Math.max(1, options.checkpointEvery ?? 500);
    const maxApplyAttempts = Math.max(1, options.maxApplyAttempts ?? 3);
    const policy = options.onPoisonEvent ?? "halt";
    const dryRun = options.dryRun ?? false;

    const checkpoint =
      options.resume === false || dryRun
        ? null
        : await this.checkpoints.load(projection.name, projection.version);

    let state: S = checkpoint
      ? (structuredClone(checkpoint.state) as S)
      : projection.initialState();
    let lastSequence = checkpoint?.sequence ?? 0;
    let lastHash: string | null = null;

    const report: ReplayReport = {
      projection: projection.name,
      version: projection.version,
      outcome: "published",
      resumedFromSequence: lastSequence,
      lastSequence,
      eventsRead: 0,
      applied: 0,
      ignored: 0,
      duplicates: 0,
      upcasts: {},
      poisonEvents: [],
      checkpoints: 0,
      stateHash: null,
      durationMs: 0,
    };

    const finish = (outcome: ReplayOutcome, error?: string): ReplayReport => {
      report.outcome = outcome;
      report.lastSequence = lastSequence;
      report.stateHash = hashState(state);
      report.durationMs = Date.now() - started;
      if (error) report.error = error;
      return report;
    };

    let sinceCheckpoint = 0;
    // False while still reading the already-applied prefix (a source that
    // ignores `afterSequence`, or an at-least-once redelivery after resume).
    let progressed = false;
    for await (const event of source(lastSequence)) {
      if (options.limit !== undefined && report.eventsRead >= options.limit)
        break;
      report.eventsRead += 1;

      // Ordering: duplicates are tolerated, regressions are not.
      if (event.sequence <= lastSequence) {
        if (event.sequence === lastSequence || !progressed) {
          report.duplicates += 1;
          continue;
        }
        throw new ReplayAbortedError(
          `Event stream went backwards at sequence ${event.sequence} (after ${lastSequence})`,
          finish("aborted", "sequence regression"),
        );
      }

      // Tamper check for ledger-sourced events.
      if (event.hash) {
        if (lastHash !== null && (event.previousHash ?? null) !== lastHash) {
          throw new ReplayAbortedError(
            `Ledger chain broken at sequence ${event.sequence}`,
            finish("aborted", "ledger chain mismatch"),
          );
        }
        if (ledgerHash(event) !== event.hash) {
          throw new ReplayAbortedError(
            `Ledger hash mismatch at sequence ${event.sequence}`,
            finish("aborted", "ledger hash mismatch"),
          );
        }
        lastHash = event.hash;
      }

      progressed = true;
      const targetVersion = projection.handles[event.eventName];
      if (targetVersion === undefined) {
        report.ignored += 1;
        lastSequence = event.sequence;
        continue;
      }

      try {
        // Validate the event as it was stored, then upcast to what the
        // projection understands.
        if (this.schemas.getSchema(event.eventName, event.schemaVersion)) {
          this.schemas.validateProducerEvent(event);
        } else {
          throw new UnknownEventVersionError(
            event.eventName,
            event.schemaVersion,
          );
        }
        const { event: upcast, path } = this.upcasters.upcast(
          event,
          targetVersion,
        );
        if (path.length > 0) {
          const key = `${event.eventName} ${path[0]}->${path[path.length - 1]}`;
          report.upcasts[key] = (report.upcasts[key] ?? 0) + 1;
        }
        state = await this.applyWithRetry(
          projection,
          state,
          { ...upcast, sequence: event.sequence },
          maxApplyAttempts,
        );
        report.applied += 1;
      } catch (error) {
        const reason =
          error instanceof DomainEventValidationError ||
          error instanceof UnknownEventVersionError ||
          error instanceof UpcastError
            ? error.message
            : `apply failed: ${(error as Error)?.message ?? error}`;
        report.poisonEvents.push({
          sequence: event.sequence,
          eventId: event.eventId,
          eventName: event.eventName,
          schemaVersion: event.schemaVersion,
          reason,
        });
        if (policy === "halt") {
          // Nothing is published; the checkpoint before this event stays, so
          // a fixed upcaster/handler can resume from here.
          return finish(
            "halted",
            `halted at sequence ${event.sequence}: ${reason}`,
          );
        }
      }

      lastSequence = event.sequence;
      sinceCheckpoint += 1;
      if (!dryRun && sinceCheckpoint >= checkpointEvery) {
        await this.checkpoints.save({
          projection: projection.name,
          version: projection.version,
          sequence: lastSequence,
          state: structuredClone(state),
          savedAt: new Date().toISOString(),
        });
        report.checkpoints += 1;
        sinceCheckpoint = 0;
      }
    }

    if (dryRun) return finish("dry-run");

    const result = finish("published");
    await this.projections.swap({
      projection: projection.name,
      version: projection.version,
      sequence: lastSequence,
      state,
      stateHash: result.stateHash!,
      publishedAt: new Date().toISOString(),
    });
    // The published projection supersedes the checkpoints for this version.
    await this.checkpoints.clear(projection.name, projection.version);
    return result;
  }

  private async applyWithRetry<S>(
    projection: ProjectionDefinition<S>,
    state: S,
    event: StoredEvent,
    maxAttempts: number,
  ): Promise<S> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // A clone per attempt: a handler that mutated state and then threw
        // must not leak a half-applied change into the retry.
        return projection.apply(structuredClone(state), event);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

/** In-memory checkpoint store (tests, CLI). */
export class InMemoryCheckpointStore implements CheckpointStore {
  readonly checkpoints = new Map<string, ProjectionCheckpoint>();
  async load(projection: string, version: number) {
    const found = this.checkpoints.get(`${projection}@${version}`);
    return found ? structuredClone(found) : null;
  }
  async save(checkpoint: ProjectionCheckpoint) {
    this.checkpoints.set(
      `${checkpoint.projection}@${checkpoint.version}`,
      structuredClone(checkpoint),
    );
  }
  async clear(projection: string, version: number) {
    this.checkpoints.delete(`${projection}@${version}`);
  }
}

/** In-memory projection store with one level of rollback (tests, CLI). */
export class InMemoryProjectionStore implements ProjectionStore {
  private readonly active = new Map<string, PublishedProjection>();
  private readonly previous = new Map<string, PublishedProjection>();
  async getActive(projection: string) {
    return this.active.get(projection) ?? null;
  }
  async swap(next: PublishedProjection) {
    const current = this.active.get(next.projection) ?? null;
    if (current) this.previous.set(next.projection, current);
    this.active.set(next.projection, structuredClone(next));
    return current;
  }
  async rollback(projection: string) {
    const prior = this.previous.get(projection);
    if (!prior) return null;
    this.active.set(projection, prior);
    this.previous.delete(projection);
    return prior;
  }
}

/** Builds an {@link EventSource} over an in-memory array, in the given order. */
export function arraySource(events: StoredEvent[]): EventSource {
  const ordered = [...events];
  return function* (afterSequence: number) {
    for (const event of ordered) {
      if (event.sequence > afterSequence) yield event;
    }
  };
}

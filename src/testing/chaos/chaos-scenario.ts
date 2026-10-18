/**
 * Chaos scenario orchestrator.
 *
 * Extends the low-level fault-injection harness (FaultController,
 * FaultyRepository, ManualClock) with three higher-level primitives that
 * represent the failures that actually happen in production:
 *
 *  - `SimulatedRestart`  — mid-flight process kill followed by a clean cold
 *    start. In-flight state is lost; durable state (repository rows) survives.
 *
 *  - `StaleReadInjector` — makes a repository return a snapshot that is behind
 *    the current write head. Reproduces optimistic-lock races and cache/DB
 *    divergence without real concurrency.
 *
 *  - `ProcessKillPoint`  — a synchronisation barrier that the system under test
 *    hits at a named point (e.g. "after-db-write-before-queue-publish"). The
 *    test can arm it to throw, simulating a kill signal arriving between two
 *    durable writes.
 *
 * All primitives are deterministic: no wall clock, no real threads, no random
 * failure probability. Each scenario is scripted up front, runs to completion
 * in a single event-loop turn (plus manual clock advances), and is exactly
 * reproducible.
 *
 * Issue: #207
 */

import {
  FaultController,
  FaultyRepository,
  ManualClock,
  SideEffectLedger,
} from "../fault-injection/fault-injection";

export type {
  FaultController,
  FaultyRepository,
  ManualClock,
  SideEffectLedger,
};

// ---------------------------------------------------------------------------
// SimulatedRestart
// ---------------------------------------------------------------------------

/**
 * Represents a process kill at a deterministic moment.
 *
 * The "process" owns an in-memory working set (anything stored in
 * `ephemeralState`). Durable state lives in repository `rows` arrays and is
 * never cleared. Calling `restart()` clears `ephemeralState` and resets the
 * working-set counters, exactly as a clean process start would.
 */
export class SimulatedRestart {
  /** Counter incremented once per restart — zero means never restarted. */
  restartCount = 0;

  /** Arbitrary working set cleared on each restart. */
  readonly ephemeralState = new Map<string, unknown>();

  /**
   * Simulates a process kill + cold start. All ephemeral state is dropped;
   * durable rows (repository tables) are intentionally not touched.
   *
   * The optional `onRestart` callback runs after state is cleared, so a test
   * can re-wire service instances or re-register event listeners.
   */
  restart(onRestart?: () => void): void {
    this.restartCount += 1;
    this.ephemeralState.clear();
    onRestart?.();
  }

  /** Set a value that will survive only until the next restart. */
  set(key: string, value: unknown): void {
    this.ephemeralState.set(key, value);
  }

  /** Read a value from the ephemeral working set. */
  get<T>(key: string): T | undefined {
    return this.ephemeralState.get(key) as T | undefined;
  }

  /** True if the working set has seen the key since the last restart. */
  has(key: string): boolean {
    return this.ephemeralState.has(key);
  }
}

// ---------------------------------------------------------------------------
// StaleReadInjector
// ---------------------------------------------------------------------------

/**
 * Descriptor for a single stale-read injection.
 *
 * `onCall` is the 1-based call number on the wrapped `findOne` that should
 * return the stale snapshot instead of the live row. Defaults to 1 (the very
 * first read).
 */
export interface StaleReadSpec<T> {
  /** The outdated snapshot to return in place of the live row. */
  snapshot: T;
  /** Which findOne call (1-based) should see the stale snapshot. Defaults to 1. */
  onCall?: number;
}

/**
 * Wraps a `FaultyRepository` so that specific `findOne` calls return an
 * out-of-date snapshot. All other reads and all writes are forwarded unchanged.
 *
 * This reproduces the read-your-own-write failures that happen when a replica
 * lag, an in-process cache, or an optimistic-lock retry reads state that has
 * already been superseded.
 */
export class StaleReadInjector<T extends { id?: string }> {
  private readonly specs: Array<Required<StaleReadSpec<T>>> = [];
  private callCount = 0;

  constructor(private readonly repo: FaultyRepository<T>) {}

  /**
   * Arms a stale snapshot for a specific call number.
   * Multiple calls to `armStaleRead` queue independent snapshots.
   */
  armStaleRead(spec: StaleReadSpec<T>): this {
    this.specs.push({ snapshot: spec.snapshot, onCall: spec.onCall ?? 1 });
    return this;
  }

  /**
   * `findOne` wrapper. Returns the scripted snapshot on the configured call,
   * delegates to the real repository on all others.
   */
  findOne = async (options: { where?: Partial<T> }): Promise<T | null> => {
    this.callCount += 1;
    const matching = this.specs.find((s) => s.onCall === this.callCount);
    if (matching) {
      return matching.snapshot;
    }
    return this.repo.findOne(options);
  };

  /** Delegate all other repository methods transparently. */
  get rows(): T[] {
    return this.repo.rows;
  }

  create = (value: Partial<T>): T => this.repo.create(value);

  find = (): Promise<T[]> =>
    this.repo.find();

  save = (value: T): Promise<T> => this.repo.save(value);

  /** How many times findOne has been called since construction. */
  get totalReads(): number {
    return this.callCount;
  }

  /** Unarmed specs — a stale snapshot that was never triggered. */
  unconsumedStaleReads(): Array<Required<StaleReadSpec<T>>> {
    return this.specs.filter((s) => s.onCall > this.callCount);
  }
}

// ---------------------------------------------------------------------------
// ProcessKillPoint
// ---------------------------------------------------------------------------

/**
 * A synchronisation barrier that the system under test calls at a named
 * checkpoint.
 *
 * When armed with `armKill()`, the next call to `checkpoint(name)` throws a
 * `ProcessKillError` — simulating a SIGKILL arriving at that exact point in
 * execution. This lets a test prove that durable state written before the kill
 * is intact and that the next cold start can recover safely.
 */
export class ProcessKillError extends Error {
  constructor(readonly checkpoint: string) {
    super(`Process killed at checkpoint: ${checkpoint}`);
    this.name = "ProcessKillError";
  }
}

export class ProcessKillPoint {
  private armed = new Set<string>();
  /** Names of every checkpoint that has fired. */
  readonly fired: string[] = [];

  /**
   * Arms the named checkpoint so the next call throws `ProcessKillError`.
   * Multiple checkpoints can be armed simultaneously.
   */
  armKill(checkpointName: string): this {
    this.armed.add(checkpointName);
    return this;
  }

  /**
   * Called by the system under test at a named execution point.
   * If the checkpoint is armed, throws `ProcessKillError`.
   */
  checkpoint(name: string): void {
    if (this.armed.has(name)) {
      this.armed.delete(name);
      this.fired.push(name);
      throw new ProcessKillError(name);
    }
  }

  /** True if the named checkpoint has fired at least once. */
  hasFired(name: string): boolean {
    return this.fired.includes(name);
  }

  /** Disarms all checkpoints without firing them. */
  disarmAll(): void {
    this.armed.clear();
  }
}

// ---------------------------------------------------------------------------
// ChaosScenario — convenience façade
// ---------------------------------------------------------------------------

/**
 * A self-contained chaos scenario.
 *
 * Bundles a `ManualClock`, a `SideEffectLedger`, a `SimulatedRestart`, and a
 * `ProcessKillPoint` together so individual tests do not have to wire them
 * manually.  Additional `FaultController` and `FaultyRepository` instances are
 * created per-collaborator and stored here for cross-cutting assertions.
 */
export class ChaosScenario {
  readonly clock = new ManualClock();
  readonly ledger: SideEffectLedger;
  readonly restart = new SimulatedRestart();
  readonly killPoint = new ProcessKillPoint();

  /** Named fault controllers, indexed by collaborator name. */
  private readonly controllers = new Map<string, FaultController>();

  constructor() {
    this.ledger = new SideEffectLedger(this.clock);
  }

  /** Returns (or lazily creates) the named fault controller. */
  controller(name: string): FaultController {
    if (!this.controllers.has(name)) {
      this.controllers.set(name, new FaultController(name));
    }
    return this.controllers.get(name)!;
  }

  /**
   * Creates a `FaultyRepository` whose fault controller is the one registered
   * under `name`.
   */
  repository<T extends { id?: string }>(
    name: string,
    defaults?: () => Partial<T>,
  ): FaultyRepository<T> {
    return new FaultyRepository<T>(this.controller(name), defaults);
  }

  /**
   * Creates a `StaleReadInjector` wrapping the named repository.
   */
  staleReader<T extends { id?: string }>(
    repo: FaultyRepository<T>,
  ): StaleReadInjector<T> {
    return new StaleReadInjector(repo);
  }

  /**
   * Asserts that the scenario ended cleanly:
   *
   * 1. No irreversible side effect was duplicated.
   * 2. Every scripted fault was consumed (no dead scripts).
   */
  assertClean(): void {
    this.ledger.assertNoDuplicates();
    for (const [name, ctrl] of this.controllers) {
      const dead = ctrl.unconsumed();
      if (dead.length > 0) {
        throw new Error(
          `Fault controller "${name}" has ${dead.length} unconsumed fault(s): ` +
            dead.map((f) => f.spec.kind).join(", ") +
            ". The scenario script was not fully exercised.",
        );
      }
    }
  }
}

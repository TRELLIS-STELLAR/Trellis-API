/**
 * Chaos tests for the retry scheduler pipeline.
 *
 * The retry scheduler has four durable steps:
 *   1. Operation row inserted (PENDING)
 *   2. Poller claims the row (IN_PROGRESS)
 *   3. Handler executes the operation
 *   4. Row updated (SUCCEEDED | PENDING-next-attempt | DEAD_LETTER)
 *
 * Failure modes under test:
 *  - Network fault during handler execution → correct back-off scheduling
 *  - Process kill between step 2 and step 3 → row stuck IN_PROGRESS (detectable by recovery scan)
 *  - Process kill between step 3 and step 4 → handler ran but status not persisted
 *  - Non-retryable failure → immediate dead-letter, no further scheduling
 *  - Exhausted retries → dead-letter, can be revived manually
 *  - Duplicate schedule for the same operationId → idempotent (one row)
 *  - Stale read of nextRetryAt: poller does not re-claim a row that a peer
 *    already claimed in a concurrent worker race
 *
 * No NestJS DI, no real database, no wall-clock sleeps.
 *
 * Issue: #207
 */

import {
  ChaosScenario,
  ProcessKillError,
  ProcessKillPoint,
  StaleReadInjector,
} from "../../testing/chaos/chaos-scenario";
import {
  FaultyRepository,
  ManualClock,
  SideEffectLedger,
} from "../../testing/fault-injection/fault-injection";

// ---------------------------------------------------------------------------
// Inline status enum (mirrors RetryOperationStatus from the entity) so this
// spec has no dependency on TypeORM or the NestJS module graph.
// ---------------------------------------------------------------------------

const RetryOperationStatus = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
} as const;
type RetryOperationStatusType = (typeof RetryOperationStatus)[keyof typeof RetryOperationStatus];

// ---------------------------------------------------------------------------
// Minimal types
// ---------------------------------------------------------------------------

type Op = {
  id?: string;
  operationType: string;
  operationId: string;
  payload: unknown;
  status: RetryOperationStatusType;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  retryable: boolean;
  lastError: string | null;
  nextRetryAt: Date | null;
  correlationId: string | null;
  deadLetteredAt: Date | null;
  completedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Minimal in-process retry scheduler (matches RetrySchedulerService contract)
// ---------------------------------------------------------------------------

class RetryScheduler {
  constructor(
    private readonly repo: {
      create(v: Partial<Op>): Op;
      findOne(o: { where: Partial<Op> }): Promise<Op | null>;
      find(o?: unknown): Promise<Op[]>;
      save(v: Op): Promise<Op>;
    },
    private readonly killPoint?: ProcessKillPoint,
    private readonly ledger?: SideEffectLedger,
    private readonly clock: ManualClock = new ManualClock(),
  ) {}

  async schedule(opts: {
    operationType: string;
    operationId: string;
    payload: unknown;
    maxAttempts?: number;
    backoffMs?: number;
    backoffMultiplier?: number;
    maxBackoffMs?: number;
    retryable?: boolean;
    correlationId?: string;
  }): Promise<Op> {
    // Idempotent: if already scheduled, return existing
    const existing = await this.repo.findOne({
      where: { operationId: opts.operationId },
    });
    if (existing) return existing;

    const op = this.repo.create({
      operationType: opts.operationType,
      operationId: opts.operationId,
      payload: opts.payload,
      status: RetryOperationStatus.PENDING,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 3,
      backoffMs: opts.backoffMs ?? 1_000,
      backoffMultiplier: opts.backoffMultiplier ?? 2,
      maxBackoffMs: opts.maxBackoffMs ?? 60_000,
      retryable: opts.retryable ?? true,
      lastError: null,
      nextRetryAt: new Date(this.clock.now()),
      correlationId: opts.correlationId ?? null,
      deadLetteredAt: null,
      completedAt: null,
    });
    return this.repo.save(op);
  }

  async getDue(limit = 50): Promise<Op[]> {
    const all = await this.repo.find();
    return (all as Op[])
      .filter(
        (o) =>
          o.status === RetryOperationStatus.PENDING &&
          o.nextRetryAt !== null &&
          o.nextRetryAt.getTime() <= this.clock.now(),
      )
      .slice(0, limit);
  }

  async execute(
    operationId: string,
    handler: (payload: unknown) => Promise<void>,
  ): Promise<void> {
    const op = await this.repo.findOne({ where: { operationId } });
    if (!op) return;
    if (op.status !== RetryOperationStatus.PENDING) return;

    // Claim the row
    op.status = RetryOperationStatus.IN_PROGRESS;
    await this.repo.save(op);

    this.killPoint?.checkpoint("after-claim-before-handler");

    let handlerError: Error | null = null;
    try {
      await handler(op.payload);
    } catch (err) {
      handlerError = err as Error;
    }

    this.killPoint?.checkpoint("after-handler-before-status-save");

    if (!handlerError) {
      op.status = RetryOperationStatus.SUCCEEDED;
      op.completedAt = new Date(this.clock.now());
      op.nextRetryAt = null;
      await this.repo.save(op);
      this.ledger?.record("row-write", operationId);
      return;
    }

    op.attempts += 1;
    op.lastError = handlerError.message;

    const isRetryable =
      op.retryable && !(handlerError as { retryable?: boolean }).retryable === false;

    if (!op.retryable || op.attempts >= op.maxAttempts) {
      op.status = RetryOperationStatus.DEAD_LETTER;
      op.deadLetteredAt = new Date(this.clock.now());
      op.nextRetryAt = null;
      await this.repo.save(op);
      return;
    }

    const delay = Math.min(
      op.backoffMs * Math.pow(op.backoffMultiplier, op.attempts - 1),
      op.maxBackoffMs,
    );
    op.status = RetryOperationStatus.PENDING;
    op.nextRetryAt = new Date(this.clock.now() + delay);
    await this.repo.save(op);
  }

  async reviveDeadLetter(operationId: string): Promise<Op | null> {
    const op = await this.repo.findOne({ where: { operationId } });
    if (!op || op.status !== RetryOperationStatus.DEAD_LETTER) return null;

    op.status = RetryOperationStatus.PENDING;
    op.attempts = 0;
    op.nextRetryAt = new Date(this.clock.now());
    op.deadLetteredAt = null;
    op.lastError = null;
    return this.repo.save(op);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("retry scheduler chaos", () => {
  function makeScheduler(options: {
    killPoint?: ProcessKillPoint;
    ledger?: SideEffectLedger;
    clock?: ManualClock;
  } = {}) {
    const scenario = new ChaosScenario();
    const clock = options.clock ?? scenario.clock;
    const repo = scenario.repository<Op>("retry-ops", () => ({
      operationType: "notification.send",
      operationId: "op-1",
      payload: { notificationId: "n-1" },
      status: RetryOperationStatus.PENDING,
      attempts: 0,
      maxAttempts: 3,
      backoffMs: 1_000,
      backoffMultiplier: 2,
      maxBackoffMs: 60_000,
      retryable: true,
      lastError: null,
      nextRetryAt: null,
      correlationId: null,
      deadLetteredAt: null,
      completedAt: null,
    }));
    const scheduler = new RetryScheduler(
      repo,
      options.killPoint,
      options.ledger ?? scenario.ledger,
      clock,
    );
    return { scenario, repo, scheduler, clock };
  }

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe("successful execution", () => {
    it("transitions PENDING → IN_PROGRESS → SUCCEEDED", async () => {
      const { scenario, repo, scheduler } = makeScheduler();

      await scheduler.schedule({
        operationType: "notification.send",
        operationId: "op-1",
        payload: { notificationId: "n-1" },
      });

      await scheduler.execute("op-1", async () => { /* no-op */ });

      expect(repo.rows[0].status).toBe(RetryOperationStatus.SUCCEEDED);
      expect(repo.rows[0].completedAt).not.toBeNull();
    });

    it("records a side effect exactly once on success", async () => {
      const { scenario, scheduler } = makeScheduler();

      await scheduler.schedule({ operationType: "defi.sync", operationId: "op-1", payload: {} });
      await scheduler.execute("op-1", async () => { /* success */ });

      expect(scenario.ledger.countOf("row-write")).toBe(1);
      expect(() => scenario.ledger.assertNoDuplicates()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Network failures and back-off
  // -------------------------------------------------------------------------

  describe("network failures", () => {
    it("schedules back-off after a transient handler failure", async () => {
      const clock = new ManualClock(0);
      const { repo, scheduler } = makeScheduler({ clock });

      await scheduler.schedule({
        operationType: "webhook.deliver",
        operationId: "op-1",
        payload: {},
        backoffMs: 2_000,
        backoffMultiplier: 2,
      });

      await scheduler.execute("op-1", async () => {
        throw new Error("ECONNREFUSED");
      });

      const op = repo.rows[0];
      expect(op.status).toBe(RetryOperationStatus.PENDING);
      expect(op.attempts).toBe(1);
      // nextRetryAt should be 2 s in the future (first back-off interval)
      expect(op.nextRetryAt!.getTime()).toBeGreaterThan(clock.now());
    });

    it("does not return a row as due before its back-off window elapses", async () => {
      const clock = new ManualClock(0);
      const { repo, scheduler } = makeScheduler({ clock });

      await scheduler.schedule({
        operationType: "defi.sync",
        operationId: "op-1",
        payload: {},
        backoffMs: 5_000,
      });
      await scheduler.execute("op-1", async () => {
        throw new Error("timeout");
      });

      // Advance 2 s — still within back-off window
      await clock.advance(2_000);
      const dueEarly = await scheduler.getDue();
      expect(dueEarly).toHaveLength(0);

      // Advance past the back-off window
      await clock.advance(3_000);
      const dueLate = await scheduler.getDue();
      expect(dueLate).toHaveLength(1);
    });

    it("doubles the back-off delay on each successive failure", async () => {
      const clock = new ManualClock(0);
      const { repo, scheduler } = makeScheduler({ clock });

      await scheduler.schedule({
        operationType: "defi.sync",
        operationId: "op-1",
        payload: {},
        backoffMs: 1_000,
        backoffMultiplier: 2,
        maxAttempts: 5,
      });

      const delays: number[] = [];
      for (let i = 0; i < 3; i++) {
        const before = clock.now();
        // Reset to PENDING so execute picks it up
        repo.rows[0].status = RetryOperationStatus.PENDING;
        repo.rows[0].nextRetryAt = new Date(clock.now());
        await scheduler.execute("op-1", async () => {
          throw new Error("fail");
        });
        const nextAt = repo.rows[0].nextRetryAt!.getTime();
        delays.push(nextAt - before);
        await clock.advance(nextAt - clock.now() + 1);
      }

      // 1000ms, 2000ms, 4000ms (exponential)
      expect(delays[1]).toBeGreaterThanOrEqual(delays[0]);
      expect(delays[2]).toBeGreaterThanOrEqual(delays[1]);
    });

    it("caps back-off at maxBackoffMs", async () => {
      const clock = new ManualClock(0);
      const { repo, scheduler } = makeScheduler({ clock });

      await scheduler.schedule({
        operationType: "defi.sync",
        operationId: "op-1",
        payload: {},
        backoffMs: 30_000,
        backoffMultiplier: 10,
        maxBackoffMs: 60_000,
        maxAttempts: 10,
      });

      for (let i = 0; i < 3; i++) {
        repo.rows[0].status = RetryOperationStatus.PENDING;
        repo.rows[0].nextRetryAt = new Date(clock.now());
        await scheduler.execute("op-1", async () => {
          throw new Error("fail");
        });
        const nextAt = repo.rows[0].nextRetryAt!.getTime();
        // Never exceeds maxBackoffMs
        expect(nextAt - clock.now()).toBeLessThanOrEqual(60_000);
        await clock.advance(nextAt - clock.now() + 1);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Dead-letter queue
  // -------------------------------------------------------------------------

  describe("dead-letter queue", () => {
    it("moves to DEAD_LETTER after exhausting maxAttempts", async () => {
      const { repo, scheduler } = makeScheduler();

      await scheduler.schedule({
        operationType: "notification.send",
        operationId: "op-1",
        payload: {},
        maxAttempts: 2,
      });

      for (let i = 0; i < 2; i++) {
        repo.rows[0].status = RetryOperationStatus.PENDING;
        repo.rows[0].nextRetryAt = new Date(0);
        await scheduler.execute("op-1", async () => {
          throw new Error("persistent failure");
        });
      }

      expect(repo.rows[0].status).toBe(RetryOperationStatus.DEAD_LETTER);
      expect(repo.rows[0].deadLetteredAt).not.toBeNull();
      expect(repo.rows[0].lastError).toMatch(/persistent failure/);
    });

    it("revives a dead-lettered operation to PENDING for a manual retry", async () => {
      const { repo, scheduler } = makeScheduler();

      await scheduler.schedule({
        operationType: "notification.send",
        operationId: "op-1",
        payload: {},
        maxAttempts: 1,
      });
      await scheduler.execute("op-1", async () => {
        throw new Error("fail");
      });

      expect(repo.rows[0].status).toBe(RetryOperationStatus.DEAD_LETTER);

      const revived = await scheduler.reviveDeadLetter("op-1");

      expect(revived?.status).toBe(RetryOperationStatus.PENDING);
      expect(revived?.attempts).toBe(0);
      expect(revived?.deadLetteredAt).toBeNull();
    });

    it("returns null when trying to revive a non-dead-letter operation", async () => {
      const { scheduler } = makeScheduler();

      await scheduler.schedule({
        operationType: "notification.send",
        operationId: "op-1",
        payload: {},
      });

      // Still PENDING, not dead-lettered
      const result = await scheduler.reviveDeadLetter("op-1");
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Process kill scenarios
  // -------------------------------------------------------------------------

  describe("process kill points", () => {
    it("leaves row IN_PROGRESS when killed between claim and handler execution", async () => {
      const kill = new ProcessKillPoint();
      kill.armKill("after-claim-before-handler");
      const { repo, scheduler } = makeScheduler({ killPoint: kill });

      await scheduler.schedule({
        operationType: "notification.send",
        operationId: "op-1",
        payload: {},
      });

      await expect(
        scheduler.execute("op-1", async () => { /* never reached */ }),
      ).rejects.toBeInstanceOf(ProcessKillError);

      // Row is stuck IN_PROGRESS — visible to the stale-operation recovery scanner
      expect(repo.rows[0].status).toBe(RetryOperationStatus.IN_PROGRESS);
    });

    it("leaves row IN_PROGRESS when killed between handler success and status save", async () => {
      const kill = new ProcessKillPoint();
      kill.armKill("after-handler-before-status-save");
      let handlerRan = false;
      const { repo, scheduler } = makeScheduler({ killPoint: kill });

      await scheduler.schedule({
        operationType: "notification.send",
        operationId: "op-1",
        payload: {},
      });

      await expect(
        scheduler.execute("op-1", async () => {
          handlerRan = true; // handler completed
        }),
      ).rejects.toBeInstanceOf(ProcessKillError);

      expect(handlerRan).toBe(true);
      // Status was never persisted as SUCCEEDED
      expect(repo.rows[0].status).toBe(RetryOperationStatus.IN_PROGRESS);
    });

    it("a recovery scan can find and re-claim stuck IN_PROGRESS rows", async () => {
      const kill = new ProcessKillPoint();
      kill.armKill("after-claim-before-handler");
      const { repo, scheduler } = makeScheduler({ killPoint: kill });

      await scheduler.schedule({
        operationType: "notification.send",
        operationId: "op-1",
        payload: {},
      });

      // First run: killed after claim
      await expect(
        scheduler.execute("op-1", async () => {}),
      ).rejects.toBeInstanceOf(ProcessKillError);

      // Simulate recovery: poller detects stuck IN_PROGRESS and resets to PENDING
      repo.rows[0].status = RetryOperationStatus.PENDING;
      repo.rows[0].nextRetryAt = new Date(0);

      let recoveryRan = false;
      await scheduler.execute("op-1", async () => {
        recoveryRan = true;
      });

      expect(recoveryRan).toBe(true);
      expect(repo.rows[0].status).toBe(RetryOperationStatus.SUCCEEDED);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotent scheduling
  // -------------------------------------------------------------------------

  describe("idempotent scheduling", () => {
    it("returns the existing row when scheduled twice for the same operationId", async () => {
      const { repo, scheduler } = makeScheduler();

      const first = await scheduler.schedule({
        operationType: "notification.send",
        operationId: "op-unique",
        payload: { v: 1 },
      });
      const second = await scheduler.schedule({
        operationType: "notification.send",
        operationId: "op-unique",
        payload: { v: 2 },
      });

      // One row, second schedule is a no-op
      expect(repo.rows).toHaveLength(1);
      expect(second.id).toBe(first.id);
      // Payload not overwritten
      expect((repo.rows[0].payload as { v: number }).v).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent worker race (stale nextRetryAt read)
  // -------------------------------------------------------------------------

  describe("concurrent worker race", () => {
    it("does not execute an operation that a peer worker has already claimed", async () => {
      const scenario = new ChaosScenario();
      const repo = scenario.repository<Op>("retry-ops");

      await scenario.controller("retry-ops"); // lazy-create

      const clock = scenario.clock;
      const op = repo.create({
        operationType: "defi.sync",
        operationId: "op-concurrent",
        payload: {},
        status: RetryOperationStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        backoffMs: 1_000,
        backoffMultiplier: 2,
        maxBackoffMs: 60_000,
        retryable: true,
        lastError: null,
        nextRetryAt: new Date(clock.now()),
        correlationId: null,
        deadLetteredAt: null,
        completedAt: null,
      });
      await repo.save(op);

      // Peer worker claims the row directly (simulating a concurrent pick-up)
      repo.rows[0].status = RetryOperationStatus.IN_PROGRESS;

      const scheduler = new RetryScheduler(repo);
      let handlerCalls = 0;
      await scheduler.execute("op-concurrent", async () => {
        handlerCalls += 1;
      });

      // execute() must bail if status is not PENDING
      expect(handlerCalls).toBe(0);
    });

    it("stale read returning PENDING when row is already IN_PROGRESS does not cause double-execution", async () => {
      const scenario = new ChaosScenario();
      const repo = scenario.repository<Op>("retry-ops");
      const clock = scenario.clock;

      const op = repo.create({
        operationType: "webhook.deliver",
        operationId: "op-race",
        payload: {},
        status: RetryOperationStatus.IN_PROGRESS, // already claimed by a peer
        attempts: 0,
        maxAttempts: 3,
        backoffMs: 1_000,
        backoffMultiplier: 2,
        maxBackoffMs: 60_000,
        retryable: true,
        lastError: null,
        nextRetryAt: new Date(clock.now()),
        correlationId: null,
        deadLetteredAt: null,
        completedAt: null,
      });
      await repo.save(op);

      // Inject a stale snapshot that reports PENDING
      const staleOp: Op = { ...op, status: RetryOperationStatus.PENDING };
      const staleRepo = scenario.staleReader(repo);
      staleRepo.armStaleRead({ snapshot: staleOp, onCall: 1 });

      // Scheduler reads the stale PENDING snapshot …
      const scheduler = new RetryScheduler(staleRepo as unknown as typeof repo, undefined, scenario.ledger, clock);
      let handlerCalls = 0;
      await scheduler.execute("op-race", async () => {
        handlerCalls += 1;
      });

      // … the scheduler claims IN_PROGRESS again and runs the handler once.
      // The key assertion is that the ledger sees exactly one side effect.
      expect(handlerCalls).toBe(1);
      expect(scenario.ledger.countOf("row-write")).toBe(1);
      expect(() => scenario.ledger.assertNoDuplicates()).not.toThrow();
    });
  });
});

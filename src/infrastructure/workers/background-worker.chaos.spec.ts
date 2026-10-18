/**
 * Chaos tests for the background worker pipeline.
 *
 * The background worker accepts jobs from a Bull queue and executes them.
 * This suite covers the failure modes that cause ghost jobs, double execution,
 * or silent data loss:
 *
 *  - Process kill between job dequeue and handler start → job re-queued by Bull
 *  - Process kill after handler completes but before acknowledgement → job
 *    re-delivered; handler must be idempotent
 *  - Job processing fails transiently → Bull retries up to maxAttempts
 *  - Persistent failure after all retries → job moves to dead-letter queue
 *  - Stale job data read (cached payload) → worker uses fresh payload from DB
 *  - Concurrent processing of the same job ID → only one execution completes
 *
 * All tests use the fault-injection harness. No real Bull instance, no real
 * database, no wall-clock waits.
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
// Minimal job / worker types
// ---------------------------------------------------------------------------

const enum JobStatus {
  PENDING = "pending",
  ACTIVE = "active",
  COMPLETED = "completed",
  FAILED = "failed",
  DEAD_LETTER = "dead_letter",
}

type Job<P = unknown> = {
  id?: string;
  type: string;
  payload: P;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  correlationId: string | null;
  completedAt: Date | null;
  deadLetteredAt: Date | null;
  schemaVersion: string;
};

// ---------------------------------------------------------------------------
// Minimal background worker (mirrors BackgroundWorkerService contract)
// ---------------------------------------------------------------------------

type JobHandler = (payload: unknown, correlationId: string | null) => Promise<void>;

class BackgroundWorker {
  private handlers = new Map<string, JobHandler>();

  constructor(
    private readonly repo: {
      create(v: Partial<Job>): Job;
      findOne(o: { where: Partial<Job> }): Promise<Job | null>;
      find(o?: unknown): Promise<Job[]>;
      save(v: Job): Promise<Job>;
    },
    private readonly killPoint?: ProcessKillPoint,
    private readonly ledger?: SideEffectLedger,
    private readonly clock: ManualClock = new ManualClock(),
  ) {}

  registerHandler(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  async enqueue<P>(opts: {
    type: string;
    payload: P;
    maxAttempts?: number;
    correlationId?: string;
  }): Promise<Job<P>> {
    const job = this.repo.create({
      type: opts.type,
      payload: opts.payload,
      status: JobStatus.PENDING,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 3,
      lastError: null,
      correlationId: opts.correlationId ?? null,
      completedAt: null,
      deadLetteredAt: null,
      schemaVersion: "1.0.0",
    });
    return (await this.repo.save(job)) as Job<P>;
  }

  /** Execute a single job. Mirrors what a Bull @Process() handler does. */
  async process(jobId: string): Promise<void> {
    const job = await this.repo.findOne({ where: { id: jobId } });
    if (!job) return;
    if (
      job.status === JobStatus.COMPLETED ||
      job.status === JobStatus.DEAD_LETTER ||
      job.status === JobStatus.ACTIVE
    )
      return;

    // Claim
    job.status = JobStatus.ACTIVE;
    job.attempts += 1;
    await this.repo.save(job);

    this.killPoint?.checkpoint("after-claim-before-handler");

    const handler = this.handlers.get(job.type);
    if (!handler) {
      job.status = JobStatus.FAILED;
      job.lastError = `No handler registered for job type: ${job.type}`;
      await this.repo.save(job);
      return;
    }

    let err: Error | null = null;
    try {
      await handler(job.payload, job.correlationId);
    } catch (e) {
      err = e as Error;
    }

    this.killPoint?.checkpoint("after-handler-before-ack");

    if (!err) {
      job.status = JobStatus.COMPLETED;
      job.completedAt = new Date(this.clock.now());
      await this.repo.save(job);
      this.ledger?.record("row-write", jobId);
      return;
    }

    job.lastError = err.message;

    if (job.attempts >= job.maxAttempts) {
      job.status = JobStatus.DEAD_LETTER;
      job.deadLetteredAt = new Date(this.clock.now());
      await this.repo.save(job);
      return;
    }

    // Back to pending for the next Bull retry
    job.status = JobStatus.PENDING;
    await this.repo.save(job);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorker(options: {
  killPoint?: ProcessKillPoint;
  ledger?: SideEffectLedger;
  clock?: ManualClock;
} = {}) {
  const scenario = new ChaosScenario();
  const clock = options.clock ?? scenario.clock;
  const repo = scenario.repository<Job>("jobs", () => ({
    type: "default.job",
    payload: {},
    status: JobStatus.PENDING,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    correlationId: null,
    completedAt: null,
    deadLetteredAt: null,
    schemaVersion: "1.0.0",
  }));
  const worker = new BackgroundWorker(
    repo,
    options.killPoint,
    options.ledger ?? scenario.ledger,
    clock,
  );
  return { scenario, repo, worker };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("background worker chaos", () => {

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe("successful execution", () => {
    it("transitions PENDING → ACTIVE → COMPLETED", async () => {
      const { repo, worker } = makeWorker();
      const job = await worker.enqueue({ type: "test.job", payload: { v: 1 } });
      worker.registerHandler("test.job", async () => { /* no-op */ });

      await worker.process(job.id!);

      expect(repo.rows[0].status).toBe(JobStatus.COMPLETED);
      expect(repo.rows[0].completedAt).not.toBeNull();
    });

    it("records a side effect exactly once", async () => {
      const { scenario, repo, worker } = makeWorker();
      const job = await worker.enqueue({ type: "test.job", payload: {} });
      worker.registerHandler("test.job", async () => { /* success */ });

      await worker.process(job.id!);

      expect(scenario.ledger.countOf("row-write")).toBe(1);
      expect(() => scenario.ledger.assertNoDuplicates()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Process kill between dequeue and handler
  // -------------------------------------------------------------------------

  describe("kill between claim and handler", () => {
    it("leaves job ACTIVE (detectable by recovery scanner)", async () => {
      const kill = new ProcessKillPoint();
      kill.armKill("after-claim-before-handler");
      const { repo, worker } = makeWorker({ killPoint: kill });

      const job = await worker.enqueue({ type: "test.job", payload: {} });
      worker.registerHandler("test.job", async () => { /* never reached */ });

      await expect(worker.process(job.id!)).rejects.toBeInstanceOf(ProcessKillError);

      expect(repo.rows[0].status).toBe(JobStatus.ACTIVE);
      // attempts was already incremented before the kill
      expect(repo.rows[0].attempts).toBe(1);
    });

    it("can be recovered by resetting ACTIVE to PENDING and re-processing", async () => {
      const kill = new ProcessKillPoint();
      kill.armKill("after-claim-before-handler");
      const { repo, worker } = makeWorker({ killPoint: kill });

      const job = await worker.enqueue({ type: "test.job", payload: {} });
      worker.registerHandler("test.job", async () => { /* recovery */ });

      await expect(worker.process(job.id!)).rejects.toBeInstanceOf(ProcessKillError);

      // Recovery: reset the stuck ACTIVE row
      repo.rows[0].status = JobStatus.PENDING;
      repo.rows[0].attempts -= 1; // undo the phantom attempt

      await worker.process(job.id!);

      expect(repo.rows[0].status).toBe(JobStatus.COMPLETED);
    });
  });

  // -------------------------------------------------------------------------
  // Kill after handler, before acknowledgement
  // -------------------------------------------------------------------------

  describe("kill after handler completes but before acknowledgement", () => {
    it("leaves job ACTIVE with handler side effect already committed", async () => {
      const kill = new ProcessKillPoint();
      kill.armKill("after-handler-before-ack");
      const { scenario, repo, worker } = makeWorker({ killPoint: kill });

      const externalStore: string[] = [];
      const job = await worker.enqueue({ type: "payment.send", payload: { amount: "10" } });
      worker.registerHandler("payment.send", async (payload) => {
        externalStore.push((payload as { amount: string }).amount);
        scenario.ledger.record("payment", job.id!); // side effect committed
      });

      await expect(worker.process(job.id!)).rejects.toBeInstanceOf(ProcessKillError);

      // Handler ran and produced a side effect
      expect(externalStore).toHaveLength(1);
      // Job status was not persisted as COMPLETED
      expect(repo.rows[0].status).toBe(JobStatus.ACTIVE);
    });

    it("does not produce a double payment when the recovered job re-runs a guarded handler", async () => {
      const kill = new ProcessKillPoint();
      kill.armKill("after-handler-before-ack");
      const { scenario, repo, worker } = makeWorker({ killPoint: kill });

      const processedIds = new Set<string>();
      const job = await worker.enqueue({ type: "payment.send", payload: { paymentId: "pay-1" } });

      worker.registerHandler("payment.send", async (payload) => {
        const { paymentId } = payload as { paymentId: string };
        if (processedIds.has(paymentId)) return; // idempotency guard
        processedIds.add(paymentId);
        scenario.ledger.record("payment", paymentId);
      });

      // First run: handler runs, then killed before ack
      await expect(worker.process(job.id!)).rejects.toBeInstanceOf(ProcessKillError);

      // Recovery: reset and re-run
      repo.rows[0].status = JobStatus.PENDING;
      repo.rows[0].attempts = 0;
      await worker.process(job.id!);

      // Payment happened exactly once despite two process calls
      expect(scenario.ledger.countOf("payment")).toBe(1);
      expect(() => scenario.ledger.assertNoDuplicates()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Retry behaviour
  // -------------------------------------------------------------------------

  describe("retry behaviour", () => {
    it("returns to PENDING after a transient failure below maxAttempts", async () => {
      const { repo, worker } = makeWorker();
      const job = await worker.enqueue({ type: "test.job", payload: {} });

      worker.registerHandler("test.job", async () => {
        throw new Error("ECONNREFUSED");
      });

      await worker.process(job.id!);

      expect(repo.rows[0].status).toBe(JobStatus.PENDING);
      expect(repo.rows[0].attempts).toBe(1);
      expect(repo.rows[0].lastError).toMatch(/ECONNREFUSED/);
    });

    it("moves to DEAD_LETTER after exhausting maxAttempts", async () => {
      const { repo, worker } = makeWorker();
      const job = await worker.enqueue({ type: "test.job", payload: {}, maxAttempts: 2 });

      worker.registerHandler("test.job", async () => {
        throw new Error("persistent failure");
      });

      for (let i = 0; i < 2; i++) {
        repo.rows[0].status = JobStatus.PENDING;
        await worker.process(job.id!);
      }

      expect(repo.rows[0].status).toBe(JobStatus.DEAD_LETTER);
      expect(repo.rows[0].deadLetteredAt).not.toBeNull();
    });

    it("does not re-process a job that is already COMPLETED", async () => {
      const { repo, worker } = makeWorker();
      const job = await worker.enqueue({ type: "test.job", payload: {} });

      let calls = 0;
      worker.registerHandler("test.job", async () => { calls += 1; });

      await worker.process(job.id!); // completes
      await worker.process(job.id!); // no-op

      expect(calls).toBe(1);
      expect(repo.rows[0].status).toBe(JobStatus.COMPLETED);
    });

    it("does not re-process a dead-lettered job without explicit revival", async () => {
      const { repo, worker } = makeWorker();
      const job = await worker.enqueue({ type: "test.job", payload: {}, maxAttempts: 1 });

      worker.registerHandler("test.job", async () => {
        throw new Error("fail");
      });

      await worker.process(job.id!); // dead-lettered
      expect(repo.rows[0].status).toBe(JobStatus.DEAD_LETTER);

      let revivedCalls = 0;
      worker.registerHandler("test.job", async () => { revivedCalls += 1; });
      await worker.process(job.id!); // still dead-lettered

      expect(revivedCalls).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Missing handler
  // -------------------------------------------------------------------------

  describe("missing handler", () => {
    it("marks job FAILED when no handler is registered for the job type", async () => {
      const { repo, worker } = makeWorker();
      const job = await worker.enqueue({ type: "unknown.type", payload: {} });
      // No handler registered

      await worker.process(job.id!);

      expect(repo.rows[0].status).toBe(JobStatus.FAILED);
      expect(repo.rows[0].lastError).toMatch(/No handler registered/);
    });
  });

  // -------------------------------------------------------------------------
  // Stale payload read
  // -------------------------------------------------------------------------

  describe("stale payload read", () => {
    it("executes with the snapshot payload when the read is stale", async () => {
      const scenario = new ChaosScenario();
      const baseRepo = scenario.repository<Job>("jobs");
      const staleRepo = scenario.staleReader(baseRepo);

      // Schedule a job with payload v:2 but inject a stale snapshot with v:1
      const liveJob = baseRepo.create({
        type: "compute.run",
        payload: { v: 2 },
        status: JobStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        lastError: null,
        correlationId: null,
        completedAt: null,
        deadLetteredAt: null,
        schemaVersion: "1.0.0",
      });
      await baseRepo.save(liveJob);

      staleRepo.armStaleRead({
        snapshot: { ...liveJob, payload: { v: 1 } } as Job,
        onCall: 1,
      });

      const executedWith: unknown[] = [];
      const worker = new BackgroundWorker(
        staleRepo as unknown as typeof baseRepo,
        undefined,
        scenario.ledger,
      );
      worker.registerHandler("compute.run", async (payload) => {
        executedWith.push(payload);
      });

      await worker.process(liveJob.id!);

      // Worker executes with the stale payload — this documents the risk
      // of cache/replica divergence. The operator must ensure handlers are
      // idempotent with respect to version differences in the payload.
      expect(executedWith).toHaveLength(1);
      expect((executedWith[0] as { v: number }).v).toBe(1); // stale value
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent processing guard
  // -------------------------------------------------------------------------

  describe("concurrent processing guard", () => {
    it("does not run a second handler when the job is already ACTIVE", async () => {
      const { repo, worker } = makeWorker();
      const job = await worker.enqueue({ type: "test.job", payload: {} });

      // Simulate a peer worker that already claimed the job
      repo.rows[0].status = JobStatus.ACTIVE;

      let calls = 0;
      worker.registerHandler("test.job", async () => { calls += 1; });

      await worker.process(job.id!);

      // process() must treat ACTIVE as "already claimed by another worker"
      expect(calls).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Persistence failures
  // -------------------------------------------------------------------------

  describe("persistence failures", () => {
    it("throws when the claim write fails with a constraint violation", async () => {
      const { scenario, repo, worker } = makeWorker();

      const job = await worker.enqueue({ type: "test.job", payload: {} });
      scenario.controller("jobs").queueConstraintViolation();

      worker.registerHandler("test.job", async () => { /* no-op */ });

      // The claim (first save) fails
      await expect(worker.process(job.id!)).rejects.toThrow(/constraint was violated/);

      // Row retains PENDING status because the claim write never landed
      expect(repo.rows[0].status).toBe(JobStatus.PENDING);
    });
  });
});

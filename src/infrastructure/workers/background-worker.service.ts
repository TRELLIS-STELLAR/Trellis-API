import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import { JobStatus, WorkerJob, RetryPolicy, DEFAULT_RETRY_POLICY, WorkerJobPayload, JobPriority, TERMINAL_STATUSES, JobCleanupFn } from "./worker.interface";
import {
  withTraceContext,
  runTracedJob,
  extractJobContext,
} from "src/observability/async-job-tracing";
import {
  JOB_CORRELATION_FIELD,
  getCorrelationId,
  normalizeCorrelationId,
} from "src/common/correlation/correlation-context";
import { sanitizeErrorMessage } from "src/logging/sanitize.util";
import { ConcurrencyLimiterService } from "./concurrency-limiter.service";

@Injectable()
export class BackgroundWorkerService implements OnModuleInit {
  private readonly logger = new Logger(BackgroundWorkerService.name);
  private readonly jobStore = new Map<string, WorkerJob>();
  private readonly policies = new Map<string, RetryPolicy>();
  private readonly cleanupHandlers = new Map<string, JobCleanupFn>();

  constructor(
    @InjectQueue("background-jobs") private readonly queue: Queue,
    private readonly concurrencyLimiter: ConcurrencyLimiterService,
  ) {
    // Register default policies eagerly so they exist even when the module
    // is instantiated outside the Nest lifecycle (e.g. in unit tests).
    this.registerDefaultPolicies();
  }

  onModuleInit() {
    this.registerDefaultPolicies();
    this.setupEventListeners();
  }

  private registerDefaultPolicies() {
    const defaults: Record<string, Partial<RetryPolicy>> = {
      "webhook.delivery": { maxAttempts: 5, backoffMs: 2000, backoffMultiplier: 2, maxBackoffMs: 60000 },
      "email.send": { maxAttempts: 3, backoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 30000 },
      "data.export": { maxAttempts: 2, backoffMs: 5000, maxBackoffMs: 60000 },
      "reconciliation.sync": { maxAttempts: 4, backoffMs: 3000, backoffMultiplier: 1.5, maxBackoffMs: 120000 },
    };

    for (const [type, policy] of Object.entries(defaults)) {
      this.policies.set(type, { ...DEFAULT_RETRY_POLICY, ...policy });
    }
  }

  private setupEventListeners() {
    this.queue.on("active", (job) => {
      // Track when job starts processing (no concurrency slot acquired here,
      // that happens at enqueue time)
      this.updateJobStatus(job.id.toString(), JobStatus.ACTIVE);
    });

    this.queue.on("completed", (job) => {
      this.updateJobStatus(job.id.toString(), JobStatus.COMPLETED, { result: job.returnvalue });
      this.concurrencyLimiter.release(job.id.toString());
      this.logger.log(`Job ${job.id} completed`);
    });

    this.queue.on("failed", (job, err) => {
      const workerJob = this.jobStore.get(job.id.toString());
      const attempts = job.attemptsMade;
      const maxAttempts = workerJob?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts;

      // job.error is served by the inspection endpoints, so it is redacted.
      const error = sanitizeErrorMessage(String(err?.message ?? err));
      const correlation = workerJob?.correlationId ? ` [correlationId=${workerJob.correlationId}]` : "";
      if (attempts >= maxAttempts) {
        this.updateJobStatus(job.id.toString(), JobStatus.DEAD_LETTER, { error });
        this.concurrencyLimiter.release(job.id.toString());
        this.logger.warn(`Job ${job.id} moved to dead-letter queue after ${attempts} attempts${correlation}`);
      } else {
        this.updateJobStatus(job.id.toString(), JobStatus.FAILED, { error });
        // Don't release on transient failure — job will retry
        this.logger.error(`Job ${job.id} failed (attempt ${attempts}/${maxAttempts}): ${error}${correlation}`);
      }
    });

    this.queue.on("progress", (job, progress) => {
      this.logger.debug(`Job ${job.id} progress: ${progress}%`);
    });
  }

  async enqueue<T>(payload: WorkerJobPayload): Promise<WorkerJob> {
    const type = payload.type;
    const policy = this.policies.get(type) || DEFAULT_RETRY_POLICY;
    const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date();
    // Explicit ID first, then the enqueuing request's ID (#270).
    const correlationId =
      normalizeCorrelationId(payload.correlationId) ?? getCorrelationId();

    const job: WorkerJob = {
      id,
      type,
      payload: payload.payload,
      priority: payload.priority || JobPriority.NORMAL,
      attempts: 0,
      maxAttempts: policy.maxAttempts,
      backoffMs: policy.backoffMs,
      delayMs: payload.delayMs,
      status: JobStatus.PENDING,
      createdAt: now,
      updatedAt: now,
      correlationId,
      schemaVersion: "1.0.0",
    };

    this.jobStore.set(id, job);

    // Acquire concurrency slot before enqueuing to Bull
    try {
      await this.concurrencyLimiter.acquire(id);
    } catch (err) {
      // Backpressure rejection — remove from jobStore and rethrow
      this.jobStore.delete(id);
      throw err;
    }

    const bullJob = await this.queue.add(
      type,
      // Stamp the active W3C trace context so the worker-side processing
      // span is parented to the originating HTTP request span.
      withTraceContext({
        ...payload.payload,
        _jobId: id,
        _schemaVersion: "1.0.0",
        ...(correlationId && { [JOB_CORRELATION_FIELD]: correlationId }),
      }),
      {
        jobId: id,
        priority: this.mapPriority(payload.priority || JobPriority.NORMAL),
        attempts: policy.maxAttempts,
        backoff: {
          type: "exponential",
          delay: policy.backoffMs,
        },
        delay: payload.delayMs || 0,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    );

    this.logger.log(`Enqueued job ${id} of type ${type}`);
    return job;
  }
  async getJob(id: string): Promise<WorkerJob | undefined> {
    return this.jobStore.get(id);
  }

  async listJobs(status?: JobStatus, limit = 50): Promise<WorkerJob[]> {
    let jobs = Array.from(this.jobStore.values());
    if (status) {
      jobs = jobs.filter((j) => j.status === status);
    }
    return jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }

  async retryJob(id: string): Promise<WorkerJob | null> {
    const job = this.jobStore.get(id);
    if (!job) return null;

    if (job.status !== JobStatus.FAILED && job.status !== JobStatus.DEAD_LETTER) {
      this.logger.warn(`Cannot retry job ${id}: status is ${job.status}`);
      return null;
    }

    const policy = this.policies.get(job.type) || DEFAULT_RETRY_POLICY;
    job.attempts = 0;
    job.status = JobStatus.PENDING;
    job.updatedAt = new Date();
    job.error = undefined;

    // Acquire concurrency slot before retrying
    try {
      await this.concurrencyLimiter.acquire(id);
    } catch (err) {
      this.logger.error(`Cannot retry job ${id}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    await this.queue.add(
      job.type,
      withTraceContext(
        {
          ...job.payload,
          _jobId: job.id,
          _schemaVersion: job.schemaVersion,
          _retry: true,
          // A manual retry keeps the ORIGINAL correlation ID, not the caller's.
          ...(job.correlationId && { [JOB_CORRELATION_FIELD]: job.correlationId }),
        },
        // Preserve the ORIGINAL request trace across retries.
        extractJobContext({ __trace: (job.payload as { __trace?: object })?.__trace }) as never,
      ),
      {
        jobId: job.id,
        priority: this.mapPriority(job.priority),
        attempts: policy.maxAttempts,
        backoff: { type: "exponential", delay: job.backoffMs },
        delay: 0,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    );

    this.updateJobStatus(id, JobStatus.ACTIVE);
    this.logger.log(`Retrying job ${id}`);
    return job;
  }

  /**
   * Register a cleanup function for a job type. The function is called once
   * after a job of that type transitions to CANCELLED, giving the handler a
   * chance to release locks, delete temp files, or emit compensating events.
   */
  registerCleanupHandler(type: string, fn: JobCleanupFn): void {
    this.cleanupHandlers.set(type, fn);
  }

  /**
   * Request cancellation of a pending or active job.
   *
   * - Pending / delayed jobs are removed from the Bull queue immediately and
   *   their status set to CANCELLED.
   * - Active jobs have `cancelRequested` set to true; the worker checks this
   *   flag between processing steps and cooperates by stopping early. The
   *   status becomes CANCELLED once the worker acknowledges.
   * - Terminal jobs (COMPLETED, DEAD_LETTER, CANCELLED) are left unchanged
   *   and false is returned.
   *
   * Returns true when the cancellation was accepted (status changed or flag
   * set), false when the job was not found or already in a terminal state.
   */
  async cancelJob(id: string): Promise<boolean> {
    const job = this.jobStore.get(id);
    if (!job || TERMINAL_STATUSES.has(job.status)) {
      return false;
    }

    if (job.status === JobStatus.ACTIVE) {
      // Signal the worker to stop cooperatively; status transitions when it
      // acknowledges (or when the Bull job is forcibly removed on timeout).
      job.cancelRequested = true;
      job.updatedAt = new Date();
      this.logger.log(`Cancel requested for active job ${id} (type=${job.type})`);
      return true;
    }

    // Pending / delayed: remove from queue and mark as cancelled now.
    try {
      const bullJob = await this.queue.getJob(job.id);
      if (bullJob) {
        await bullJob.remove();
      }
    } catch (err) {
      this.logger.warn(`Could not remove Bull job ${id} from queue: ${err instanceof Error ? err.message : String(err)}`);
    }

    job.status = JobStatus.CANCELLED;
    job.cancelledAt = new Date();
    job.updatedAt = new Date();
    job.error = "Cancelled by operator";
    this.logger.log(`Job ${id} (type=${job.type}) cancelled`);

    // Release concurrency slot
    this.concurrencyLimiter.release(id);

    await this.runCleanup(job);
    return true;
  }

  /**
   * Acknowledge a cooperative cancellation from within a worker. The worker
   * calls this after detecting `cancelRequested === true` and stopping its
   * own processing loop.
   */
  async acknowledgeCancel(id: string): Promise<void> {
    const job = this.jobStore.get(id);
    if (!job || !job.cancelRequested) return;
    job.status = JobStatus.CANCELLED;
    job.cancelledAt = new Date();
    job.updatedAt = new Date();
    job.error = "Cancelled by operator (cooperative)";
    this.logger.log(`Job ${id} (type=${job.type}) acknowledged cooperative cancellation`);
    
    // Release concurrency slot
    this.concurrencyLimiter.release(id);
    
    await this.runCleanup(job);
  }

  private async runCleanup(job: WorkerJob): Promise<void> {
    const handler = this.cleanupHandlers.get(job.type);
    if (!handler) return;
    try {
      await handler(job);
    } catch (err) {
      this.logger.error(
        `Cleanup handler for job ${job.id} (type=${job.type}) threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async getMetrics() {
    const jobs = Array.from(this.jobStore.values());
    const total = jobs.length;
    const completed = jobs.filter((j) => j.status === JobStatus.COMPLETED).length;
    const failed = jobs.filter((j) => j.status === JobStatus.FAILED).length;
    const deadLettered = jobs.filter((j) => j.status === JobStatus.DEAD_LETTER).length;
    const cancelled = jobs.filter((j) => j.status === JobStatus.CANCELLED).length;
    const pending = jobs.filter((j) => j.status === JobStatus.PENDING || j.status === JobStatus.ACTIVE).length;

    // Include concurrency metrics
    const concurrencyMetrics = this.concurrencyLimiter.getMetrics();

    return {
      total,
      completed,
      failed,
      deadLettered,
      cancelled,
      pending,
      successRate: total > 0 ? (completed / total) * 100 : 0,
      byType: jobs.reduce<Record<string, number>>((acc, j) => { acc[j.type] = (acc[j.type] || 0) + 1; return acc; }, {}),
      concurrency: concurrencyMetrics,
    };
  }

  private updateJobStatus(id: string, status: JobStatus, updates: Partial<WorkerJob> = {}) {
    const job = this.jobStore.get(id);
    if (!job) return;
    job.status = status;
    job.updatedAt = new Date();
    if (status === JobStatus.COMPLETED) job.completedAt = new Date();
    if (status === JobStatus.FAILED || status === JobStatus.DEAD_LETTER) job.failedAt = new Date();
    if (status === JobStatus.CANCELLED) job.cancelledAt = new Date();
    Object.assign(job, updates);
  }

  private mapPriority(priority: JobPriority): number {
    const map: Record<JobPriority, number> = {
      [JobPriority.LOW]: -10,
      [JobPriority.NORMAL]: 0,
      [JobPriority.HIGH]: 10,
      [JobPriority.CRITICAL]: 20,
    };
    return map[priority] || 0;
  }
}

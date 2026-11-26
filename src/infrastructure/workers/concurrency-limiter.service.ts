import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { JobStatus, WorkerJob } from "./worker.interface";

/**
 * Backpressure strategy applied when the concurrency limit is reached.
 */
export enum BackpressureStrategy {
  /** Reject new jobs immediately with an error. */
  REJECT = "reject",
  /** Queue jobs up to a maximum queue size, then reject. */
  QUEUE = "queue",
  /** Throttle by delaying the enqueue until a slot is available. */
  THROTTLE = "throttle",
}

export interface ConcurrencyConfig {
  /** Maximum number of jobs that can run concurrently. Default: 10. */
  maxConcurrent: number;
  /** Backpressure strategy when limit is reached. Default: QUEUE. */
  backpressureStrategy: BackpressureStrategy;
  /** Maximum number of jobs to queue when using QUEUE strategy. Default: 100. */
  maxQueueSize: number;
  /** Timeout in milliseconds for THROTTLE strategy. Default: 30000 (30s). */
  throttleTimeoutMs: number;
}

export const DEFAULT_CONCURRENCY_CONFIG: ConcurrencyConfig = {
  maxConcurrent: 10,
  backpressureStrategy: BackpressureStrategy.QUEUE,
  maxQueueSize: 100,
  throttleTimeoutMs: 30000,
};

/**
 * Bounded worker concurrency limiter with backpressure support (Issue #34).
 *
 * Tracks active jobs and enforces a configurable concurrency limit. When the
 * limit is reached, applies one of three backpressure strategies:
 * - REJECT: Immediately reject new jobs with an error
 * - QUEUE: Queue jobs in memory until a slot opens (up to maxQueueSize)
 * - THROTTLE: Block enqueue until a slot opens (with timeout)
 *
 * Emits events for monitoring:
 * - concurrency.limit.reached
 * - concurrency.limit.relieved
 * - concurrency.backpressure.applied
 * - concurrency.job.queued
 * - concurrency.job.dequeued
 * - concurrency.job.rejected
 */
@Injectable()
export class ConcurrencyLimiterService implements OnModuleInit {
  private readonly logger = new Logger(ConcurrencyLimiterService.name);
  private readonly activeJobs = new Map<string, WorkerJob>();
  private readonly waitQueue: Array<{
    jobId: string;
    enqueueTime: Date;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private config: ConcurrencyConfig = DEFAULT_CONCURRENCY_CONFIG;
  private limitReached = false;

  constructor(private readonly eventEmitter: EventEmitter2) {}

  onModuleInit() {
    this.logger.log(
      `ConcurrencyLimiter initialized: maxConcurrent=${this.config.maxConcurrent}, ` +
        `strategy=${this.config.backpressureStrategy}, maxQueueSize=${this.config.maxQueueSize}`
    );
  }

  /**
   * Update the concurrency configuration at runtime.
   */
  updateConfig(config: Partial<ConcurrencyConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.log(`Concurrency config updated: ${JSON.stringify(this.config)}`);
  }

  /**
   * Acquire a concurrency slot before enqueuing a job. Throws or blocks
   * based on the configured backpressure strategy.
   *
   * Returns true if the slot was acquired immediately, false if the job
   * was queued or throttled (caller should proceed after promise resolves).
   */
  async acquire(jobId: string): Promise<void> {
    const activeCount = this.activeJobs.size;

    // If under limit, acquire immediately
    if (activeCount < this.config.maxConcurrent) {
      this.activeJobs.set(jobId, { id: jobId } as WorkerJob);
      return;
    }

    // At limit — apply backpressure strategy
    if (!this.limitReached) {
      this.limitReached = true;
      this.eventEmitter.emit("concurrency.limit.reached", {
        activeCount,
        maxConcurrent: this.config.maxConcurrent,
        timestamp: new Date(),
      });
      this.logger.warn(`Concurrency limit reached: ${activeCount}/${this.config.maxConcurrent}`);
    }

    this.eventEmitter.emit("concurrency.backpressure.applied", {
      jobId,
      strategy: this.config.backpressureStrategy,
      activeCount,
      queueSize: this.waitQueue.length,
      timestamp: new Date(),
    });

    switch (this.config.backpressureStrategy) {
      case BackpressureStrategy.REJECT:
        this.eventEmitter.emit("concurrency.job.rejected", { jobId, reason: "limit_reached", timestamp: new Date() });
        throw new Error(
          `Concurrency limit reached (${this.config.maxConcurrent}). Job ${jobId} rejected by REJECT strategy.`
        );

      case BackpressureStrategy.QUEUE:
        if (this.waitQueue.length >= this.config.maxQueueSize) {
          this.eventEmitter.emit("concurrency.job.rejected", { jobId, reason: "queue_full", timestamp: new Date() });
          throw new Error(
            `Queue full (${this.config.maxQueueSize}). Job ${jobId} rejected by QUEUE strategy.`
          );
        }
        // Queue the job and wait for a slot
        await new Promise<void>((resolve, reject) => {
          this.waitQueue.push({ jobId, enqueueTime: new Date(), resolve, reject });
          this.eventEmitter.emit("concurrency.job.queued", {
            jobId,
            queueSize: this.waitQueue.length,
            timestamp: new Date(),
          });
          this.logger.debug(`Job ${jobId} queued (queue size: ${this.waitQueue.length})`);
        });
        this.activeJobs.set(jobId, { id: jobId } as WorkerJob);
        break;

      case BackpressureStrategy.THROTTLE:
        // Block until a slot opens or timeout
        await new Promise<void>((resolve, reject) => {
          const timeoutHandle = setTimeout(() => {
            // Remove from queue if still waiting
            const idx = this.waitQueue.findIndex((w) => w.jobId === jobId);
            if (idx >= 0) this.waitQueue.splice(idx, 1);
            this.eventEmitter.emit("concurrency.job.rejected", { jobId, reason: "throttle_timeout", timestamp: new Date() });
            reject(
              new Error(
                `Throttle timeout (${this.config.throttleTimeoutMs}ms). Job ${jobId} rejected by THROTTLE strategy.`
              )
            );
          }, this.config.throttleTimeoutMs);

          this.waitQueue.push({
            jobId,
            enqueueTime: new Date(),
            resolve: () => {
              clearTimeout(timeoutHandle);
              resolve();
            },
            reject: (err) => {
              clearTimeout(timeoutHandle);
              reject(err);
            },
          });
          this.logger.debug(`Job ${jobId} throttled (waiting for slot, timeout: ${this.config.throttleTimeoutMs}ms)`);
        });
        this.activeJobs.set(jobId, { id: jobId } as WorkerJob);
        break;
    }
  }

  /**
   * Release a concurrency slot when a job completes, fails, or is cancelled.
   * Automatically dequeues the next waiting job if any.
   */
  release(jobId: string): void {
    if (!this.activeJobs.has(jobId)) {
      this.logger.warn(`Attempted to release non-active job: ${jobId}`);
      return;
    }

    this.activeJobs.delete(jobId);
    const activeCount = this.activeJobs.size;

    // Check if we've fallen below the limit
    if (this.limitReached && activeCount < this.config.maxConcurrent) {
      this.limitReached = false;
      this.eventEmitter.emit("concurrency.limit.relieved", {
        activeCount,
        maxConcurrent: this.config.maxConcurrent,
        timestamp: new Date(),
      });
      this.logger.log(`Concurrency limit relieved: ${activeCount}/${this.config.maxConcurrent}`);
    }

    // Dequeue next waiting job if any
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) {
        this.eventEmitter.emit("concurrency.job.dequeued", {
          jobId: next.jobId,
          queueSize: this.waitQueue.length,
          waitTimeMs: Date.now() - next.enqueueTime.getTime(),
          timestamp: new Date(),
        });
        this.logger.debug(`Job ${next.jobId} dequeued (queue size: ${this.waitQueue.length})`);
        next.resolve();
      }
    }
  }

  /**
   * Get current concurrency metrics.
   */
  getMetrics() {
    const activeCount = this.activeJobs.size;
    const queuedCount = this.waitQueue.length;
    const utilizationPercent = (activeCount / this.config.maxConcurrent) * 100;

    // Calculate queue wait times
    const now = Date.now();
    const queueWaitTimes = this.waitQueue.map((w) => now - w.enqueueTime.getTime());
    const avgQueueWaitMs = queueWaitTimes.length > 0
      ? queueWaitTimes.reduce((sum, t) => sum + t, 0) / queueWaitTimes.length
      : 0;
    const maxQueueWaitMs = queueWaitTimes.length > 0 ? Math.max(...queueWaitTimes) : 0;

    return {
      activeJobs: activeCount,
      queuedJobs: queuedCount,
      maxConcurrent: this.config.maxConcurrent,
      utilizationPercent: Math.round(utilizationPercent * 100) / 100,
      limitReached: this.limitReached,
      backpressureStrategy: this.config.backpressureStrategy,
      maxQueueSize: this.config.maxQueueSize,
      avgQueueWaitMs: Math.round(avgQueueWaitMs),
      maxQueueWaitMs: Math.round(maxQueueWaitMs),
      config: this.config,
    };
  }

  /**
   * Get list of active job IDs.
   */
  getActiveJobIds(): string[] {
    return Array.from(this.activeJobs.keys());
  }

  /**
   * Get list of queued job IDs with wait times.
   */
  getQueuedJobs(): Array<{ jobId: string; waitTimeMs: number }> {
    const now = Date.now();
    return this.waitQueue.map((w) => ({
      jobId: w.jobId,
      waitTimeMs: now - w.enqueueTime.getTime(),
    }));
  }

  /**
   * Clear all queued jobs (e.g., during shutdown). Does not affect active jobs.
   */
  clearQueue(): void {
    const count = this.waitQueue.length;
    this.waitQueue.forEach((w) => w.reject(new Error("Queue cleared by operator")));
    this.waitQueue.length = 0;
    this.logger.log(`Cleared ${count} queued jobs`);
  }
}

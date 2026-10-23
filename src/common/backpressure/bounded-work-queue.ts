import { ForbiddenException, RateLimitException } from "../errors/app.exception";
import { Permission, Role, hasPermission } from "../guard/roles.enum";

/**
 * Bounded queue with backpressure for expensive background work (#263).
 *
 * At most `maxConcurrent` tasks run at once and at most `maxQueued` wait.
 * Beyond that, submissions are rejected immediately with a 429
 * (`RateLimitException` carrying `retryAfterSeconds`) instead of growing an
 * unbounded in-memory backlog. A per-actor cap stops one caller from filling
 * every waiting slot.
 */
export interface QueueActor {
  id: string;
  roles: Role[];
}

export interface BoundedWorkQueueOptions {
  name: string;
  /** Permission a caller needs to enqueue work. */
  permission: Permission;
  maxConcurrent: number;
  maxQueued: number;
  /** Waiting-slot cap for a single actor. Defaults to `maxQueued`. */
  maxQueuedPerActor?: number;
  /** Total attempts per task, including the first. Defaults to 1 (no retry). */
  maxAttempts?: number;
  retryDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  retryAfterSeconds?: number;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface BoundedWorkQueueStats {
  running: number;
  queued: number;
  completed: number;
  failed: number;
  rejected: number;
}

interface QueuedItem {
  actorId: string;
  start: () => void;
}

export class BoundedWorkQueue {
  private running = 0;
  private completed = 0;
  private failed = 0;
  private rejected = 0;
  private readonly waiting: QueuedItem[] = [];
  private readonly idleWaiters: Array<() => void> = [];

  private readonly maxQueuedPerActor: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly retryAfterSeconds: number;
  private readonly isRetryable: (error: unknown) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: BoundedWorkQueueOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be a positive integer");
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new RangeError("maxQueued must be a non-negative integer");
    }
    this.maxQueuedPerActor = options.maxQueuedPerActor ?? options.maxQueued;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 5;
    this.isRetryable = options.isRetryable ?? (() => true);
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Runs `task` as soon as a slot is free. Rejects with `ForbiddenException`
   * when the actor lacks the queue's permission, and with `RateLimitException`
   * when the queue (or the actor's share of it) is full.
   */
  submit<T>(
    actor: QueueActor,
    task: (attempt: number) => Promise<T>,
  ): Promise<T> {
    if (!hasPermission(actor.roles, this.options.permission)) {
      return Promise.reject(
        new ForbiddenException(
          `Not allowed to enqueue work on "${this.options.name}"`,
        ),
      );
    }

    if (this.running < this.options.maxConcurrent) {
      return this.start(task);
    }

    const actorWaiting = this.waiting.filter(
      (item) => item.actorId === actor.id,
    ).length;
    if (
      this.waiting.length >= this.options.maxQueued ||
      actorWaiting >= this.maxQueuedPerActor
    ) {
      this.rejected += 1;
      return Promise.reject(
        new RateLimitException(
          `Queue "${this.options.name}" is full; retry later`,
          this.retryAfterSeconds,
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        actorId: actor.id,
        start: () => {
          this.start(task).then(resolve, reject);
        },
      });
    });
  }

  stats(): BoundedWorkQueueStats {
    return {
      running: this.running,
      queued: this.waiting.length,
      completed: this.completed,
      failed: this.failed,
      rejected: this.rejected,
    };
  }

  /** Resolves once nothing is running or waiting. */
  idle(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async start<T>(task: (attempt: number) => Promise<T>): Promise<T> {
    this.running += 1;
    try {
      const result = await this.runWithRetry(task);
      this.completed += 1;
      return result;
    } catch (error) {
      this.failed += 1;
      throw error;
    } finally {
      this.running -= 1;
      this.pump();
    }
  }

  private async runWithRetry<T>(
    task: (attempt: number) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await task(attempt);
      } catch (error) {
        if (attempt >= this.maxAttempts || !this.isRetryable(error)) {
          throw error;
        }
        await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  private pump(): void {
    while (this.running < this.options.maxConcurrent && this.waiting.length) {
      this.waiting.shift()!.start();
    }
    if (this.running === 0 && this.waiting.length === 0) {
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }
}

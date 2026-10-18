import { ConflictException, Logger } from "@nestjs/common";
import {
  OptimisticConcurrencyService,
  VersionedRecord,
} from "./optimistic-concurrency.service";

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

export interface SubmissionResult<T> {
  result: T;
  isDuplicate: boolean;
  attempts: number;
}

/**
 * Concurrency coordinator providing:
 * - Duplicate submission prevention across concurrent callers
 * - Optimistic locking retry executor with exponential backoff
 */
export class ConcurrencyExecutor {
  private readonly logger = new Logger(ConcurrencyExecutor.name);
  private readonly inFlightSubmissions = new Map<string, Promise<unknown>>();
  private readonly completedSubmissions = new Map<
    string,
    { result: unknown; timestamp: number }
  >();

  constructor(
    private readonly optimisticConcurrency = new OptimisticConcurrencyService(),
    private readonly ttlMs = 60_000,
  ) {}

  /**
   * Execute an operation with duplicate submission protection.
   * If a concurrent execution with the same submission key is already running,
   * subsequent callers wait and receive the same result without duplicate execution.
   */
  async executeIdempotent<T>(
    submissionKey: string,
    operation: () => Promise<T>,
  ): Promise<SubmissionResult<T>> {
    // Check if recently completed
    const existing = this.completedSubmissions.get(submissionKey);
    if (existing && Date.now() - existing.timestamp < this.ttlMs) {
      return {
        result: existing.result as T,
        isDuplicate: true,
        attempts: 1,
      };
    }

    // Check if in-flight
    if (this.inFlightSubmissions.has(submissionKey)) {
      const result = (await this.inFlightSubmissions.get(
        submissionKey,
      )) as T;
      return {
        result,
        isDuplicate: true,
        attempts: 1,
      };
    }

    const promise = (async () => {
      try {
        const result = await operation();
        this.completedSubmissions.set(submissionKey, {
          result,
          timestamp: Date.now(),
        });
        return result;
      } finally {
        this.inFlightSubmissions.delete(submissionKey);
      }
    })();

    this.inFlightSubmissions.set(submissionKey, promise);
    const result = await promise;
    return {
      result,
      isDuplicate: false,
      attempts: 1,
    };
  }

  /**
   * Execute a transactional mutation with optimistic concurrency checks
   * and automatic retry on stale version conflicts.
   */
  async executeWithRetry<T extends VersionedRecord, R>(
    fetchRecord: () => Promise<T>,
    mutate: (current: T) => Promise<{ updated: T; result: R }>,
    saveRecord: (updated: T, expectedVersion: number) => Promise<T>,
    options: RetryOptions = {},
  ): Promise<{ record: T; result: R; attempts: number }> {
    const maxRetries = options.maxRetries ?? 3;
    const initialDelayMs = options.initialDelayMs ?? 10;
    const maxDelayMs = options.maxDelayMs ?? 500;
    const backoffFactor = options.backoffFactor ?? 2;

    let attempts = 0;
    let delay = initialDelayMs;

    while (attempts <= maxRetries) {
      attempts++;
      const current = await fetchRecord();
      const expectedVersion = current.version;

      try {
        const { updated, result } = await mutate(current);
        this.optimisticConcurrency.assertCurrent(current, expectedVersion);
        updated.version = this.optimisticConcurrency.nextVersion(expectedVersion);

        const saved = await saveRecord(updated, expectedVersion);
        return { record: saved, result, attempts };
      } catch (err) {
        if (err instanceof ConflictException && attempts <= maxRetries) {
          this.logger.debug(
            `Optimistic concurrency conflict on attempt ${attempts}/${maxRetries}. Retrying...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * backoffFactor, maxDelayMs);
          continue;
        }
        throw err;
      }
    }

    throw new ConflictException(
      `Exceeded max concurrency retry attempts (${maxRetries}).`,
    );
  }
}

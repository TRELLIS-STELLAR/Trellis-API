import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThanOrEqual, In } from "typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  RetryOperation,
  RetryOperationStatus,
} from "./entities/retry-operation.entity";
import {
  MAX_BULK_DEAD_LETTER_RETRY,
  ScheduleRetryDto,
} from "./dto/schedule-retry.dto";
import {
  getCorrelationId,
  normalizeCorrelationId,
} from "../../common/correlation/correlation-context";
import { sanitizeErrorMessage } from "../../logging/sanitize.util";

export interface ScheduleRetryOpts {
  operationType: string;
  operationId: string;
  payload: any;
  maxAttempts?: number;
  backoffMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
  retryable?: boolean;
  correlationId?: string;
  metadata?: Record<string, any>;
}

export interface DeadLetterRetryOptions {
  maxAttempts?: number;
  /** Operator id recorded in the retry audit trail. */
  actor?: string;
  reason?: string;
  /** Re-queue even though the last failure was marked non-retryable. */
  force?: boolean;
}

export type BulkRetryItemStatus =
  | "requeued"
  | "skipped_non_retryable"
  | "already_retried";

export interface BulkRetryResult {
  requested: number;
  requeued: number;
  results: Array<{ operationId: string; status: BulkRetryItemStatus }>;
}

/** Retry audit entries kept per operation; older ones are dropped. */
const MAX_RETRY_AUDIT_ENTRIES = 10;

@Injectable()
export class RetrySchedulerService {
  private readonly logger = new Logger(RetrySchedulerService.name);

  constructor(
    @InjectRepository(RetryOperation)
    private readonly retryRepo: Repository<RetryOperation>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async schedule(opts: ScheduleRetryOpts): Promise<RetryOperation> {
    const operation = this.retryRepo.create({
      operationType: opts.operationType,
      operationId: opts.operationId,
      payload: opts.payload,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 3,
      backoffMs: opts.backoffMs ?? 1000,
      backoffMultiplier: opts.backoffMultiplier ?? 2,
      maxBackoffMs: opts.maxBackoffMs ?? 60000,
      retryable: opts.retryable ?? true,
      // An explicit ID wins; otherwise the scheduling request's ID is kept so
      // every later attempt can be traced back to it (#270).
      correlationId:
        normalizeCorrelationId(opts.correlationId) ?? getCorrelationId() ?? null,
      metadata: opts.metadata ?? null,
      status: RetryOperationStatus.PENDING,
      nextRetryAt: new Date(),
    });

    const saved = await this.retryRepo.save(operation);
    this.logger.log(
      `Scheduled retry operation ${saved.operationId} (type=${saved.operationType})`,
    );
    return saved;
  }

  async markSucceeded(operationId: string): Promise<RetryOperation | null> {
    const operation = await this.retryRepo.findOne({
      where: { operationId },
    });
    if (!operation) return null;

    operation.status = RetryOperationStatus.SUCCEEDED;
    operation.completedAt = new Date();
    operation.nextRetryAt = null;
    const saved = await this.retryRepo.save(operation);

    this.eventEmitter.emit("retry.succeeded", {
      operationId: saved.operationId,
      operationType: saved.operationType,
      attempts: saved.attempts,
    });

    this.logger.log(
      `Operation ${operationId} succeeded after ${saved.attempts} attempt(s)`,
    );
    return saved;
  }

  async markFailed(
    operationId: string,
    error: string,
    retryable = true,
  ): Promise<RetryOperation | null> {
    const operation = await this.retryRepo.findOne({
      where: { operationId },
    });
    if (!operation) return null;

    // lastError is served by the failure dashboard and dead-letter listing.
    const reason = sanitizeErrorMessage(String(error ?? ""));
    operation.attempts += 1;
    operation.lastError = reason;

    if (!retryable || !operation.retryable) {
      return this.moveToDeadLetter(operation, "Non-retryable failure", false);
    }

    if (operation.attempts >= operation.maxAttempts) {
      return this.moveToDeadLetter(
        operation,
        `Exhausted ${operation.maxAttempts} retry attempts`,
      );
    }

    operation.status = RetryOperationStatus.PENDING;
    operation.nextRetryAt = this.calculateNextRetry(operation);
    const saved = await this.retryRepo.save(operation);

    this.eventEmitter.emit("retry.failed", {
      operationId: saved.operationId,
      operationType: saved.operationType,
      attempts: saved.attempts,
      maxAttempts: saved.maxAttempts,
      nextRetryAt: saved.nextRetryAt,
      error: reason,
      correlationId: saved.correlationId,
    });

    const nextAt = saved.nextRetryAt instanceof Date
      ? saved.nextRetryAt.toISOString()
      : String(saved.nextRetryAt);
    this.logger.warn(
      `Operation ${operationId} failed (attempt ${saved.attempts}/${saved.maxAttempts}), ` +
        `next retry at ${nextAt}`,
    );
    return saved;
  }

  async getDueOperations(limit = 50): Promise<RetryOperation[]> {
    return this.retryRepo.find({
      where: {
        status: RetryOperationStatus.PENDING,
        nextRetryAt: LessThanOrEqual(new Date()),
      },
      order: { nextRetryAt: "ASC" },
      take: limit,
    });
  }

  async markInProgress(operationId: string): Promise<RetryOperation | null> {
    const operation = await this.retryRepo.findOne({
      where: { operationId },
    });
    if (!operation) return null;

    operation.status = RetryOperationStatus.IN_PROGRESS;
    return this.retryRepo.save(operation);
  }

  async getDeadLetters(
    limit = 50,
    offset = 0,
  ): Promise<{ items: RetryOperation[]; total: number }> {
    const [items, total] = await this.retryRepo.findAndCount({
      where: { status: RetryOperationStatus.DEAD_LETTER },
      order: { deadLetteredAt: "DESC" },
      take: Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 50)),
      skip: Math.max(0, Math.trunc(Number(offset)) || 0),
    });
    return { items, total };
  }

  /**
   * Read-only dashboard view of unresolved failures. Payloads are deliberately
   * excluded because they may contain secrets or user supplied data.
   */
  async getFailureDashboard(filters: {
    operationType?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const rawLimit = filters.limit ?? 50;
    const rawOffset = filters.offset ?? 0;
    const requestedLimit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50;
    const requestedOffset = Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0;
    const limit = Math.min(100, Math.max(1, requestedLimit));
    const offset = Math.max(0, requestedOffset);
    const query = this.retryRepo
      .createQueryBuilder("operation")
      .where("operation.status IN (:...statuses)", {
        statuses: [RetryOperationStatus.FAILED, RetryOperationStatus.DEAD_LETTER],
      });

    if (filters.operationType?.trim()) {
      query.andWhere("operation.operationType = :operationType", {
        operationType: filters.operationType.trim(),
      });
    }

    const search = filters.search?.trim();
    if (search) {
      query.andWhere(
        "(operation.operationId ILIKE :search OR operation.lastError ILIKE :search OR operation.correlationId ILIKE :search)",
        { search: `%${search}%` },
      );
    }

    const [operations, total] = await query
      .select([
        "operation.operationId",
        "operation.operationType",
        "operation.status",
        "operation.attempts",
        "operation.maxAttempts",
        "operation.lastError",
        "operation.retryable",
        "operation.correlationId",
        "operation.metadata",
        "operation.nextRetryAt",
        "operation.updatedAt",
      ])
      .orderBy("operation.updatedAt", "DESC")
      .take(limit)
      .skip(offset)
      .getManyAndCount();

    return {
      items: operations.map((operation) => ({
        operationId: operation.operationId,
        operationType: operation.operationType,
        status: operation.status,
        attempts: operation.attempts,
        maxAttempts: operation.maxAttempts,
        cause: operation.lastError,
        retryable: operation.retryable,
        requiresUserAction: operation.metadata?.userActionRequired === true,
        correlationId: operation.correlationId,
        nextRetryAt: operation.nextRetryAt,
        updatedAt: operation.updatedAt,
        recommendedAction:
          operation.metadata?.userActionRequired === true
            ? "REQUEST_USER_ACTION"
            : operation.status === RetryOperationStatus.DEAD_LETTER &&
                operation.retryable
              ? "RETRY_OR_INVESTIGATE"
              : "INVESTIGATE",
      })),
      total,
      limit,
      offset,
    };
  }

  /**
   * Re-queues one dead-lettered operation. The status-conditioned update makes
   * concurrent retries of the same operation race-safe: exactly one wins and
   * the others get null, as for an unknown or already retried operation. A
   * failure recorded as non-retryable is refused unless `force` is set.
   */
  async retryDeadLetter(
    operationId: string,
    newMaxAttempts?: number,
    options: DeadLetterRetryOptions = {},
  ): Promise<RetryOperation | null> {
    const operation = await this.retryRepo.findOne({
      where: { operationId, status: RetryOperationStatus.DEAD_LETTER },
    });
    if (!operation) return null;
    if (!options.force && !this.isRetryable(operation)) {
      throw new ConflictException(
        `Operation ${operationId} failed with a non-retryable error; fix the cause and retry with force`,
      );
    }

    const retries = [
      ...(operation.metadata?.deadLetterRetries ?? []),
      {
        at: new Date().toISOString(),
        by: options.actor ?? "system",
        reason: options.reason ?? null,
        forced: options.force === true,
        previousAttempts: operation.attempts,
        previousError: operation.lastError,
      },
    ].slice(-MAX_RETRY_AUDIT_ENTRIES);
    const { affected } = await this.retryRepo.update(
      { id: operation.id, status: RetryOperationStatus.DEAD_LETTER },
      {
        status: RetryOperationStatus.PENDING,
        attempts: 0,
        maxAttempts: newMaxAttempts ?? operation.maxAttempts,
        nextRetryAt: new Date(),
        deadLetteredAt: null,
        lastError: null,
        metadata: { ...operation.metadata, deadLetterRetries: retries },
      },
    );
    if (affected !== 1) return null;

    this.eventEmitter.emit("retry.dead_letter_retried", {
      operationId,
      operationType: operation.operationType,
      by: options.actor ?? "system",
      forced: options.force === true,
    });
    this.logger.log(`Dead-lettered operation ${operationId} re-queued for retry`);
    return this.retryRepo.findOne({ where: { operationId } });
  }

  /**
   * Re-queues the oldest retryable dead letters, optionally of one type, and
   * reports each outcome. Non-retryable failures are skipped, never forced.
   * At most MAX_BULK_DEAD_LETTER_RETRY operations: O(n) round trips.
   */
  async retryDeadLetters(
    filter: { operationType?: string; limit?: number },
    options: Omit<DeadLetterRetryOptions, "force" | "maxAttempts"> = {},
  ): Promise<BulkRetryResult> {
    const operations = await this.retryRepo.find({
      where: {
        status: RetryOperationStatus.DEAD_LETTER,
        ...(filter.operationType && { operationType: filter.operationType }),
      },
      order: { deadLetteredAt: "ASC" },
      take: Math.min(
        MAX_BULK_DEAD_LETTER_RETRY,
        Math.max(1, Math.trunc(filter.limit ?? MAX_BULK_DEAD_LETTER_RETRY)),
      ),
    });
    const results: BulkRetryResult["results"] = [];
    for (const operation of operations) {
      let status: BulkRetryItemStatus;
      if (!this.isRetryable(operation)) {
        status = "skipped_non_retryable";
      } else {
        const retried = await this.retryDeadLetter(
          operation.operationId,
          undefined,
          options,
        );
        status = retried ? "requeued" : "already_retried";
      }
      results.push({ operationId: operation.operationId, status });
    }
    return {
      requested: operations.length,
      requeued: results.filter((r) => r.status === "requeued").length,
      results,
    };
  }

  private isRetryable(operation: RetryOperation): boolean {
    return (
      operation.retryable && operation.metadata?.deadLetter?.retryable !== false
    );
  }

  async getOperationStatus(
    operationId: string,
  ): Promise<RetryOperation | null> {
    return this.retryRepo.findOne({ where: { operationId } });
  }

  async getMetrics(): Promise<{
    total: number;
    pending: number;
    inProgress: number;
    succeeded: number;
    failed: number;
    deadLettered: number;
    successRate: number;
    byType: Record<string, number>;
    avgAttemptsBeforeSuccess: number;
  }> {
    const all = await this.retryRepo.find();
    const total = all.length;
    const pending = all.filter(
      (o) => o.status === RetryOperationStatus.PENDING,
    ).length;
    const inProgress = all.filter(
      (o) => o.status === RetryOperationStatus.IN_PROGRESS,
    ).length;
    const succeeded = all.filter(
      (o) => o.status === RetryOperationStatus.SUCCEEDED,
    ).length;
    const failed = all.filter(
      (o) => o.status === RetryOperationStatus.FAILED,
    ).length;
    const deadLettered = all.filter(
      (o) => o.status === RetryOperationStatus.DEAD_LETTER,
    ).length;

    const terminal = succeeded + failed + deadLettered;
    const successRate = terminal > 0 ? (succeeded / terminal) * 100 : 0;

    const byType = all.reduce<Record<string, number>>((acc, o) => {
      acc[o.operationType] = (acc[o.operationType] || 0) + 1;
      return acc;
    }, {});

    const succeededOps = all.filter(
      (o) => o.status === RetryOperationStatus.SUCCEEDED,
    );
    const avgAttemptsBeforeSuccess =
      succeededOps.length > 0
        ? succeededOps.reduce((sum, o) => sum + o.attempts, 0) /
          succeededOps.length
        : 0;

    return {
      total,
      pending,
      inProgress,
      succeeded,
      failed,
      deadLettered,
      successRate,
      byType,
      avgAttemptsBeforeSuccess,
    };
  }

  private async moveToDeadLetter(
    operation: RetryOperation,
    reason: string,
    retryable = true,
  ): Promise<RetryOperation> {
    operation.status = RetryOperationStatus.DEAD_LETTER;
    operation.deadLetteredAt = new Date();
    operation.nextRetryAt = null;
    // Persisted so a later manual retry knows whether re-running can succeed.
    operation.metadata = {
      ...operation.metadata,
      deadLetter: { reason, retryable },
    };
    const saved = await this.retryRepo.save(operation);

    this.eventEmitter.emit("retry.dead_letter", {
      operationId: saved.operationId,
      operationType: saved.operationType,
      attempts: saved.attempts,
      lastError: saved.lastError,
      reason,
      correlationId: saved.correlationId,
    });

    this.logger.warn(
      `Operation ${saved.operationId} moved to dead letter: ${reason}`,
    );
    return saved;
  }

  private calculateNextRetry(operation: RetryOperation): Date {
    const delay = Math.min(
      operation.backoffMs *
        Math.pow(operation.backoffMultiplier, operation.attempts - 1),
      operation.maxBackoffMs,
    );
    // Add jitter: +/- 10%
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    const totalDelay = Math.max(0, delay + jitter);
    return new Date(Date.now() + totalDelay);
  }
}

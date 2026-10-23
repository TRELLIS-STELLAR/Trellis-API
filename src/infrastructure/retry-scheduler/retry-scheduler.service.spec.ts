import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { RetrySchedulerService } from "./retry-scheduler.service";
import {
  RetryOperation,
  RetryOperationStatus,
} from "./entities/retry-operation.entity";

describe("RetrySchedulerService", () => {
  let service: RetrySchedulerService;
  let eventEmitter: EventEmitter2;

  const mockOperations: RetryOperation[] = [];

  function cloneOp(op: any): any {
    const copy = { ...op };
    if (copy.nextRetryAt) copy.nextRetryAt = new Date(copy.nextRetryAt);
    if (copy.createdAt) copy.createdAt = new Date(copy.createdAt);
    if (copy.updatedAt) copy.updatedAt = new Date(copy.updatedAt);
    if (copy.completedAt) copy.completedAt = new Date(copy.completedAt);
    if (copy.deadLetteredAt) copy.deadLetteredAt = new Date(copy.deadLetteredAt);
    return copy;
  }

  const mockRepository = {
    create: jest.fn((dto) => ({ ...dto, id: `uuid-${dto.operationId}` })),
    save: jest.fn((entity) => {
      const stored = cloneOp(entity);
      const idx = mockOperations.findIndex(
        (o) => o.operationId === entity.operationId,
      );
      if (idx >= 0) {
        mockOperations[idx] = stored;
      } else {
        mockOperations.push(stored);
      }
      return Promise.resolve(cloneOp(entity));
    }),
    findOne: jest.fn(({ where }) => {
      const match = mockOperations.find((o) => {
        if (where.operationId && where.status) {
          return (
            o.operationId === where.operationId && o.status === where.status
          );
        }
        return o.operationId === where.operationId;
      });
      return Promise.resolve(match ? cloneOp(match) : null);
    }),
    find: jest.fn((options?: any) => {
      const where = options?.where ?? {};
      const matches = mockOperations.filter((o) =>
        Object.entries(where).every(
          ([key, value]) => typeof value !== "string" || o[key] === value,
        ),
      );
      return Promise.resolve(
        matches.slice(0, options?.take ?? matches.length).map(cloneOp),
      );
    }),
    update: jest.fn(({ id, status }, patch) => {
      const op = mockOperations.find((o) => o.id === id && o.status === status);
      if (op) Object.assign(op, cloneOp(patch));
      return Promise.resolve({ affected: op ? 1 : 0 });
    }),
    findAndCount: jest.fn(({ where }) => {
      const filtered = mockOperations.filter(
        (o) => o.status === where.status,
      );
      return Promise.resolve([filtered.map(cloneOp), filtered.length]);
    }),
  };

  beforeEach(async () => {
    mockOperations.length = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetrySchedulerService,
        {
          provide: getRepositoryToken(RetryOperation),
          useValue: mockRepository,
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RetrySchedulerService>(RetrySchedulerService);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);

    jest.clearAllMocks();
  });

  describe("schedule", () => {
    it("should create a pending retry operation", async () => {
      const result = await service.schedule({
        operationType: "webhook.delivery",
        operationId: "op-1",
        payload: { url: "https://example.com" },
        maxAttempts: 5,
        backoffMs: 2000,
      });

      expect(result.operationId).toBe("op-1");
      expect(result.status).toBe(RetryOperationStatus.PENDING);
      expect(result.maxAttempts).toBe(5);
      expect(result.backoffMs).toBe(2000);
      expect(mockRepository.create).toHaveBeenCalled();
      expect(mockRepository.save).toHaveBeenCalled();
    });
  });

  describe("markSucceeded", () => {
    it("should mark operation as succeeded and emit event", async () => {
      await service.schedule({
        operationType: "email.send",
        operationId: "op-2",
        payload: { to: "user@example.com" },
      });

      const result = await service.markSucceeded("op-2");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(RetryOperationStatus.SUCCEEDED);
      expect(result!.completedAt).toBeDefined();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        "retry.succeeded",
        expect.objectContaining({ operationId: "op-2" }),
      );
    });

    it("should return null for unknown operation", async () => {
      const result = await service.markSucceeded("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("success after retry", () => {
    it("should succeed after one failure and retry", async () => {
      await service.schedule({
        operationType: "webhook.delivery",
        operationId: "op-retry-1",
        payload: { data: "test" },
        maxAttempts: 3,
      });

      // First attempt fails
      const failed = await service.markFailed(
        "op-retry-1",
        "Connection timeout",
      );
      expect(failed!.status).toBe(RetryOperationStatus.PENDING);
      expect(failed!.attempts).toBe(1);
      expect(failed!.nextRetryAt).toBeDefined();

      // Second attempt succeeds
      const succeeded = await service.markSucceeded("op-retry-1");
      expect(succeeded!.status).toBe(RetryOperationStatus.SUCCEEDED);
      expect(succeeded!.completedAt).toBeDefined();
    });
  });

  describe("retry exhaustion", () => {
    it("should move to dead letter after maxAttempts failures", async () => {
      await service.schedule({
        operationType: "payment.submit",
        operationId: "op-exhaust-1",
        payload: { amount: 100 },
        maxAttempts: 2,
      });

      // First failure
      await service.markFailed("op-exhaust-1", "Network error");

      // Second failure - should exhaust retries
      const deadLettered = await service.markFailed(
        "op-exhaust-1",
        "Network error again",
      );
      expect(deadLettered!.status).toBe(RetryOperationStatus.DEAD_LETTER);
      expect(deadLettered!.deadLetteredAt).toBeDefined();
      expect(deadLettered!.nextRetryAt).toBeNull();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        "retry.dead_letter",
        expect.objectContaining({
          operationId: "op-exhaust-1",
          reason: expect.stringContaining("Exhausted"),
        }),
      );
    });
  });

  describe("non-retryable failure", () => {
    it("should immediately dead-letter non-retryable failures", async () => {
      await service.schedule({
        operationType: "payment.submit",
        operationId: "op-nonretry-1",
        payload: { amount: 100 },
        maxAttempts: 5,
      });

      const result = await service.markFailed(
        "op-nonretry-1",
        "Invalid payload - cannot retry",
        false,
      );

      expect(result!.status).toBe(RetryOperationStatus.DEAD_LETTER);
      expect(result!.deadLetteredAt).toBeDefined();
      expect(result!.attempts).toBe(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        "retry.dead_letter",
        expect.objectContaining({
          operationId: "op-nonretry-1",
          reason: "Non-retryable failure",
        }),
      );
    });

    it("should immediately dead-letter operations marked non-retryable at schedule time", async () => {
      await service.schedule({
        operationType: "data.validate",
        operationId: "op-nonretry-2",
        payload: { data: "test" },
        retryable: false,
      });

      const result = await service.markFailed(
        "op-nonretry-2",
        "Validation failed",
      );

      expect(result!.status).toBe(RetryOperationStatus.DEAD_LETTER);
    });
  });

  describe("backoff calculation", () => {
    it("should apply exponential backoff with cap", async () => {
      await service.schedule({
        operationType: "webhook.delivery",
        operationId: "op-backoff-1",
        payload: {},
        maxAttempts: 10,
        backoffMs: 1000,
        backoffMultiplier: 2,
        maxBackoffMs: 10000,
      });

      // First failure: delay ~1000ms
      const fail1 = await service.markFailed("op-backoff-1", "err");
      const delay1 =
        fail1!.nextRetryAt!.getTime() - Date.now();
      expect(delay1).toBeGreaterThan(800); // 1000 - 10% jitter
      expect(delay1).toBeLessThan(1200); // 1000 + 10% jitter

      // Second failure: delay ~2000ms
      const fail2 = await service.markFailed("op-backoff-1", "err");
      const delay2 =
        fail2!.nextRetryAt!.getTime() - Date.now();
      expect(delay2).toBeGreaterThan(1600); // 2000 - 10% jitter
      expect(delay2).toBeLessThan(2400); // 2000 + 10% jitter

      // After several failures, should cap at maxBackoffMs
      await service.markFailed("op-backoff-1", "err"); // 4000ms
      await service.markFailed("op-backoff-1", "err"); // 8000ms
      const fail5 = await service.markFailed("op-backoff-1", "err"); // should cap at 10000ms
      const delay5 =
        fail5!.nextRetryAt!.getTime() - Date.now();
      expect(delay5).toBeLessThanOrEqual(11000); // 10000 + 10% jitter
    });
  });

  describe("getDeadLetters", () => {
    it("should return dead-lettered operations", async () => {
      await service.schedule({
        operationType: "email.send",
        operationId: "op-dl-1",
        payload: {},
        maxAttempts: 1,
      });
      await service.markFailed("op-dl-1", "SMTP error");

      const { items, total } = await service.getDeadLetters();
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.every((o) => o.status === RetryOperationStatus.DEAD_LETTER)).toBe(true);
    });

    it("bounds the page size and offset", async () => {
      await service.getDeadLetters("5000" as any, "-3" as any);
      expect(mockRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100, skip: 0 }),
      );
    });
  });

  describe("retryDeadLetter", () => {
    it("should re-queue a dead-lettered operation", async () => {
      await service.schedule({
        operationType: "webhook.delivery",
        operationId: "op-dl-retry-1",
        payload: {},
        maxAttempts: 1,
      });
      await service.markFailed("op-dl-retry-1", "timeout");

      const retried = await service.retryDeadLetter("op-dl-retry-1", 3);
      expect(retried).not.toBeNull();
      expect(retried!.status).toBe(RetryOperationStatus.PENDING);
      expect(retried!.attempts).toBe(0);
      expect(retried!.maxAttempts).toBe(3);
      expect(retried!.deadLetteredAt).toBeNull();
    });

    it("should return null for non-dead-lettered operation", async () => {
      await service.schedule({
        operationType: "email.send",
        operationId: "op-dl-retry-2",
        payload: {},
      });

      const result = await service.retryDeadLetter("op-dl-retry-2");
      expect(result).toBeNull();
    });

    const deadLetter = async (operationId: string, retryable = true) => {
      await service.schedule({
        operationType: "webhook.delivery",
        operationId,
        payload: {},
        maxAttempts: 1,
      });
      await service.markFailed(operationId, "boom", retryable);
    };

    it("records who retried, why, and the failure it replaced", async () => {
      await deadLetter("op-audit");
      const retried = await service.retryDeadLetter("op-audit", undefined, {
        actor: "admin-1",
        reason: "endpoint fixed",
      });
      expect(retried!.metadata.deadLetterRetries).toEqual([
        expect.objectContaining({
          by: "admin-1",
          reason: "endpoint fixed",
          forced: false,
          previousAttempts: 1,
          previousError: "boom",
        }),
      ]);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        "retry.dead_letter_retried",
        expect.objectContaining({ operationId: "op-audit", by: "admin-1" }),
      );
    });

    it("refuses a non-retryable failure unless forced", async () => {
      await deadLetter("op-fatal", false);
      await expect(service.retryDeadLetter("op-fatal")).rejects.toThrow(
        "non-retryable",
      );
      const forced = await service.retryDeadLetter("op-fatal", undefined, {
        force: true,
      });
      expect(forced!.status).toBe(RetryOperationStatus.PENDING);
      expect(forced!.metadata.deadLetterRetries[0].forced).toBe(true);
    });

    it("lets only one of two concurrent retries win", async () => {
      await deadLetter("op-race");
      const [a, b] = await Promise.all([
        service.retryDeadLetter("op-race"),
        service.retryDeadLetter("op-race"),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it("keeps the retry audit trail bounded", async () => {
      await deadLetter("op-many");
      for (let i = 0; i < 12; i++) {
        await service.retryDeadLetter("op-many", undefined, { reason: `r${i}` });
        await service.markFailed("op-many", "boom");
      }
      const trail = (await service.getOperationStatus("op-many"))!.metadata
        .deadLetterRetries;
      expect(trail).toHaveLength(10);
      expect(trail[9].reason).toBe("r11");
    });
  });

  describe("retryDeadLetters", () => {
    const deadLetter = async (
      operationId: string,
      operationType: string,
      retryable = true,
    ) => {
      await service.schedule({
        operationType,
        operationId,
        payload: {},
        maxAttempts: 1,
      });
      await service.markFailed(operationId, "boom", retryable);
    };

    it("re-queues retryable dead letters and reports skipped ones", async () => {
      await deadLetter("bulk-1", "webhook.delivery");
      await deadLetter("bulk-2", "webhook.delivery", false);
      await deadLetter("bulk-3", "email.send");

      const result = await service.retryDeadLetters(
        { operationType: "webhook.delivery" },
        { actor: "admin-1", reason: "provider recovered" },
      );
      expect(result).toEqual({
        requested: 2,
        requeued: 1,
        results: [
          { operationId: "bulk-1", status: "requeued" },
          { operationId: "bulk-2", status: "skipped_non_retryable" },
        ],
      });
      expect((await service.getOperationStatus("bulk-3"))!.status).toBe(
        RetryOperationStatus.DEAD_LETTER,
      );
    });

    it("reports a dead letter retried concurrently as already_retried", async () => {
      await deadLetter("bulk-race", "webhook.delivery");
      mockRepository.update.mockResolvedValueOnce({ affected: 0 });
      expect((await service.retryDeadLetters({})).results).toEqual([
        { operationId: "bulk-race", status: "already_retried" },
      ]);
    });

    it("caps one bulk retry at 100 operations", async () => {
      await service.retryDeadLetters({ limit: 5000 });
      expect(mockRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe("getMetrics", () => {
    it("should return correct metrics", async () => {
      await service.schedule({
        operationType: "webhook.delivery",
        operationId: "op-m1",
        payload: {},
      });
      await service.markSucceeded("op-m1");

      await service.schedule({
        operationType: "email.send",
        operationId: "op-m2",
        payload: {},
        maxAttempts: 1,
      });
      await service.markFailed("op-m2", "error");

      const metrics = await service.getMetrics();
      expect(metrics.total).toBeGreaterThanOrEqual(2);
      expect(metrics.succeeded).toBeGreaterThanOrEqual(1);
      expect(metrics.deadLettered).toBeGreaterThanOrEqual(1);
      expect(metrics.successRate).toBeGreaterThan(0);
      expect(metrics.byType["webhook.delivery"]).toBeDefined();
      expect(metrics.byType["email.send"]).toBeDefined();
    });
  });

  describe("getFailureDashboard", () => {
    it("filters unresolved failures and omits operation payloads", async () => {
      const failure = {
        operationId: "op-42",
        operationType: "webhook.delivery",
        status: RetryOperationStatus.DEAD_LETTER,
        attempts: 3,
        maxAttempts: 3,
        lastError: "endpoint timed out",
        retryable: true,
        correlationId: "corr-42",
        nextRetryAt: null,
        updatedAt: new Date("2026-10-17T00:00:00Z"),
        payload: { secret: "must not be returned" },
        metadata: null,
      };
      const userActionFailure = {
        ...failure,
        operationId: "op-43",
        status: RetryOperationStatus.FAILED,
        retryable: false,
        metadata: { userActionRequired: true },
      };
      const builder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getManyAndCount: jest
          .fn()
          .mockResolvedValue([[failure, userActionFailure], 2]),
      };
      (mockRepository as any).createQueryBuilder = jest.fn(() => builder);

      const result = await service.getFailureDashboard({
        operationType: "webhook.delivery",
        search: "timed out",
        limit: 500,
        offset: -2,
      });

      expect(builder.where).toHaveBeenCalledWith(
        "operation.status IN (:...statuses)",
        { statuses: [RetryOperationStatus.FAILED, RetryOperationStatus.DEAD_LETTER] },
      );
      expect(builder.andWhere).toHaveBeenCalledTimes(2);
      expect(result.items[0]).toMatchObject({
        operationId: "op-42",
        cause: "endpoint timed out",
        recommendedAction: "RETRY_OR_INVESTIGATE",
      });
      expect(result.items[0]).not.toHaveProperty("payload");
      expect(result.items[1]).toMatchObject({
        requiresUserAction: true,
        recommendedAction: "REQUEST_USER_ACTION",
      });
      expect(result.limit).toBe(100);
      expect(result.offset).toBe(0);
    });
  });
});

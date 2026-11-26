/**
 * Comprehensive tests for checkpoint service covering:
 * - Normal operation checkpointing
 * - Failure scenarios and error handling
 * - Retry logic with idempotency
 * - Authorization and access patterns
 * - Recovery and rollback operations
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  CheckpointService,
  CheckpointStatus,
  OperationType,
} from './checkpoint.service';

describe('CheckpointService', () => {
  let service: CheckpointService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CheckpointService],
    }).compile();

    service = module.get<CheckpointService>(CheckpointService);
  });

  describe('Normal operation checkpointing', () => {
    it('creates a new checkpoint for first-time operation', async () => {
      const guard = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        'request-123',
        { url: 'https://api.example.com' },
      );

      expect(guard.canProceed).toBe(true);
      expect(guard.operationId).toBeDefined();
      expect(guard.previousResult).toBeUndefined();

      const checkpoint = service.getCheckpoint(guard.operationId);
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.status).toBe(CheckpointStatus.IN_PROGRESS);
      expect(checkpoint?.operationType).toBe(OperationType.HTTP_REQUEST);
    });

    it('marks checkpoint as completed after successful execution', async () => {
      const guard = await service.createCheckpoint(
        OperationType.EXTERNAL_API,
        'api-call-456',
      );

      const result = { success: true, data: 'test' };
      await service.completeCheckpoint(guard.operationId, result);

      const checkpoint = service.getCheckpoint(guard.operationId);
      expect(checkpoint?.status).toBe(CheckpointStatus.COMPLETED);
      expect(checkpoint?.response).toEqual(result);
      expect(checkpoint?.completedAt).toBeInstanceOf(Date);
    });

    it('prevents duplicate execution with same idempotency key', async () => {
      const idempotencyKey = 'payment-789';
      
      // First execution
      const guard1 = await service.createCheckpoint(
        OperationType.PAYMENT_PROCESS,
        idempotencyKey,
      );
      await service.completeCheckpoint(guard1.operationId, { paid: true });

      // Second attempt with same key
      const guard2 = await service.createCheckpoint(
        OperationType.PAYMENT_PROCESS,
        idempotencyKey,
      );

      expect(guard2.canProceed).toBe(false);
      expect(guard2.previousResult).toEqual({ paid: true });
      expect(guard2.reason).toBe('Operation already completed');
    });

    it('tracks operation context and metadata', async () => {
      const context = {
        userId: 'user-123',
        endpoint: '/api/payment',
        amount: 100,
      };

      const guard = await service.createCheckpoint(
        OperationType.PAYMENT_PROCESS,
        'payment-001',
        context,
        {
          correlationId: 'corr-001',
          maxRetries: 5,
        },
      );

      const checkpoint = service.getCheckpoint(guard.operationId);
      expect(checkpoint?.context).toEqual(context);
      expect(checkpoint?.correlationId).toBe('corr-001');
      expect(checkpoint?.maxRetries).toBe(5);
    });

    it('supports nested operations with parent tracking', async () => {
      const parentGuard = await service.createCheckpoint(
        OperationType.DATABASE_WRITE,
        'parent-op',
      );

      const childGuard = await service.createCheckpoint(
        OperationType.EXTERNAL_API,
        'child-op',
        {},
        { parentOperationId: parentGuard.operationId },
      );

      const childCheckpoint = service.getCheckpoint(childGuard.operationId);
      expect(childCheckpoint?.parentOperationId).toBe(parentGuard.operationId);
    });

    it('executes operation with automatic checkpointing', async () => {
      const operation = jest.fn().mockResolvedValue({ data: 'result' });

      const result = await service.executeWithCheckpoint(
        OperationType.HTTP_REQUEST,
        'auto-checkpoint-1',
        operation,
      );

      expect(result).toEqual({ data: 'result' });
      expect(operation).toHaveBeenCalledTimes(1);

      const checkpoint = service.getCheckpointByKey('auto-checkpoint-1');
      expect(checkpoint?.status).toBe(CheckpointStatus.COMPLETED);
    });
  });

  describe('Failure scenarios', () => {
    it('marks checkpoint as failed on operation error', async () => {
      const guard = await service.createCheckpoint(
        OperationType.WEBHOOK_DELIVERY,
        'webhook-fail',
      );

      const error = new Error('Network timeout');
      await service.failCheckpoint(guard.operationId, error);

      const checkpoint = service.getCheckpoint(guard.operationId);
      expect(checkpoint?.status).toBe(CheckpointStatus.FAILED);
      expect(checkpoint?.error).toBe('Network timeout');
    });

    it('handles checkpoint failure gracefully when operation not found', async () => {
      await expect(
        service.failCheckpoint('nonexistent', 'error'),
      ).resolves.not.toThrow();
    });

    it('handles checkpoint completion gracefully when operation not found', async () => {
      await expect(
        service.completeCheckpoint('nonexistent', {}),
      ).resolves.not.toThrow();
    });

    it('prevents execution when max retries exceeded', async () => {
      const idempotencyKey = 'retry-limit';
      
      // Create checkpoint with max 2 retries
      const guard1 = await service.createCheckpoint(
        OperationType.EXTERNAL_API,
        idempotencyKey,
        {},
        { maxRetries: 2 },
      );
      
      // Fail and set to IN_PROGRESS (simulating retry)
      const checkpoint = service.getCheckpoint(guard1.operationId);
      if (checkpoint) {
        checkpoint.retryCount = 2; // At max
        checkpoint.status = CheckpointStatus.IN_PROGRESS;
      }

      // Attempt retry
      const guard2 = await service.createCheckpoint(
        OperationType.EXTERNAL_API,
        idempotencyKey,
      );

      expect(guard2.canProceed).toBe(false);
      expect(guard2.reason).toBe('Max retries exceeded');
    });

    it('fails operation and prevents further retries after max attempts', async () => {
      const idempotencyKey = 'max-retries-fail';
      
      const guard1 = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        idempotencyKey,
        {},
        { maxRetries: 1 },
      );
      
      await service.failCheckpoint(guard1.operationId, 'First failure');
      
      // Set retry count to max
      const checkpoint = service.getCheckpoint(guard1.operationId);
      if (checkpoint) checkpoint.retryCount = 1;

      const guard2 = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        idempotencyKey,
      );

      expect(guard2.canProceed).toBe(false);
      expect(guard2.reason).toBe('Max retries exceeded after failure');
    });

    it('handles operation failure with automatic rollback', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('Operation failed'));
      const rollbackFn = jest.fn().mockResolvedValue(undefined);

      await expect(
        service.executeWithCheckpoint(
          OperationType.DATABASE_WRITE,
          'rollback-test',
          operation,
          { rollbackFn },
        ),
      ).rejects.toThrow('Operation failed');

      expect(rollbackFn).toHaveBeenCalled();

      const checkpoint = service.getCheckpointByKey('rollback-test');
      expect(checkpoint?.status).toBe(CheckpointStatus.ROLLED_BACK);
    });
  });

  describe('Retry logic with idempotency', () => {
    it('allows retry of failed operation', async () => {
      const idempotencyKey = 'retry-test';
      
      // First attempt fails
      const guard1 = await service.createCheckpoint(
        OperationType.EXTERNAL_API,
        idempotencyKey,
        {},
        { maxRetries: 3 },
      );
      await service.failCheckpoint(guard1.operationId, 'Temporary failure');

      // Retry attempt
      const guard2 = await service.createCheckpoint(
        OperationType.EXTERNAL_API,
        idempotencyKey,
      );

      expect(guard2.canProceed).toBe(true);
      expect(guard2.operationId).toBe(guard1.operationId); // Same operation

      const checkpoint = service.getCheckpoint(guard2.operationId);
      expect(checkpoint?.retryCount).toBe(1);
      expect(checkpoint?.status).toBe(CheckpointStatus.IN_PROGRESS);
    });

    it('increments retry count on each attempt', async () => {
      const idempotencyKey = 'retry-count';
      
      const guard1 = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        idempotencyKey,
        {},
        { maxRetries: 5 },
      );
      
      const checkpoint1 = service.getCheckpoint(guard1.operationId);
      expect(checkpoint1?.retryCount).toBe(0);

      // Simulate in-progress (for retry scenario)
      if (checkpoint1) checkpoint1.status = CheckpointStatus.IN_PROGRESS;

      const guard2 = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        idempotencyKey,
      );

      const checkpoint2 = service.getCheckpoint(guard2.operationId);
      expect(checkpoint2?.retryCount).toBe(1);
    });

    it('prevents duplicate completion for idempotent operations', async () => {
      const operation = jest.fn().mockResolvedValue({ value: 42 });

      // First execution
      const result1 = await service.executeWithCheckpoint(
        OperationType.PAYMENT_PROCESS,
        'idempotent-op',
        operation,
      );

      // Second execution with same key
      const result2 = await service.executeWithCheckpoint(
        OperationType.PAYMENT_PROCESS,
        'idempotent-op',
        operation,
      );

      expect(result1).toEqual({ value: 42 });
      expect(result2).toEqual({ value: 42 });
      expect(operation).toHaveBeenCalledTimes(1); // Only called once

      const stats = service.getStats();
      expect(stats.duplicatesPrevented).toBe(1);
    });
  });

  describe('Rollback operations', () => {
    it('executes compensating action on rollback', async () => {
      const compensatingFn = jest.fn().mockResolvedValue(undefined);

      const guard = await service.createCheckpoint(
        OperationType.DATABASE_WRITE,
        'rollback-comp',
      );

      await service.rollbackCheckpoint(guard.operationId, compensatingFn);

      expect(compensatingFn).toHaveBeenCalled();

      const checkpoint = service.getCheckpoint(guard.operationId);
      expect(checkpoint?.status).toBe(CheckpointStatus.ROLLED_BACK);
      expect(checkpoint?.rolledBackAt).toBeInstanceOf(Date);
    });

    it('logs error but continues if compensating action fails', async () => {
      const compensatingFn = jest
        .fn()
        .mockRejectedValue(new Error('Compensation failed'));

      const guard = await service.createCheckpoint(
        OperationType.EXTERNAL_API,
        'rollback-fail',
      );

      await expect(
        service.rollbackCheckpoint(guard.operationId, compensatingFn),
      ).rejects.toThrow('Compensation failed');

      // Checkpoint status should not be updated if compensation fails
      const checkpoint = service.getCheckpoint(guard.operationId);
      expect(checkpoint?.status).not.toBe(CheckpointStatus.ROLLED_BACK);
    });

    it('allows rollback without compensating action', async () => {
      const guard = await service.createCheckpoint(
        OperationType.FILE_WRITE,
        'rollback-no-comp',
      );

      await service.rollbackCheckpoint(guard.operationId);

      const checkpoint = service.getCheckpoint(guard.operationId);
      expect(checkpoint?.status).toBe(CheckpointStatus.ROLLED_BACK);
    });
  });

  describe('Recovery operations', () => {
    it('identifies incomplete checkpoints for recovery', async () => {
      // Create several checkpoints in different states
      const guard1 = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        'recover-1',
      );
      const guard2 = await service.createCheckpoint(
        OperationType.EXTERNAL_API,
        'recover-2',
      );
      const guard3 = await service.createCheckpoint(
        OperationType.DATABASE_WRITE,
        'recover-3',
      );

      await service.completeCheckpoint(guard3.operationId, {});

      const incomplete = await service.recoverCheckpoints();

      expect(incomplete).toHaveLength(2);
      expect(incomplete.map((c) => c.operationId)).toContain(guard1.operationId);
      expect(incomplete.map((c) => c.operationId)).toContain(guard2.operationId);
      expect(incomplete.map((c) => c.operationId)).not.toContain(guard3.operationId);
    });

    it('cleans up expired checkpoints', async () => {
      const guard = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        'expired-op',
        {},
        { ttlMs: 100 }, // 100ms TTL
      );

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 150));

      const cleaned = await service.cleanupExpiredCheckpoints();

      expect(cleaned).toBe(1);
      expect(service.getCheckpoint(guard.operationId)).toBeUndefined();
      expect(service.getCheckpointByKey('expired-op')).toBeUndefined();
    });

    it('does not clean up non-expired checkpoints', async () => {
      const guard = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        'active-op',
        {},
        { ttlMs: 60000 }, // 60 second TTL
      );

      const cleaned = await service.cleanupExpiredCheckpoints();

      expect(cleaned).toBe(0);
      expect(service.getCheckpoint(guard.operationId)).toBeDefined();
    });
  });

  describe('Checkpoint querying and filtering', () => {
    beforeEach(async () => {
      // Create checkpoints in various states
      const guard1 = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        'query-1',
        {},
        { correlationId: 'corr-001' },
      );
      await service.completeCheckpoint(guard1.operationId, {});

      const guard2 = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        'query-2',
        {},
        { correlationId: 'corr-001' },
      );
      await service.failCheckpoint(guard2.operationId, 'error');

      await service.createCheckpoint(
        OperationType.DATABASE_WRITE,
        'query-3',
        {},
        { correlationId: 'corr-002' },
      );
    });

    it('lists all checkpoints', () => {
      const checkpoints = service.listCheckpoints();
      expect(checkpoints.length).toBeGreaterThanOrEqual(3);
    });

    it('filters checkpoints by status', () => {
      const completed = service.listCheckpoints({
        status: CheckpointStatus.COMPLETED,
      });
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect(completed.every((c) => c.status === CheckpointStatus.COMPLETED)).toBe(true);
    });

    it('filters checkpoints by operation type', () => {
      const httpRequests = service.listCheckpoints({
        operationType: OperationType.HTTP_REQUEST,
      });
      expect(httpRequests.length).toBeGreaterThanOrEqual(2);
      expect(
        httpRequests.every((c) => c.operationType === OperationType.HTTP_REQUEST),
      ).toBe(true);
    });

    it('filters checkpoints by correlation ID', () => {
      const correlated = service.listCheckpoints({
        correlationId: 'corr-001',
      });
      expect(correlated).toHaveLength(2);
      expect(correlated.every((c) => c.correlationId === 'corr-001')).toBe(true);
    });

    it('limits number of returned checkpoints', () => {
      const limited = service.listCheckpoints({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it('retrieves checkpoint by idempotency key', () => {
      const checkpoint = service.getCheckpointByKey('query-1');
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.idempotencyKey).toBe('query-1');
    });
  });

  describe('Statistics and metrics', () => {
    beforeEach(async () => {
      // Create checkpoints in various states
      const guard1 = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        'stats-1',
      );
      await service.completeCheckpoint(guard1.operationId, {});

      const guard2 = await service.createCheckpoint(
        OperationType.EXTERNAL_API,
        'stats-2',
      );
      await service.failCheckpoint(guard2.operationId, 'error');

      await service.createCheckpoint(OperationType.DATABASE_WRITE, 'stats-3');

      const guard4 = await service.createCheckpoint(
        OperationType.FILE_WRITE,
        'stats-4',
      );
      await service.rollbackCheckpoint(guard4.operationId);
    });

    it('provides comprehensive statistics', () => {
      const stats = service.getStats();

      expect(stats.totalCheckpoints).toBeGreaterThanOrEqual(4);
      expect(stats.completedCheckpoints).toBeGreaterThanOrEqual(1);
      expect(stats.failedCheckpoints).toBeGreaterThanOrEqual(1);
      expect(stats.rolledBackCheckpoints).toBeGreaterThanOrEqual(1);
      expect(stats.avgCompletionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('tracks duplicates prevented', async () => {
      const operation = jest.fn().mockResolvedValue({ data: 'test' });

      await service.executeWithCheckpoint(
        OperationType.PAYMENT_PROCESS,
        'dup-track',
        operation,
      );
      await service.executeWithCheckpoint(
        OperationType.PAYMENT_PROCESS,
        'dup-track',
        operation,
      );
      await service.executeWithCheckpoint(
        OperationType.PAYMENT_PROCESS,
        'dup-track',
        operation,
      );

      const stats = service.getStats();
      expect(stats.duplicatesPrevented).toBeGreaterThanOrEqual(2);
    });

    it('calculates average completion time', async () => {
      const guard1 = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        'timing-1',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.completeCheckpoint(guard1.operationId, {});

      const guard2 = await service.createCheckpoint(
        OperationType.HTTP_REQUEST,
        'timing-2',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.completeCheckpoint(guard2.operationId, {});

      const stats = service.getStats();
      expect(stats.avgCompletionTimeMs).toBeGreaterThan(0);
    });
  });

  describe('Authorization patterns', () => {
    it('includes user context in checkpoint metadata', async () => {
      const guard = await service.createCheckpoint(
        OperationType.PAYMENT_PROCESS,
        'auth-test',
        {
          userId: 'user-123',
          role: 'admin',
          permissions: ['write', 'admin'],
        },
      );

      const checkpoint = service.getCheckpoint(guard.operationId);
      expect(checkpoint?.context.userId).toBe('user-123');
      expect(checkpoint?.context.role).toBe('admin');
    });

    it('supports request metadata for audit trails', async () => {
      const request = {
        method: 'POST',
        endpoint: '/api/payment',
        headers: { authorization: '[REDACTED]' },
        body: { amount: 100 },
      };

      const guard = await service.createCheckpoint(
        OperationType.PAYMENT_PROCESS,
        'audit-test',
        {},
        { request },
      );

      const checkpoint = service.getCheckpoint(guard.operationId);
      expect(checkpoint?.request).toEqual(request);
    });
  });
});

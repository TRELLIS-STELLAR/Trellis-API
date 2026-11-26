/**
 * Tests for cancellation and cleanup service covering:
 * - Normal cancellation flow
 * - Failure scenarios and error handling
 * - Retry logic for cleanup operations
 * - Authorization and access control
 */

import { Test, TestingModule } from '@nestjs/testing';
import { CancellationService } from './cancellation.service';
import { BackgroundWorkerService } from './background-worker.service';
import { JobStatus, JobPriority } from './worker.interface';

describe('CancellationService', () => {
  let service: CancellationService;
  let workerService: jest.Mocked<BackgroundWorkerService>;

  const mockJob = {
    id: 'job-123',
    type: 'test.operation',
    payload: { data: 'test' },
    priority: JobPriority.NORMAL,
    attempts: 0,
    maxAttempts: 3,
    backoffMs: 1000,
    status: JobStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    schemaVersion: '1.0.0',
  };

  beforeEach(async () => {
    const mockWorkerService = {
      getJob: jest.fn(),
      cancelJob: jest.fn(),
      acknowledgeCancel: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CancellationService,
        {
          provide: BackgroundWorkerService,
          useValue: mockWorkerService,
        },
      ],
    }).compile();

    service = module.get<CancellationService>(CancellationService);
    workerService = module.get(BackgroundWorkerService);
  });

  describe('Normal cancellation flow', () => {
    it('successfully requests cancellation for an active job', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      const result = await service.requestCancellation('job-123', 'User requested');

      expect(result).toBe(true);
      expect(workerService.cancelJob).toHaveBeenCalledWith('job-123');
      expect(service.shouldCancel('job-123')).toBe(true);
    });

    it('tracks cancellation in audit log', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      await service.requestCancellation('job-123', 'Test reason', 'user-456');

      const audit = service.getCancellationAudit('job-123');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        jobId: 'job-123',
        jobType: 'test.operation',
        requestedBy: 'user-456',
        status: 'requested',
      });
      expect(audit[0].requestedAt).toBeInstanceOf(Date);
    });

    it('allows workers to check cancellation status', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      await service.requestCancellation('job-123');
      
      expect(service.shouldCancel('job-123')).toBe(true);
      expect(service.shouldCancel('job-456')).toBe(false);
    });

    it('acknowledges cancellation and performs cleanup', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      await service.requestCancellation('job-123');
      await service.acknowledgeCancellation('job-123');

      expect(workerService.acknowledgeCancel).toHaveBeenCalledWith('job-123');
      
      const audit = service.getCancellationAudit('job-123');
      expect(audit[0].status).toBe('completed');
      expect(audit[0].acknowledgedAt).toBeInstanceOf(Date);
      expect(audit[0].cleanupCompletedAt).toBeInstanceOf(Date);
    });

    it('cleans up registered resources', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      const mockResource = {
        close: jest.fn().mockResolvedValue(undefined),
      };

      service.registerResource('job-123', 'resource-1', mockResource);
      
      await service.requestCancellation('job-123');
      await service.acknowledgeCancellation('job-123');

      expect(mockResource.close).toHaveBeenCalled();
    });

    it('executes rollback actions in reverse order', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      const executionOrder: number[] = [];
      
      service.registerRollback('job-123', async () => { executionOrder.push(1); });
      service.registerRollback('job-123', async () => { executionOrder.push(2); });
      service.registerRollback('job-123', async () => { executionOrder.push(3); });

      await service.requestCancellation('job-123');
      await service.acknowledgeCancellation('job-123');

      // Should execute in reverse order: 3, 2, 1
      expect(executionOrder).toEqual([3, 2, 1]);
    });
  });

  describe('Failure scenarios', () => {
    it('returns false when job not found', async () => {
      workerService.getJob.mockResolvedValue(undefined);

      const result = await service.requestCancellation('nonexistent');

      expect(result).toBe(false);
      expect(workerService.cancelJob).not.toHaveBeenCalled();
    });

    it('returns false when job is already completed', async () => {
      const completedJob = { ...mockJob, status: JobStatus.COMPLETED };
      workerService.getJob.mockResolvedValue(completedJob);

      const result = await service.requestCancellation('job-123');

      expect(result).toBe(false);
      expect(workerService.cancelJob).not.toHaveBeenCalled();
    });

    it('returns false when job is already cancelled', async () => {
      const cancelledJob = { ...mockJob, status: JobStatus.CANCELLED };
      workerService.getJob.mockResolvedValue(cancelledJob);

      const result = await service.requestCancellation('job-123');

      expect(result).toBe(false);
    });

    it('handles idempotent cancellation requests', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      await service.requestCancellation('job-123');
      const result = await service.requestCancellation('job-123');

      expect(result).toBe(true);
      expect(workerService.cancelJob).toHaveBeenCalledTimes(1);
    });

    it('continues cleanup when rollback action fails', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      const executionOrder: string[] = [];
      
      service.registerRollback('job-123', async () => {
        executionOrder.push('rollback-1');
      });
      service.registerRollback('job-123', async () => {
        executionOrder.push('rollback-2-fail');
        throw new Error('Rollback failed');
      });
      service.registerRollback('job-123', async () => {
        executionOrder.push('rollback-3');
      });

      await service.requestCancellation('job-123');
      await service.acknowledgeCancellation('job-123');

      // All rollbacks should be attempted despite failure
      expect(executionOrder).toContain('rollback-1');
      expect(executionOrder).toContain('rollback-2-fail');
      expect(executionOrder).toContain('rollback-3');
    });

    it('continues cleanup when resource cleanup fails', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      const mockResource1 = {
        close: jest.fn().mockRejectedValue(new Error('Close failed')),
      };
      const mockResource2 = {
        close: jest.fn().mockResolvedValue(undefined),
      };

      service.registerResource('job-123', 'resource-1', mockResource1);
      service.registerResource('job-123', 'resource-2', mockResource2);

      await service.requestCancellation('job-123');
      await service.acknowledgeCancellation('job-123');

      // Both cleanup attempts should be made
      expect(mockResource1.close).toHaveBeenCalled();
      expect(mockResource2.close).toHaveBeenCalled();
    });

    it('handles resources with different cleanup methods', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      const resourceWithClose = { close: jest.fn().mockResolvedValue(undefined) };
      const resourceWithDestroy = { destroy: jest.fn().mockResolvedValue(undefined) };
      const resourceWithRelease = { release: jest.fn().mockResolvedValue(undefined) };
      const resourceWithEnd = { end: jest.fn().mockResolvedValue(undefined) };

      service.registerResource('job-123', 'res-1', resourceWithClose);
      service.registerResource('job-123', 'res-2', resourceWithDestroy);
      service.registerResource('job-123', 'res-3', resourceWithRelease);
      service.registerResource('job-123', 'res-4', resourceWithEnd);

      await service.requestCancellation('job-123');
      await service.acknowledgeCancellation('job-123');

      expect(resourceWithClose.close).toHaveBeenCalled();
      expect(resourceWithDestroy.destroy).toHaveBeenCalled();
      expect(resourceWithRelease.release).toHaveBeenCalled();
      expect(resourceWithEnd.end).toHaveBeenCalled();
    });
  });

  describe('Retry and timeout handling', () => {
    it('schedules forced cleanup after timeout', async () => {
      jest.useFakeTimers();
      
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      const mockResource = {
        close: jest.fn().mockResolvedValue(undefined),
      };
      
      service.registerResource('job-123', 'resource-1', mockResource);

      await service.requestCancellation('job-123');
      
      // Fast-forward past cleanup timeout (30 seconds)
      jest.advanceTimersByTime(31000);
      await Promise.resolve(); // Allow async operations to complete

      expect(mockResource.close).toHaveBeenCalled();
      
      jest.useRealTimers();
    });

    it('does not force cleanup if already acknowledged', async () => {
      jest.useFakeTimers();
      
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      const mockResource = {
        close: jest.fn().mockResolvedValue(undefined),
      };
      
      service.registerResource('job-123', 'resource-1', mockResource);

      await service.requestCancellation('job-123');
      await service.acknowledgeCancellation('job-123');
      
      mockResource.close.mockClear();

      // Fast-forward past cleanup timeout
      jest.advanceTimersByTime(31000);
      await Promise.resolve();

      // Should not cleanup again
      expect(mockResource.close).not.toHaveBeenCalled();
      
      jest.useRealTimers();
    });
  });

  describe('Authorization and audit', () => {
    it('records cancellation requester in audit log', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      await service.requestCancellation('job-123', 'Admin intervention', 'admin-user');

      const audit = service.getCancellationAudit('job-123');
      expect(audit[0].requestedBy).toBe('admin-user');
    });

    it('provides audit trail for all cancellations', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      await service.requestCancellation('job-1', 'Reason 1', 'user-1');
      await service.requestCancellation('job-2', 'Reason 2', 'user-2');

      const allAudits = service.getAllCancellationAudits();
      expect(allAudits).toHaveLength(2);
      expect(allAudits.map((a) => a.jobId)).toEqual(['job-1', 'job-2']);
    });

    it('tracks cancellation lifecycle in audit entries', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      await service.requestCancellation('job-123');
      
      let audit = service.getCancellationAudit('job-123');
      expect(audit[0].status).toBe('requested');
      expect(audit[0].requestedAt).toBeInstanceOf(Date);
      expect(audit[0].acknowledgedAt).toBeUndefined();

      await service.acknowledgeCancellation('job-123');
      
      audit = service.getCancellationAudit('job-123');
      expect(audit[0].status).toBe('completed');
      expect(audit[0].acknowledgedAt).toBeInstanceOf(Date);
      expect(audit[0].cleanupCompletedAt).toBeInstanceOf(Date);
    });
  });

  describe('Metrics', () => {
    it('provides cancellation metrics', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      await service.requestCancellation('job-1');
      await service.acknowledgeCancellation('job-1');

      await service.requestCancellation('job-2');

      const metrics = service.getMetrics();

      expect(metrics.total).toBe(2);
      expect(metrics.completed).toBe(1);
      expect(metrics.pending).toBe(1);
      expect(metrics.successRate).toBe(50);
      expect(metrics.avgAcknowledgeTimeMs).toBeGreaterThan(0);
    });

    it('tracks active cleanup contexts', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      service.registerResource('job-1', 'res-1', {});
      service.registerResource('job-2', 'res-2', {});

      const metrics = service.getMetrics();
      expect(metrics.activeCleanupContexts).toBe(2);
    });

    it('calculates average cleanup time', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      await service.requestCancellation('job-1');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.acknowledgeCancellation('job-1');

      await service.requestCancellation('job-2');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.acknowledgeCancellation('job-2');

      const metrics = service.getMetrics();
      expect(metrics.avgCleanupTimeMs).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('handles acknowledgement without prior cancellation request', async () => {
      await service.acknowledgeCancellation('job-999');

      // Should not throw, but log warning
      expect(workerService.acknowledgeCancel).not.toHaveBeenCalled();
    });

    it('handles resource registration for nonexistent job', async () => {
      workerService.getJob.mockResolvedValue(undefined);

      expect(() => {
        service.registerResource('nonexistent', 'res-1', {});
      }).toThrow('job nonexistent not found');
    });

    it('handles rollback registration for nonexistent job', async () => {
      workerService.getJob.mockResolvedValue(undefined);

      expect(() => {
        service.registerRollback('nonexistent', async () => {});
      }).toThrow('job nonexistent not found');
    });

    it('handles resources without cleanup methods gracefully', async () => {
      workerService.getJob.mockResolvedValue(mockJob);
      workerService.cancelJob.mockResolvedValue(true);

      const resourceWithoutCleanup = { data: 'test' };
      
      service.registerResource('job-123', 'res-1', resourceWithoutCleanup);

      await service.requestCancellation('job-123');
      
      // Should not throw
      await expect(service.acknowledgeCancellation('job-123')).resolves.not.toThrow();
    });
  });
});

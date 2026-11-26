/**
 * Cancellation and cleanup service for long-running operations.
 *
 * Provides comprehensive cancellation support with:
 * - Cooperative cancellation for active operations
 * - Timeout-based forced termination
 * - Resource cleanup and rollback
 * - Idempotent cancellation operations
 * - Audit trail for cancellation events
 */

import { Injectable, Logger } from '@nestjs/common';
import { JobStatus, WorkerJob, JobCleanupFn } from './worker.interface';
import { BackgroundWorkerService } from './background-worker.service';

export interface CancellationToken {
  isCancelled: boolean;
  reason?: string;
  requestedAt?: Date;
  acknowledgedAt?: Date;
}

export interface CleanupContext {
  job: WorkerJob;
  resources: Map<string, any>;
  rollbackActions: Array<() => Promise<void>>;
}

export interface CancellationAuditEntry {
  jobId: string;
  jobType: string;
  requestedBy?: string;
  requestedAt: Date;
  acknowledgedAt?: Date;
  cleanupCompletedAt?: Date;
  status: 'requested' | 'acknowledged' | 'completed' | 'failed';
  error?: string;
}

@Injectable()
export class CancellationService {
  private readonly logger = new Logger(CancellationService.name);
  private readonly cancellationTokens = new Map<string, CancellationToken>();
  private readonly cleanupContexts = new Map<string, CleanupContext>();
  private readonly auditLog: CancellationAuditEntry[] = [];
  private readonly cleanupTimeoutMs = 30000; // 30 seconds

  constructor(private readonly workerService: BackgroundWorkerService) {}

  /**
   * Request cancellation of a long-running operation.
   * 
   * @param jobId - The job identifier
   * @param reason - Human-readable cancellation reason
   * @param requestedBy - User or system initiating cancellation
   * @returns true if cancellation was initiated, false if job is already terminal
   */
  async requestCancellation(
    jobId: string,
    reason = 'User requested cancellation',
    requestedBy?: string,
  ): Promise<boolean> {
    const job = await this.workerService.getJob(jobId);
    
    if (!job) {
      this.logger.warn(`Cannot cancel job ${jobId}: job not found`);
      return false;
    }

    // Check if already cancelled or completed
    if (this.isTerminalStatus(job.status)) {
      this.logger.warn(`Cannot cancel job ${jobId}: already in terminal status ${job.status}`);
      return false;
    }

    // Check if cancellation already requested
    if (this.cancellationTokens.has(jobId)) {
      this.logger.debug(`Cancellation already requested for job ${jobId}`);
      return true;
    }

    const now = new Date();
    
    // Create cancellation token
    const token: CancellationToken = {
      isCancelled: true,
      reason,
      requestedAt: now,
    };
    
    this.cancellationTokens.set(jobId, token);

    // Log audit entry
    this.auditLog.push({
      jobId,
      jobType: job.type,
      requestedBy,
      requestedAt: now,
      status: 'requested',
    });

    // Request cancellation through worker service
    const cancelled = await this.workerService.cancelJob(jobId);

    if (cancelled) {
      this.logger.log(`Cancellation requested for job ${jobId}: ${reason}`);
      
      // Set timeout for forced cleanup if cooperative cancellation fails
      this.scheduleForceCleanup(jobId);
    }

    return cancelled;
  }

  /**
   * Check if an operation should be cancelled.
   * Workers should call this periodically during long operations.
   * 
   * @param jobId - The job identifier
   * @returns true if cancellation has been requested
   */
  shouldCancel(jobId: string): boolean {
    const token = this.cancellationTokens.get(jobId);
    return token?.isCancelled ?? false;
  }

  /**
   * Acknowledge cancellation and perform cleanup.
   * Workers call this after detecting cancellation and stopping their work.
   * 
   * @param jobId - The job identifier
   */
  async acknowledgeCancellation(jobId: string): Promise<void> {
    const token = this.cancellationTokens.get(jobId);
    
    if (!token) {
      this.logger.warn(`No cancellation token found for job ${jobId}`);
      return;
    }

    const now = new Date();
    token.acknowledgedAt = now;

    // Update audit log
    const auditEntry = this.auditLog.find((e) => e.jobId === jobId && e.status === 'requested');
    if (auditEntry) {
      auditEntry.acknowledgedAt = now;
      auditEntry.status = 'acknowledged';
    }

    // Acknowledge through worker service
    await this.workerService.acknowledgeCancel(jobId);

    // Perform cleanup
    await this.performCleanup(jobId);

    this.logger.log(`Cancellation acknowledged for job ${jobId}`);
  }

  /**
   * Register a resource for cleanup when a job is cancelled.
   * 
   * @param jobId - The job identifier
   * @param resourceId - Unique identifier for the resource
   * @param resource - The resource object (file handle, connection, etc.)
   */
  registerResource(jobId: string, resourceId: string, resource: any): void {
    let context = this.cleanupContexts.get(jobId);
    
    if (!context) {
      const job = this.workerService.getJob(jobId);
      if (!job) {
        throw new Error(`Cannot register resource: job ${jobId} not found`);
      }
      
      context = {
        job: job as any,
        resources: new Map(),
        rollbackActions: [],
      };
      
      this.cleanupContexts.set(jobId, context);
    }

    context.resources.set(resourceId, resource);
    this.logger.debug(`Registered resource ${resourceId} for job ${jobId}`);
  }

  /**
   * Register a rollback action to be executed on cancellation.
   * 
   * @param jobId - The job identifier
   * @param rollbackFn - Async function that performs rollback
   */
  registerRollback(jobId: string, rollbackFn: () => Promise<void>): void {
    let context = this.cleanupContexts.get(jobId);
    
    if (!context) {
      const job = this.workerService.getJob(jobId);
      if (!job) {
        throw new Error(`Cannot register rollback: job ${jobId} not found`);
      }
      
      context = {
        job: job as any,
        resources: new Map(),
        rollbackActions: [],
      };
      
      this.cleanupContexts.set(jobId, context);
    }

    context.rollbackActions.push(rollbackFn);
    this.logger.debug(`Registered rollback action for job ${jobId}`);
  }

  /**
   * Perform cleanup for a cancelled job.
   * Releases resources and executes rollback actions.
   */
  private async performCleanup(jobId: string): Promise<void> {
    const context = this.cleanupContexts.get(jobId);
    
    if (!context) {
      this.logger.debug(`No cleanup context for job ${jobId}`);
      return;
    }

    const auditEntry = this.auditLog.find((e) => e.jobId === jobId);
    
    try {
      // Execute rollback actions in reverse order
      for (let i = context.rollbackActions.length - 1; i >= 0; i--) {
        const rollbackFn = context.rollbackActions[i];
        try {
          await rollbackFn();
          this.logger.debug(`Executed rollback action ${i + 1}/${context.rollbackActions.length} for job ${jobId}`);
        } catch (error) {
          this.logger.error(
            `Rollback action ${i + 1} failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Continue with other rollback actions
        }
      }

      // Clean up resources
      for (const [resourceId, resource] of context.resources.entries()) {
        try {
          await this.cleanupResource(resourceId, resource);
          this.logger.debug(`Cleaned up resource ${resourceId} for job ${jobId}`);
        } catch (error) {
          this.logger.error(
            `Failed to cleanup resource ${resourceId} for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Clear context
      this.cleanupContexts.delete(jobId);
      this.cancellationTokens.delete(jobId);

      if (auditEntry) {
        auditEntry.cleanupCompletedAt = new Date();
        auditEntry.status = 'completed';
      }

      this.logger.log(`Cleanup completed for job ${jobId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Cleanup failed for job ${jobId}: ${errorMsg}`);
      
      if (auditEntry) {
        auditEntry.error = errorMsg;
        auditEntry.status = 'failed';
      }
      
      throw error;
    }
  }

  /**
   * Schedule forced cleanup if cooperative cancellation doesn't complete in time.
   */
  private scheduleForceCleanup(jobId: string): void {
    setTimeout(async () => {
      const token = this.cancellationTokens.get(jobId);
      
      // If still not acknowledged, force cleanup
      if (token && !token.acknowledgedAt) {
        this.logger.warn(`Forced cleanup for job ${jobId} after timeout`);
        await this.performCleanup(jobId);
      }
    }, this.cleanupTimeoutMs);
  }

  /**
   * Clean up a specific resource based on its type.
   */
  private async cleanupResource(resourceId: string, resource: any): Promise<void> {
    // Handle common resource types
    if (resource && typeof resource.close === 'function') {
      await resource.close();
    } else if (resource && typeof resource.destroy === 'function') {
      await resource.destroy();
    } else if (resource && typeof resource.release === 'function') {
      await resource.release();
    } else if (resource && typeof resource.end === 'function') {
      await resource.end();
    }
    // Resource types without cleanup method are ignored
  }

  /**
   * Check if a job status is terminal (cannot be cancelled).
   */
  private isTerminalStatus(status: JobStatus): boolean {
    return [
      JobStatus.COMPLETED,
      JobStatus.CANCELLED,
      JobStatus.DEAD_LETTER,
    ].includes(status);
  }

  /**
   * Get cancellation audit log for a job.
   */
  getCancellationAudit(jobId: string): CancellationAuditEntry[] {
    return this.auditLog.filter((entry) => entry.jobId === jobId);
  }

  /**
   * Get all cancellation audit entries.
   */
  getAllCancellationAudits(): CancellationAuditEntry[] {
    return [...this.auditLog];
  }

  /**
   * Get cancellation metrics.
   */
  getMetrics() {
    const total = this.auditLog.length;
    const completed = this.auditLog.filter((e) => e.status === 'completed').length;
    const failed = this.auditLog.filter((e) => e.status === 'failed').length;
    const pending = this.auditLog.filter((e) => e.status === 'requested' || e.status === 'acknowledged').length;

    const avgAcknowledgeTime = this.calculateAverageTime(
      this.auditLog.filter((e) => e.acknowledgedAt),
      (e) => e.acknowledgedAt!.getTime() - e.requestedAt.getTime(),
    );

    const avgCleanupTime = this.calculateAverageTime(
      this.auditLog.filter((e) => e.cleanupCompletedAt && e.acknowledgedAt),
      (e) => e.cleanupCompletedAt!.getTime() - e.acknowledgedAt!.getTime(),
    );

    return {
      total,
      completed,
      failed,
      pending,
      successRate: total > 0 ? (completed / total) * 100 : 0,
      avgAcknowledgeTimeMs: avgAcknowledgeTime,
      avgCleanupTimeMs: avgCleanupTime,
      activeCleanupContexts: this.cleanupContexts.size,
      activeCancellationTokens: this.cancellationTokens.size,
    };
  }

  private calculateAverageTime(
    entries: CancellationAuditEntry[],
    timeFn: (entry: CancellationAuditEntry) => number,
  ): number {
    if (entries.length === 0) return 0;
    const sum = entries.reduce((acc, entry) => acc + timeFn(entry), 0);
    return sum / entries.length;
  }
}

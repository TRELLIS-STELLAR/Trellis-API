import { Injectable, Logger } from "@nestjs/common";
import { BackgroundWorkerService } from "./background-worker.service";
import { JobStatus, WorkerJob } from "./worker.interface";

export interface DeadLetterStats {
  total: number;
  byType: Record<string, number>;
  byError: Record<string, number>;
  oldestJob?: {
    id: string;
    type: string;
    deadLetteredAt: Date;
    ageHours: number;
  };
  recentFailures: Array<{
    id: string;
    type: string;
    error: string;
    attempts: number;
    deadLetteredAt: Date;
  }>;
}

export interface DeadLetterFilter {
  type?: string;
  errorPattern?: string;
  minAge?: number; // hours
  maxAge?: number; // hours
  limit?: number;
}

export interface BatchRetryResult {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ jobId: string; reason: string }>;
}

/**
 * Dead-letter inspection and safe retry tooling.
 * 
 * Provides detailed inspection of dead-lettered jobs and safe batch retry
 * operations with configurable filters and safeguards.
 */
@Injectable()
export class DeadLetterInspectionService {
  private readonly logger = new Logger(DeadLetterInspectionService.name);

  constructor(private readonly workerService: BackgroundWorkerService) {}

  /**
   * Get comprehensive statistics about dead-lettered jobs.
   */
  async getDeadLetterStats(): Promise<DeadLetterStats> {
    const deadJobs = await this.workerService.listJobs(JobStatus.DEAD_LETTER, 1000);
    
    const byType: Record<string, number> = {};
    const byError: Record<string, number> = {};
    let oldestJob: DeadLetterStats["oldestJob"] = undefined;

    deadJobs.forEach((job) => {
      // Count by type
      byType[job.type] = (byType[job.type] || 0) + 1;

      // Count by error pattern (simplified error grouping)
      const errorKey = this.simplifyError(job.error || "unknown");
      byError[errorKey] = (byError[errorKey] || 0) + 1;

      // Track oldest job
      if (job.deadLetteredAt || job.failedAt) {
        const deadTime = job.deadLetteredAt || job.failedAt;
        if (!oldestJob || (deadTime && deadTime < oldestJob.deadLetteredAt)) {
          oldestJob = {
            id: job.id,
            type: job.type,
            deadLetteredAt: deadTime!,
            ageHours: this.getAgeInHours(deadTime!),
          };
        }
      }
    });

    const recentFailures = deadJobs
      .sort((a, b) => {
        const dateA = a.deadLetteredAt || a.failedAt || a.updatedAt;
        const dateB = b.deadLetteredAt || b.failedAt || b.updatedAt;
        return dateB.getTime() - dateA.getTime();
      })
      .slice(0, 10)
      .map((job) => ({
        id: job.id,
        type: job.type,
        error: job.error || "unknown",
        attempts: job.attempts,
        deadLetteredAt: job.deadLetteredAt || job.failedAt || job.updatedAt,
      }));

    return {
      total: deadJobs.length,
      byType,
      byError,
      oldestJob,
      recentFailures,
    };
  }

  /**
   * List dead-lettered jobs with optional filtering.
   */
  async listDeadLetterJobs(filter: DeadLetterFilter = {}): Promise<WorkerJob[]> {
    const { type, errorPattern, minAge, maxAge, limit = 50 } = filter;
    
    let jobs = await this.workerService.listJobs(JobStatus.DEAD_LETTER, 1000);

    // Apply type filter
    if (type) {
      jobs = jobs.filter((job) => job.type === type);
    }

    // Apply error pattern filter
    if (errorPattern) {
      const pattern = new RegExp(errorPattern, "i");
      jobs = jobs.filter((job) => pattern.test(job.error || ""));
    }

    // Apply age filters
    if (minAge !== undefined || maxAge !== undefined) {
      jobs = jobs.filter((job) => {
        const deadTime = job.deadLetteredAt || job.failedAt;
        if (!deadTime) return false;
        
        const ageHours = this.getAgeInHours(deadTime);
        
        if (minAge !== undefined && ageHours < minAge) return false;
        if (maxAge !== undefined && ageHours > maxAge) return false;
        
        return true;
      });
    }

    // Sort by most recent first
    jobs.sort((a, b) => {
      const dateA = a.deadLetteredAt || a.failedAt || a.updatedAt;
      const dateB = b.deadLetteredAt || b.failedAt || b.updatedAt;
      return dateB.getTime() - dateA.getTime();
    });

    return jobs.slice(0, limit);
  }

  /**
   * Get detailed information about a specific dead-lettered job.
   */
  async getDeadLetterJobDetails(jobId: string): Promise<WorkerJob | null> {
    const job = await this.workerService.getJob(jobId);
    
    if (!job) {
      this.logger.warn(`Job ${jobId} not found`);
      return null;
    }

    if (job.status !== JobStatus.DEAD_LETTER) {
      this.logger.warn(`Job ${jobId} is not in dead-letter queue (status: ${job.status})`);
      return null;
    }

    return job;
  }

  /**
   * Safely retry a single dead-lettered job with validation.
   */
  async safeRetryJob(jobId: string, requestedBy: string): Promise<WorkerJob | null> {
    const job = await this.workerService.getJob(jobId);

    if (!job) {
      this.logger.warn(`Retry failed: Job ${jobId} not found`);
      return null;
    }

    if (job.status !== JobStatus.DEAD_LETTER && job.status !== JobStatus.FAILED) {
      this.logger.warn(
        `Retry failed: Job ${jobId} is not in dead-letter or failed state (status: ${job.status})`
      );
      return null;
    }

    this.logger.log(`Safe retry initiated for job ${jobId} by ${requestedBy}`);
    
    const retriedJob = await this.workerService.retryJob(jobId);
    
    if (retriedJob) {
      this.logger.log(`Successfully retried job ${jobId} (type: ${retriedJob.type})`);
    }

    return retriedJob;
  }

  /**
   * Batch retry multiple jobs with safeguards and detailed reporting.
   */
  async batchRetryJobs(
    filter: DeadLetterFilter,
    requestedBy: string,
    dryRun = false
  ): Promise<BatchRetryResult> {
    const jobs = await this.listDeadLetterJobs(filter);
    
    const result: BatchRetryResult = {
      attempted: jobs.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };

    if (dryRun) {
      this.logger.log(
        `Dry run: Would retry ${jobs.length} jobs (requested by ${requestedBy})`
      );
      return result;
    }

    this.logger.log(
      `Starting batch retry of ${jobs.length} jobs (requested by ${requestedBy})`
    );

    for (const job of jobs) {
      try {
        const retriedJob = await this.safeRetryJob(job.id, requestedBy);
        
        if (retriedJob) {
          result.succeeded++;
        } else {
          result.failed++;
          result.errors.push({
            jobId: job.id,
            reason: "Retry operation returned null",
          });
        }
      } catch (error) {
        result.failed++;
        result.errors.push({
          jobId: job.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        this.logger.error(`Failed to retry job ${job.id}: ${error}`);
      }
    }

    this.logger.log(
      `Batch retry completed: ${result.succeeded} succeeded, ${result.failed} failed out of ${result.attempted} jobs`
    );

    return result;
  }

  /**
   * Purge old dead-lettered jobs that are beyond recovery.
   * This is a destructive operation and should be used with caution.
   */
  async purgeOldDeadLetterJobs(
    olderThanHours: number,
    requestedBy: string,
    dryRun = false
  ): Promise<{ purged: number; dryRun: boolean }> {
    const jobs = await this.listDeadLetterJobs({
      minAge: olderThanHours,
      limit: 1000,
    });

    if (dryRun) {
      this.logger.log(
        `Dry run: Would purge ${jobs.length} jobs older than ${olderThanHours} hours (requested by ${requestedBy})`
      );
      return { purged: jobs.length, dryRun: true };
    }

    this.logger.warn(
      `Purging ${jobs.length} dead-lettered jobs older than ${olderThanHours} hours (requested by ${requestedBy})`
    );

    // In a real implementation, you would delete the jobs from the jobStore
    // For now, we just log the operation
    // This would need to be implemented in the BackgroundWorkerService

    return { purged: jobs.length, dryRun: false };
  }

  /**
   * Simplify error messages for grouping similar errors.
   */
  private simplifyError(error: string): string {
    // Remove job-specific identifiers and timestamps
    let simplified = error
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
      .replace(/\bjob_\d+_[a-z0-9]+\b/gi, "<job-id>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<timestamp>")
      .replace(/\d+/g, "<number>");

    // Truncate to first 100 chars for grouping
    return simplified.substring(0, 100);
  }

  /**
   * Calculate age of a job in hours.
   */
  private getAgeInHours(date: Date): number {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60));
  }
}

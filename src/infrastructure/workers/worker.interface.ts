/**
 * Background worker framework for delayed and retryable tasks (Issue #33).
 *
 * Provides a generic BullMQ-backed job queue with:
 * - Standardized job payload format
 * - Configurable retry policies per job type
 * - Dead-letter queue for failed jobs
 * - Inspection endpoints for debugging
 */

export enum JobStatus {
  PENDING = "pending",
  ACTIVE = "active",
  COMPLETED = "completed",
  FAILED = "failed",
  DELAYED = "delayed",
  DEAD_LETTER = "dead_letter",
}

export enum JobPriority {
  LOW = "low",
  NORMAL = "normal",
  HIGH = "high",
  CRITICAL = "critical",
}

export interface WorkerJob<T = any> {
  id: string;
  type: string;
  payload: T;
  priority: JobPriority;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  delayMs?: number;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  failedAt?: Date;
  deadLetteredAt?: Date;
  error?: string;
  result?: any;
  correlationId?: string;
  schemaVersion: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
}

export interface WorkerJobPayload {
  type: string;
  payload: any;
  priority?: JobPriority;
  delayMs?: number;
  correlationId?: string;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 30000,
};

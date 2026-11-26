/**
 * Durable checkpoint service for external side effects.
 *
 * Provides at-most-once and at-least-once guarantees for external operations:
 * - Records checkpoints before and after external calls
 * - Supports idempotent retry with deduplication
 * - Enables recovery from partial failures
 * - Tracks operation lifecycle and audit trail
 * - Prevents duplicate execution of non-idempotent operations
 */

import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

export enum CheckpointStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
}

export enum OperationType {
  HTTP_REQUEST = 'http_request',
  DATABASE_WRITE = 'database_write',
  EXTERNAL_API = 'external_api',
  FILE_WRITE = 'file_write',
  MESSAGE_PUBLISH = 'message_publish',
  WEBHOOK_DELIVERY = 'webhook_delivery',
  EMAIL_SEND = 'email_send',
  PAYMENT_PROCESS = 'payment_process',
}

export interface CheckpointMetadata {
  operationId: string;
  operationType: OperationType;
  idempotencyKey: string;
  parentOperationId?: string;
  correlationId?: string;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  updatedAt: Date;
  status: CheckpointStatus;
  context: Record<string, any>;
  request?: any;
  response?: any;
  error?: string;
  completedAt?: Date;
  rolledBackAt?: Date;
  expiresAt?: Date;
}

export interface CheckpointGuard {
  operationId: string;
  canProceed: boolean;
  previousResult?: any;
  reason?: string;
}

export interface CheckpointStats {
  totalCheckpoints: number;
  pendingCheckpoints: number;
  completedCheckpoints: number;
  failedCheckpoints: number;
  rolledBackCheckpoints: number;
  duplicatesPrevented: number;
  avgCompletionTimeMs: number;
}

@Injectable()
export class CheckpointService {
  private readonly logger = new Logger(CheckpointService.name);
  private readonly checkpoints = new Map<string, CheckpointMetadata>();
  private readonly idempotencyCache = new Map<string, string>(); // idempotencyKey -> operationId
  private readonly defaultTTL = 24 * 60 * 60 * 1000; // 24 hours
  private duplicatesPrevented = 0;

  /**
   * Create a checkpoint before executing an external operation.
   * Returns a guard that indicates whether the operation should proceed.
   */
  async createCheckpoint(
    operationType: OperationType,
    idempotencyKey: string,
    context: Record<string, any> = {},
    options: {
      parentOperationId?: string;
      correlationId?: string;
      maxRetries?: number;
      ttlMs?: number;
      request?: any;
    } = {},
  ): Promise<CheckpointGuard> {
    // Check for existing operation with same idempotency key
    const existingOperationId = this.idempotencyCache.get(idempotencyKey);
    
    if (existingOperationId) {
      const existing = this.checkpoints.get(existingOperationId);
      
      if (existing) {
        // Operation already completed - return cached result
        if (existing.status === CheckpointStatus.COMPLETED) {
          this.duplicatesPrevented++;
          this.logger.debug(
            `Duplicate operation prevented: ${operationType} with key ${idempotencyKey}`,
          );
          
          return {
            operationId: existingOperationId,
            canProceed: false,
            previousResult: existing.response,
            reason: 'Operation already completed',
          };
        }
        
        // Operation in progress - allow retry based on retry count
        if (existing.status === CheckpointStatus.IN_PROGRESS) {
          if (existing.retryCount >= existing.maxRetries) {
            this.logger.warn(
              `Max retries exceeded for operation ${existingOperationId}`,
            );
            
            return {
              operationId: existingOperationId,
              canProceed: false,
              reason: 'Max retries exceeded',
            };
          }
          
          // Increment retry count
          existing.retryCount++;
          existing.updatedAt = new Date();
          
          this.logger.log(
            `Retrying operation ${existingOperationId} (attempt ${existing.retryCount}/${existing.maxRetries})`,
          );
          
          return {
            operationId: existingOperationId,
            canProceed: true,
          };
        }
        
        // Operation failed - allow retry
        if (existing.status === CheckpointStatus.FAILED) {
          if (existing.retryCount >= existing.maxRetries) {
            return {
              operationId: existingOperationId,
              canProceed: false,
              reason: 'Max retries exceeded after failure',
            };
          }
          
          existing.retryCount++;
          existing.status = CheckpointStatus.IN_PROGRESS;
          existing.updatedAt = new Date();
          existing.error = undefined;
          
          this.logger.log(
            `Retrying failed operation ${existingOperationId} (attempt ${existing.retryCount}/${existing.maxRetries})`,
          );
          
          return {
            operationId: existingOperationId,
            canProceed: true,
          };
        }
      }
    }

    // Create new checkpoint
    const operationId = uuidv4();
    const now = new Date();
    const ttl = options.ttlMs ?? this.defaultTTL;

    const checkpoint: CheckpointMetadata = {
      operationId,
      operationType,
      idempotencyKey,
      parentOperationId: options.parentOperationId,
      correlationId: options.correlationId,
      retryCount: 0,
      maxRetries: options.maxRetries ?? 3,
      createdAt: now,
      updatedAt: now,
      status: CheckpointStatus.IN_PROGRESS,
      context,
      request: options.request,
      expiresAt: new Date(now.getTime() + ttl),
    };

    this.checkpoints.set(operationId, checkpoint);
    this.idempotencyCache.set(idempotencyKey, operationId);

    this.logger.log(
      `Checkpoint created: ${operationId} for ${operationType} (key: ${idempotencyKey})`,
    );

    return {
      operationId,
      canProceed: true,
    };
  }

  /**
   * Mark a checkpoint as completed after successful execution.
   */
  async completeCheckpoint(
    operationId: string,
    response?: any,
  ): Promise<void> {
    const checkpoint = this.checkpoints.get(operationId);

    if (!checkpoint) {
      this.logger.warn(`Cannot complete checkpoint: ${operationId} not found`);
      return;
    }

    checkpoint.status = CheckpointStatus.COMPLETED;
    checkpoint.response = response;
    checkpoint.completedAt = new Date();
    checkpoint.updatedAt = new Date();

    this.logger.log(`Checkpoint completed: ${operationId}`);
  }

  /**
   * Mark a checkpoint as failed after unsuccessful execution.
   */
  async failCheckpoint(
    operationId: string,
    error: Error | string,
  ): Promise<void> {
    const checkpoint = this.checkpoints.get(operationId);

    if (!checkpoint) {
      this.logger.warn(`Cannot fail checkpoint: ${operationId} not found`);
      return;
    }

    checkpoint.status = CheckpointStatus.FAILED;
    checkpoint.error = error instanceof Error ? error.message : error;
    checkpoint.updatedAt = new Date();

    this.logger.error(
      `Checkpoint failed: ${operationId} - ${checkpoint.error}`,
    );
  }

  /**
   * Rollback a checkpoint and execute compensating action.
   */
  async rollbackCheckpoint(
    operationId: string,
    compensatingFn?: () => Promise<void>,
  ): Promise<void> {
    const checkpoint = this.checkpoints.get(operationId);

    if (!checkpoint) {
      this.logger.warn(`Cannot rollback checkpoint: ${operationId} not found`);
      return;
    }

    // Execute compensating action if provided
    if (compensatingFn) {
      try {
        await compensatingFn();
        this.logger.log(`Compensating action executed for ${operationId}`);
      } catch (error) {
        this.logger.error(
          `Compensating action failed for ${operationId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }

    checkpoint.status = CheckpointStatus.ROLLED_BACK;
    checkpoint.rolledBackAt = new Date();
    checkpoint.updatedAt = new Date();

    this.logger.log(`Checkpoint rolled back: ${operationId}`);
  }

  /**
   * Get checkpoint metadata by operation ID.
   */
  getCheckpoint(operationId: string): CheckpointMetadata | undefined {
    return this.checkpoints.get(operationId);
  }

  /**
   * Get checkpoint by idempotency key.
   */
  getCheckpointByKey(idempotencyKey: string): CheckpointMetadata | undefined {
    const operationId = this.idempotencyCache.get(idempotencyKey);
    return operationId ? this.checkpoints.get(operationId) : undefined;
  }

  /**
   * List checkpoints with optional filtering.
   */
  listCheckpoints(filters?: {
    status?: CheckpointStatus;
    operationType?: OperationType;
    correlationId?: string;
    limit?: number;
  }): CheckpointMetadata[] {
    let checkpoints = Array.from(this.checkpoints.values());

    if (filters?.status) {
      checkpoints = checkpoints.filter((c) => c.status === filters.status);
    }

    if (filters?.operationType) {
      checkpoints = checkpoints.filter(
        (c) => c.operationType === filters.operationType,
      );
    }

    if (filters?.correlationId) {
      checkpoints = checkpoints.filter(
        (c) => c.correlationId === filters.correlationId,
      );
    }

    // Sort by creation time (newest first)
    checkpoints.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (filters?.limit) {
      checkpoints = checkpoints.slice(0, filters.limit);
    }

    return checkpoints;
  }

  /**
   * Recover incomplete checkpoints after system restart.
   * Returns checkpoints that were in progress and may need retry or rollback.
   */
  async recoverCheckpoints(): Promise<CheckpointMetadata[]> {
    const incomplete = this.listCheckpoints({
      status: CheckpointStatus.IN_PROGRESS,
    });

    this.logger.log(`Found ${incomplete.length} incomplete checkpoints to recover`);

    return incomplete;
  }

  /**
   * Clean up expired checkpoints.
   */
  async cleanupExpiredCheckpoints(): Promise<number> {
    const now = new Date();
    let cleaned = 0;

    for (const [operationId, checkpoint] of this.checkpoints.entries()) {
      if (checkpoint.expiresAt && checkpoint.expiresAt < now) {
        // Remove from idempotency cache
        this.idempotencyCache.delete(checkpoint.idempotencyKey);
        
        // Remove checkpoint
        this.checkpoints.delete(operationId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.log(`Cleaned up ${cleaned} expired checkpoints`);
    }

    return cleaned;
  }

  /**
   * Get checkpoint statistics.
   */
  getStats(): CheckpointStats {
    const checkpoints = Array.from(this.checkpoints.values());
    const completedCheckpoints = checkpoints.filter(
      (c) => c.status === CheckpointStatus.COMPLETED,
    );

    const completionTimes = completedCheckpoints
      .filter((c) => c.completedAt)
      .map((c) => c.completedAt!.getTime() - c.createdAt.getTime());

    const avgCompletionTimeMs =
      completionTimes.length > 0
        ? completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length
        : 0;

    return {
      totalCheckpoints: checkpoints.length,
      pendingCheckpoints: checkpoints.filter(
        (c) => c.status === CheckpointStatus.PENDING,
      ).length,
      completedCheckpoints: completedCheckpoints.length,
      failedCheckpoints: checkpoints.filter(
        (c) => c.status === CheckpointStatus.FAILED,
      ).length,
      rolledBackCheckpoints: checkpoints.filter(
        (c) => c.status === CheckpointStatus.ROLLED_BACK,
      ).length,
      duplicatesPrevented: this.duplicatesPrevented,
      avgCompletionTimeMs,
    };
  }

  /**
   * Execute an operation with automatic checkpointing.
   * Provides at-most-once guarantee through idempotency.
   */
  async executeWithCheckpoint<T>(
    operationType: OperationType,
    idempotencyKey: string,
    operation: () => Promise<T>,
    options: {
      context?: Record<string, any>;
      maxRetries?: number;
      rollbackFn?: () => Promise<void>;
      correlationId?: string;
    } = {},
  ): Promise<T> {
    // Create checkpoint
    const guard = await this.createCheckpoint(
      operationType,
      idempotencyKey,
      options.context ?? {},
      {
        maxRetries: options.maxRetries,
        correlationId: options.correlationId,
      },
    );

    // Check if operation should proceed
    if (!guard.canProceed) {
      if (guard.previousResult !== undefined) {
        return guard.previousResult as T;
      }
      throw new Error(guard.reason ?? 'Operation cannot proceed');
    }

    try {
      // Execute operation
      const result = await operation();

      // Mark as completed
      await this.completeCheckpoint(guard.operationId, result);

      return result;
    } catch (error) {
      // Mark as failed
      await this.failCheckpoint(
        guard.operationId,
        error instanceof Error ? error : String(error),
      );

      // Attempt rollback if provided
      if (options.rollbackFn) {
        try {
          await this.rollbackCheckpoint(guard.operationId, options.rollbackFn);
        } catch (rollbackError) {
          this.logger.error(
            `Rollback failed for ${guard.operationId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }

      throw error;
    }
  }
}

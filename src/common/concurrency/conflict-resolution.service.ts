import { Injectable, Logger, ConflictException, BadRequestException } from "@nestjs/common";
import { OptimisticConcurrencyService, VersionedRecord } from "./optimistic-concurrency.service";
import { threeWayMerge, ThreeWayMergeResult, FieldConflict } from "./conflict-resolver";

export enum ConflictResolutionStrategy {
  /** Three-way merge with automatic conflict detection */
  THREE_WAY_MERGE = "three_way_merge",
  /** Last write wins (overwrites existing) */
  LAST_WRITE_WINS = "last_write_wins",
  /** First write wins (rejects concurrent writes) */
  FIRST_WRITE_WINS = "first_write_wins",
  /** Manual resolution required */
  MANUAL = "manual",
}

export interface EditRequest<T = any> {
  resourceId: string;
  resourceType: string;
  baseVersion: number;
  proposedData: T;
  userId: string;
  strategy?: ConflictResolutionStrategy;
}

export interface EditResult<T = any> {
  success: boolean;
  data?: T;
  version?: number;
  conflicts?: FieldConflict<any>[];
  strategy: ConflictResolutionStrategy;
  requiresManualResolution: boolean;
  message: string;
}

export interface ConflictResolutionAttempt {
  timestamp: Date;
  resourceId: string;
  resourceType: string;
  userId: string;
  baseVersion: number;
  currentVersion: number;
  strategy: ConflictResolutionStrategy;
  outcome: "success" | "conflict" | "rejected" | "retry";
  conflictFields?: string[];
}

/**
 * Comprehensive conflict resolution service for concurrent edits.
 * 
 * Supports multiple resolution strategies:
 * - Three-way merge: Intelligent field-level merging
 * - Last write wins: Always accept the latest write
 * - First write wins: Reject concurrent modifications
 * - Manual: Require explicit conflict resolution
 */
@Injectable()
export class ConflictResolutionService {
  private readonly logger = new Logger(ConflictResolutionService.name);
  private readonly attempts: ConflictResolutionAttempt[] = [];

  constructor(
    private readonly optimisticConcurrency: OptimisticConcurrencyService
  ) {}

  /**
   * Attempt to apply an edit with conflict detection and resolution.
   */
  async resolveEdit<T extends VersionedRecord>(
    request: EditRequest<T>,
    getCurrentState: () => Promise<T>,
    saveState: (data: T) => Promise<T>
  ): Promise<EditResult<T>> {
    const strategy = request.strategy || ConflictResolutionStrategy.THREE_WAY_MERGE;
    const current = await getCurrentState();

    this.logger.debug(
      `Resolving edit for ${request.resourceType}:${request.resourceId} ` +
      `(base: ${request.baseVersion}, current: ${current.version}, strategy: ${strategy})`
    );

    // Check if this is a retry of the same edit
    if (request.baseVersion === current.version) {
      this.logAttempt({
        timestamp: new Date(),
        resourceId: request.resourceId,
        resourceType: request.resourceType,
        userId: request.userId,
        baseVersion: request.baseVersion,
        currentVersion: current.version,
        strategy,
        outcome: "success",
      });

      return {
        success: true,
        data: current,
        version: current.version,
        strategy,
        requiresManualResolution: false,
        message: "No changes detected (possible retry)",
      };
    }

    // Concurrent modification detected
    if (request.baseVersion < current.version) {
      return this.handleConflict(request, current, strategy, saveState);
    }

    // Invalid version (future version)
    if (request.baseVersion > current.version) {
      throw new BadRequestException(
        `Invalid base version ${request.baseVersion} (current is ${current.version})`
      );
    }

    // No conflict - apply the edit
    const updated = {
      ...request.proposedData,
      version: this.optimisticConcurrency.nextVersion(current.version),
    } as T;

    const saved = await saveState(updated);

    this.logAttempt({
      timestamp: new Date(),
      resourceId: request.resourceId,
      resourceType: request.resourceType,
      userId: request.userId,
      baseVersion: request.baseVersion,
      currentVersion: current.version,
      strategy,
      outcome: "success",
    });

    return {
      success: true,
      data: saved,
      version: saved.version,
      strategy,
      requiresManualResolution: false,
      message: "Edit applied successfully",
    };
  }

  /**
   * Handle conflict based on the selected strategy.
   */
  private async handleConflict<T extends VersionedRecord>(
    request: EditRequest<T>,
    current: T,
    strategy: ConflictResolutionStrategy,
    saveState: (data: T) => Promise<T>
  ): Promise<EditResult<T>> {
    switch (strategy) {
      case ConflictResolutionStrategy.THREE_WAY_MERGE:
        return this.resolveWithThreeWayMerge(request, current, saveState);

      case ConflictResolutionStrategy.LAST_WRITE_WINS:
        return this.resolveWithLastWriteWins(request, current, saveState);

      case ConflictResolutionStrategy.FIRST_WRITE_WINS:
        return this.resolveWithFirstWriteWins(request, current);

      case ConflictResolutionStrategy.MANUAL:
        return this.requireManualResolution(request, current);

      default:
        throw new BadRequestException(`Unknown resolution strategy: ${strategy}`);
    }
  }

  /**
   * Three-way merge: Attempt to merge non-conflicting changes.
   */
  private async resolveWithThreeWayMerge<T extends VersionedRecord>(
    request: EditRequest<T>,
    current: T,
    saveState: (data: T) => Promise<T>
  ): Promise<EditResult<T>> {
    // Reconstruct base state (in real implementation, this would be fetched from history)
    const base = this.reconstructBase(request.baseVersion, current);

    const mergeResult = threeWayMerge<any>(
      base as Record<string, any>,
      current as Record<string, any>,
      request.proposedData as Record<string, any>
    );

    if (mergeResult.conflicts.length > 0) {
      this.logAttempt({
        timestamp: new Date(),
        resourceId: request.resourceId,
        resourceType: request.resourceType,
        userId: request.userId,
        baseVersion: request.baseVersion,
        currentVersion: current.version,
        strategy: ConflictResolutionStrategy.THREE_WAY_MERGE,
        outcome: "conflict",
        conflictFields: mergeResult.conflicts.map((c) => c.field),
      });

      this.logger.warn(
        `Three-way merge conflicts detected for ${request.resourceType}:${request.resourceId}: ` +
        mergeResult.conflicts.map((c) => c.field).join(", ")
      );

      return {
        success: false,
        conflicts: mergeResult.conflicts,
        data: current,
        version: current.version,
        strategy: ConflictResolutionStrategy.THREE_WAY_MERGE,
        requiresManualResolution: true,
        message: `Conflicts detected in fields: ${mergeResult.conflicts.map((c) => c.field).join(", ")}`,
      };
    }

    // Merge successful - save the merged result
    const merged = {
      ...mergeResult.merged,
      version: this.optimisticConcurrency.nextVersion(current.version),
    } as T;

    const saved = await saveState(merged);

    this.logAttempt({
      timestamp: new Date(),
      resourceId: request.resourceId,
      resourceType: request.resourceType,
      userId: request.userId,
      baseVersion: request.baseVersion,
      currentVersion: current.version,
      strategy: ConflictResolutionStrategy.THREE_WAY_MERGE,
      outcome: "success",
    });

    this.logger.log(
      `Three-way merge successful for ${request.resourceType}:${request.resourceId} ` +
      `by ${request.userId}`
    );

    return {
      success: true,
      data: saved,
      version: saved.version,
      strategy: ConflictResolutionStrategy.THREE_WAY_MERGE,
      requiresManualResolution: false,
      message: "Changes merged successfully",
    };
  }

  /**
   * Last write wins: Always accept the proposed changes.
   */
  private async resolveWithLastWriteWins<T extends VersionedRecord>(
    request: EditRequest<T>,
    current: T,
    saveState: (data: T) => Promise<T>
  ): Promise<EditResult<T>> {
    this.logger.warn(
      `Using last-write-wins for ${request.resourceType}:${request.resourceId} ` +
      `by ${request.userId} - overwriting version ${current.version}`
    );

    const updated = {
      ...request.proposedData,
      version: this.optimisticConcurrency.nextVersion(current.version),
    } as T;

    const saved = await saveState(updated);

    this.logAttempt({
      timestamp: new Date(),
      resourceId: request.resourceId,
      resourceType: request.resourceType,
      userId: request.userId,
      baseVersion: request.baseVersion,
      currentVersion: current.version,
      strategy: ConflictResolutionStrategy.LAST_WRITE_WINS,
      outcome: "success",
    });

    return {
      success: true,
      data: saved,
      version: saved.version,
      strategy: ConflictResolutionStrategy.LAST_WRITE_WINS,
      requiresManualResolution: false,
      message: "Changes applied (last write wins)",
    };
  }

  /**
   * First write wins: Reject the proposed changes.
   */
  private resolveWithFirstWriteWins<T extends VersionedRecord>(
    request: EditRequest<T>,
    current: T
  ): EditResult<T> {
    this.logger.warn(
      `First-write-wins rejected edit for ${request.resourceType}:${request.resourceId} ` +
      `by ${request.userId} (current version: ${current.version})`
    );

    this.logAttempt({
      timestamp: new Date(),
      resourceId: request.resourceId,
      resourceType: request.resourceType,
      userId: request.userId,
      baseVersion: request.baseVersion,
      currentVersion: current.version,
      strategy: ConflictResolutionStrategy.FIRST_WRITE_WINS,
      outcome: "rejected",
    });

    return {
      success: false,
      data: current,
      version: current.version,
      strategy: ConflictResolutionStrategy.FIRST_WRITE_WINS,
      requiresManualResolution: true,
      message: "Edit rejected - resource was modified by another user",
    };
  }

  /**
   * Manual resolution: Return conflict details for manual handling.
   */
  private requireManualResolution<T extends VersionedRecord>(
    request: EditRequest<T>,
    current: T
  ): EditResult<T> {
    this.logger.log(
      `Manual resolution required for ${request.resourceType}:${request.resourceId} ` +
      `by ${request.userId}`
    );

    this.logAttempt({
      timestamp: new Date(),
      resourceId: request.resourceId,
      resourceType: request.resourceType,
      userId: request.userId,
      baseVersion: request.baseVersion,
      currentVersion: current.version,
      strategy: ConflictResolutionStrategy.MANUAL,
      outcome: "conflict",
    });

    return {
      success: false,
      data: current,
      version: current.version,
      strategy: ConflictResolutionStrategy.MANUAL,
      requiresManualResolution: true,
      message: "Concurrent modification detected - manual resolution required",
    };
  }

  /**
   * Get conflict resolution statistics.
   */
  getStatistics(resourceType?: string) {
    const filtered = resourceType
      ? this.attempts.filter((a) => a.resourceType === resourceType)
      : this.attempts;

    const total = filtered.length;
    const byOutcome = {
      success: filtered.filter((a) => a.outcome === "success").length,
      conflict: filtered.filter((a) => a.outcome === "conflict").length,
      rejected: filtered.filter((a) => a.outcome === "rejected").length,
      retry: filtered.filter((a) => a.outcome === "retry").length,
    };

    const byStrategy = {
      [ConflictResolutionStrategy.THREE_WAY_MERGE]: filtered.filter(
        (a) => a.strategy === ConflictResolutionStrategy.THREE_WAY_MERGE
      ).length,
      [ConflictResolutionStrategy.LAST_WRITE_WINS]: filtered.filter(
        (a) => a.strategy === ConflictResolutionStrategy.LAST_WRITE_WINS
      ).length,
      [ConflictResolutionStrategy.FIRST_WRITE_WINS]: filtered.filter(
        (a) => a.strategy === ConflictResolutionStrategy.FIRST_WRITE_WINS
      ).length,
      [ConflictResolutionStrategy.MANUAL]: filtered.filter(
        (a) => a.strategy === ConflictResolutionStrategy.MANUAL
      ).length,
    };

    const conflictRate = total > 0 ? (byOutcome.conflict / total) * 100 : 0;
    const successRate = total > 0 ? (byOutcome.success / total) * 100 : 0;

    return {
      total,
      byOutcome,
      byStrategy,
      conflictRate: Math.round(conflictRate * 100) / 100,
      successRate: Math.round(successRate * 100) / 100,
      recentAttempts: filtered.slice(-10),
    };
  }

  /**
   * Reconstruct base state (placeholder - in production, fetch from history table).
   */
  private reconstructBase<T>(baseVersion: number, current: T): Partial<T> {
    // In a real implementation, this would query a version history table
    // For now, return current as base (which will cause conflicts if there are changes)
    return current as Partial<T>;
  }

  /**
   * Log a conflict resolution attempt for auditing.
   */
  private logAttempt(attempt: ConflictResolutionAttempt): void {
    this.attempts.push(attempt);

    // Keep only last 1000 attempts in memory
    if (this.attempts.length > 1000) {
      this.attempts.shift();
    }
  }
}

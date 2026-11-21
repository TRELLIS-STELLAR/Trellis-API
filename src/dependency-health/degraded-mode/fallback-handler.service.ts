import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  DegradedCapability,
  DegradedModeDecision,
  CapabilityFallback,
} from "./degraded-mode.types";
import { DependencyDegradedModeService } from "./degraded-mode.service";
import { getCorrelationId } from "../../common/correlation/correlation-context";

export interface FallbackContext {
  capability: DegradedCapability;
  operation: string;
  userId?: string;
  correlationId?: string;
  metadata?: Record<string, any>;
}

export interface FallbackResult<T = any> {
  success: boolean;
  data?: T;
  fallbackUsed: boolean;
  fallbackType?: CapabilityFallback["behavior"];
  message?: string;
  retryAfter?: number;
  queuedForLater?: boolean;
}

/**
 * Handles fallback behaviors when dependencies are unhealthy.
 * 
 * Implements graceful degradation strategies:
 * - Queue operations for later retry when dependency recovers
 * - Serve stale cached data when real-time data unavailable
 * - Provide read-only access when write operations blocked
 * - Return helpful error messages with recovery guidance
 * 
 * Issue #355: Dependency outage fallback and recovery UX
 */
@Injectable()
export class FallbackHandlerService {
  private readonly logger = new Logger(FallbackHandlerService.name);
  
  // In-memory queue for operations pending dependency recovery
  private readonly pendingOperations = new Map<string, any[]>();
  
  // Cache for stale data serving
  private readonly staleCache = new Map<string, { data: any; timestamp: number }>();
  private readonly staleCacheTtlMs = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly degradedModeService: DependencyDegradedModeService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Execute an operation with automatic fallback handling.
   * Checks degraded mode and applies appropriate fallback strategy.
   */
  async executeWithFallback<T>(
    context: FallbackContext,
    operation: () => Promise<T>,
    fallback: CapabilityFallback,
  ): Promise<FallbackResult<T>> {
    const correlationId = context.correlationId || getCorrelationId();
    
    try {
      // Check if capability is available
      const decision = await this.degradedModeService.getMode();
      const capabilityView = await this.degradedModeService.assertCapabilityEnabled(
        context.capability,
        decision,
      );

      // If capability disabled, apply fallback
      if (capabilityView.state === "disabled") {
        return this.applyFallback(context, fallback, decision, correlationId);
      }

      // If capability degraded, warn but attempt operation
      if (capabilityView.state === "degraded") {
        this.logger.warn({
          correlationId,
          capability: context.capability,
          operation: context.operation,
          message: "Operating in degraded mode",
          reason: capabilityView.reason,
        });
      }

      // Execute normal operation
      const data = await operation();
      
      // Cache successful result for potential future stale serving
      this.cacheStaleData(context, data);
      
      return {
        success: true,
        data,
        fallbackUsed: false,
      };
    } catch (error) {
      // Operation failed - apply fallback
      this.logger.error({
        correlationId,
        capability: context.capability,
        operation: context.operation,
        error: error instanceof Error ? error.message : String(error),
        message: "Operation failed, applying fallback",
      });

      const decision = await this.degradedModeService.getMode();
      return this.applyFallback(context, fallback, decision, correlationId);
    }
  }

  /**
   * Apply the appropriate fallback behavior based on configuration.
   */
  private async applyFallback<T>(
    context: FallbackContext,
    fallback: CapabilityFallback,
    decision: DegradedModeDecision,
    correlationId?: string,
  ): Promise<FallbackResult<T>> {
    this.logger.log({
      correlationId,
      capability: context.capability,
      operation: context.operation,
      fallbackBehavior: fallback.behavior,
      message: "Applying fallback behavior",
    });

    this.eventEmitter.emit("fallback.applied", {
      correlationId,
      capability: context.capability,
      operation: context.operation,
      fallbackType: fallback.behavior,
      timestamp: new Date().toISOString(),
    });

    switch (fallback.behavior) {
      case "queue_for_later":
        return this.queueForLater(context, fallback, correlationId);

      case "serve_stale":
        return this.serveStale(context, fallback, correlationId);

      case "read_only":
        return this.enforceReadOnly(context, fallback);

      case "reject_with_503":
        return this.rejectWithServiceUnavailable(context, fallback, decision);

      case "manual_override":
        return this.requireManualOverride(context, fallback, decision);

      default:
        return this.rejectWithServiceUnavailable(context, fallback, decision);
    }
  }

  /**
   * Queue operation for later execution when dependency recovers.
   */
  private queueForLater<T>(
    context: FallbackContext,
    fallback: CapabilityFallback,
    correlationId?: string,
  ): FallbackResult<T> {
    const queueKey = context.capability;
    const queue = this.pendingOperations.get(queueKey) || [];
    
    queue.push({
      context,
      timestamp: Date.now(),
      correlationId,
    });
    
    this.pendingOperations.set(queueKey, queue);

    this.logger.log({
      correlationId,
      capability: context.capability,
      operation: context.operation,
      queueSize: queue.length,
      message: "Operation queued for later execution",
    });

    return {
      success: false,
      fallbackUsed: true,
      fallbackType: "queue_for_later",
      queuedForLater: true,
      message: `${fallback.note}. Your request has been queued and will be processed automatically when the service recovers.`,
      retryAfter: 300, // Suggest retry in 5 minutes
    };
  }

  /**
   * Serve cached stale data when real-time data unavailable.
   */
  private serveStale<T>(
    context: FallbackContext,
    fallback: CapabilityFallback,
    correlationId?: string,
  ): FallbackResult<T> {
    const cacheKey = this.getCacheKey(context);
    const cached = this.staleCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.staleCacheTtlMs) {
      this.logger.log({
        correlationId,
        capability: context.capability,
        operation: context.operation,
        cacheAge: Date.now() - cached.timestamp,
        message: "Serving stale cached data",
      });

      return {
        success: true,
        data: cached.data,
        fallbackUsed: true,
        fallbackType: "serve_stale",
        message: `${fallback.note}. Showing cached data from ${this.formatAge(Date.now() - cached.timestamp)} ago.`,
      };
    }

    // No stale data available
    return this.rejectWithServiceUnavailable(context, fallback, null);
  }

  /**
   * Enforce read-only access by rejecting write operations.
   */
  private enforceReadOnly<T>(
    context: FallbackContext,
    fallback: CapabilityFallback,
  ): FallbackResult<T> {
    return {
      success: false,
      fallbackUsed: true,
      fallbackType: "read_only",
      message: `${fallback.note}. Write operations are temporarily disabled. Read operations remain available.`,
      retryAfter: 300,
    };
  }

  /**
   * Reject with 503 Service Unavailable.
   */
  private rejectWithServiceUnavailable<T>(
    context: FallbackContext,
    fallback: CapabilityFallback,
    decision: DegradedModeDecision | null,
  ): never {
    const reasons = decision?.reasons.join("; ") || "Service temporarily unavailable";
    const message = `${fallback.note}. ${reasons}. Please try again later.`;

    throw new ServiceUnavailableException({
      statusCode: 503,
      error: "Service Unavailable",
      message,
      capability: context.capability,
      retryAfter: 300,
      correlationId: context.correlationId || getCorrelationId(),
    });
  }

  /**
   * Require manual operator override to proceed.
   */
  private requireManualOverride<T>(
    context: FallbackContext,
    fallback: CapabilityFallback,
    decision: DegradedModeDecision,
  ): FallbackResult<T> {
    return {
      success: false,
      fallbackUsed: true,
      fallbackType: "manual_override",
      message: `${fallback.note}. This operation requires manual administrator approval due to system degradation.`,
    };
  }

  /**
   * Process queued operations after dependency recovery.
   * Should be called when degraded mode transitions back to normal.
   */
  async processQueuedOperations(capability: DegradedCapability): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
  }> {
    const queue = this.pendingOperations.get(capability) || [];
    if (queue.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    this.logger.log({
      capability,
      queueSize: queue.length,
      message: "Processing queued operations after recovery",
    });

    let succeeded = 0;
    let failed = 0;

    for (const item of queue) {
      try {
        // Emit event for each queued operation to be processed
        this.eventEmitter.emit("fallback.queue.process", {
          context: item.context,
          correlationId: item.correlationId,
          queuedAt: new Date(item.timestamp).toISOString(),
        });
        succeeded++;
      } catch (error) {
        this.logger.error({
          correlationId: item.correlationId,
          error: error instanceof Error ? error.message : String(error),
          message: "Failed to process queued operation",
        });
        failed++;
      }
    }

    // Clear processed queue
    this.pendingOperations.delete(capability);

    this.logger.log({
      capability,
      processed: queue.length,
      succeeded,
      failed,
      message: "Completed processing queued operations",
    });

    return {
      processed: queue.length,
      succeeded,
      failed,
    };
  }

  /**
   * Get pending operations count for a capability.
   */
  getPendingCount(capability: DegradedCapability): number {
    return (this.pendingOperations.get(capability) || []).length;
  }

  /**
   * Get all pending operations across all capabilities.
   */
  getAllPendingCounts(): Record<DegradedCapability, number> {
    const counts: any = {};
    for (const [capability, queue] of this.pendingOperations.entries()) {
      counts[capability] = queue.length;
    }
    return counts;
  }

  /**
   * Cache data for potential stale serving.
   */
  private cacheStaleData(context: FallbackContext, data: any): void {
    const cacheKey = this.getCacheKey(context);
    this.staleCache.set(cacheKey, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear stale cache for a capability.
   */
  clearStaleCache(capability: DegradedCapability): void {
    for (const key of this.staleCache.keys()) {
      if (key.startsWith(`${capability}:`)) {
        this.staleCache.delete(key);
      }
    }
  }

  private getCacheKey(context: FallbackContext): string {
    return `${context.capability}:${context.operation}:${context.userId || "anonymous"}`;
  }

  private formatAge(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }
}

/**
 * Enhanced dependency-aware public health status service.
 *
 * Extends existing health checks with:
 * - Dependency criticality classification (critical vs optional)
 * - Cascading failure detection
 * - Health score calculation
 * - Retry policies for transient failures
 * - Circuit breaker pattern for failing dependencies
 * - Authorization-aware health checks
 * - Detailed recovery guidance
 */

import { Injectable, Logger } from '@nestjs/common';

export enum DependencyType {
  DATABASE = 'database',
  CACHE = 'cache',
  EXTERNAL_API = 'external_api',
  MESSAGE_QUEUE = 'message_queue',
  FILE_STORAGE = 'file_storage',
  AUTH_SERVICE = 'auth_service',
  PAYMENT_GATEWAY = 'payment_gateway',
}

export enum Criticality {
  CRITICAL = 'critical',
  OPTIONAL = 'optional',
  DEGRADED_OK = 'degraded_ok',
}

export enum DependencyStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
  UNKNOWN = 'unknown',
}

export interface DependencyConfig {
  name: string;
  type: DependencyType;
  criticality: Criticality;
  timeout: number;
  retryAttempts: number;
  circuitBreakerThreshold: number;
  healthCheckFn: () => Promise<HealthCheckResult>;
}

export interface HealthCheckResult {
  status: DependencyStatus;
  responseTime?: number;
  message?: string;
  metadata?: Record<string, any>;
}

export interface DependencyHealth {
  name: string;
  type: DependencyType;
  criticality: Criticality;
  status: DependencyStatus;
  responseTime?: number;
  lastChecked: Date;
  consecutiveFailures: number;
  circuitBreakerOpen: boolean;
  message?: string;
  recoveryGuidance?: string;
}

export interface SystemHealthStatus {
  overall: DependencyStatus;
  score: number; // 0-100
  dependencies: DependencyHealth[];
  timestamp: Date;
  degradedReasons: string[];
  criticalFailures: string[];
  canAcceptTraffic: boolean;
  canProcessBackgroundJobs: boolean;
  requiresAdminIntervention: boolean;
}

export interface HealthMetrics {
  totalChecks: number;
  healthyCount: number;
  degradedCount: number;
  unhealthyCount: number;
  averageResponseTime: number;
  circuitBreakersOpen: number;
}

@Injectable()
export class DependencyAwareHealthService {
  private readonly logger = new Logger(DependencyAwareHealthService.name);
  private readonly dependencies = new Map<string, DependencyConfig>();
  private readonly dependencyState = new Map<string, DependencyHealth>();
  private readonly circuitBreakers = new Map<string, {
    failures: number;
    lastFailure: Date;
    openUntil?: Date;
  }>();

  /**
   * Register a dependency for health monitoring.
   */
  registerDependency(config: DependencyConfig): void {
    this.dependencies.set(config.name, config);
    
    // Initialize state
    this.dependencyState.set(config.name, {
      name: config.name,
      type: config.type,
      criticality: config.criticality,
      status: DependencyStatus.UNKNOWN,
      lastChecked: new Date(),
      consecutiveFailures: 0,
      circuitBreakerOpen: false,
    });

    this.logger.log(
      `Registered ${config.criticality} dependency: ${config.name} (${config.type})`,
    );
  }

  /**
   * Get comprehensive system health status.
   */
  async getSystemHealth(): Promise<SystemHealthStatus> {
    const healthChecks = await Promise.all(
      Array.from(this.dependencies.keys()).map((name) =>
        this.checkDependency(name),
      ),
    );

    const dependencies = healthChecks.filter(
      (h): h is DependencyHealth => h !== null,
    );

    const criticalDeps = dependencies.filter(
      (d) => d.criticality === Criticality.CRITICAL,
    );
    const criticalFailures = criticalDeps
      .filter((d) => d.status === DependencyStatus.UNHEALTHY)
      .map((d) => `${d.name}: ${d.message || 'unhealthy'}`);

    const optionalDeps = dependencies.filter(
      (d) => d.criticality === Criticality.OPTIONAL,
    );
    const degradedDeps = dependencies.filter(
      (d) => d.status === DependencyStatus.DEGRADED,
    );
    
    const degradedReasons = degradedDeps.map(
      (d) => `${d.name}: ${d.message || 'degraded'}`,
    );

    // Calculate overall status
    let overall: DependencyStatus;
    if (criticalFailures.length > 0) {
      overall = DependencyStatus.UNHEALTHY;
    } else if (degradedReasons.length > 0) {
      overall = DependencyStatus.DEGRADED;
    } else if (
      dependencies.every((d) => d.status === DependencyStatus.HEALTHY)
    ) {
      overall = DependencyStatus.HEALTHY;
    } else {
      overall = DependencyStatus.DEGRADED;
    }

    // Calculate health score (0-100)
    const healthyCount = dependencies.filter(
      (d) => d.status === DependencyStatus.HEALTHY,
    ).length;
    const totalCount = dependencies.length;
    const baseScore =
      totalCount > 0 ? (healthyCount / totalCount) * 100 : 100;

    // Penalize for critical failures
    const criticalPenalty = criticalFailures.length * 30;
    const score = Math.max(0, Math.min(100, baseScore - criticalPenalty));

    return {
      overall,
      score: Math.round(score),
      dependencies,
      timestamp: new Date(),
      degradedReasons,
      criticalFailures,
      canAcceptTraffic: criticalFailures.length === 0,
      canProcessBackgroundJobs:
        criticalFailures.length === 0 &&
        dependencies.filter(
          (d) =>
            d.name === 'message_queue' &&
            d.status === DependencyStatus.UNHEALTHY,
        ).length === 0,
      requiresAdminIntervention: criticalFailures.length > 0,
    };
  }

  /**
   * Check health of a specific dependency.
   */
  async checkDependency(name: string): Promise<DependencyHealth | null> {
    const config = this.dependencies.get(name);
    if (!config) {
      this.logger.warn(`Dependency not registered: ${name}`);
      return null;
    }

    const state = this.dependencyState.get(name);
    if (!state) return null;

    // Check circuit breaker
    if (this.isCircuitBreakerOpen(name)) {
      state.circuitBreakerOpen = true;
      state.status = DependencyStatus.UNHEALTHY;
      state.message = 'Circuit breaker open';
      state.recoveryGuidance = 'Wait for circuit breaker cooldown';
      return state;
    }

    // Execute health check with timeout and retries
    let lastError: Error | null = null;
    let result: HealthCheckResult | null = null;

    for (let attempt = 0; attempt <= config.retryAttempts; attempt++) {
      try {
        result = await this.executeWithTimeout(
          config.healthCheckFn,
          config.timeout,
        );
        
        // Success - reset circuit breaker
        this.resetCircuitBreaker(name);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt < config.retryAttempts) {
          // Exponential backoff
          await this.sleep(Math.pow(2, attempt) * 100);
        }
      }
    }

    // Update state
    state.lastChecked = new Date();

    if (result) {
      state.status = result.status;
      state.responseTime = result.responseTime;
      state.message = result.message;
      state.consecutiveFailures = 0;
      state.circuitBreakerOpen = false;
    } else {
      state.status = DependencyStatus.UNHEALTHY;
      state.message = lastError?.message || 'Health check failed';
      state.consecutiveFailures++;
      
      // Update circuit breaker
      this.recordFailure(name);
      
      if (this.isCircuitBreakerOpen(name)) {
        state.circuitBreakerOpen = true;
        state.recoveryGuidance = this.getRecoveryGuidance(config);
      }
    }

    this.dependencyState.set(name, state);
    return state;
  }

  /**
   * Get health status for authorization checks.
   */
  async canAuthorizeRequests(): Promise<boolean> {
    const health = await this.getSystemHealth();
    
    // Can authorize if auth service and database are healthy
    const authService = health.dependencies.find(
      (d) => d.type === DependencyType.AUTH_SERVICE,
    );
    const database = health.dependencies.find(
      (d) => d.type === DependencyType.DATABASE,
    );

    return (
      (!authService || authService.status !== DependencyStatus.UNHEALTHY) &&
      (!database || database.status !== DependencyStatus.UNHEALTHY)
    );
  }

  /**
   * Get health metrics for monitoring.
   */
  getMetrics(): HealthMetrics {
    const dependencies = Array.from(this.dependencyState.values());
    const healthyCount = dependencies.filter(
      (d) => d.status === DependencyStatus.HEALTHY,
    ).length;
    const degradedCount = dependencies.filter(
      (d) => d.status === DependencyStatus.DEGRADED,
    ).length;
    const unhealthyCount = dependencies.filter(
      (d) => d.status === DependencyStatus.UNHEALTHY,
    ).length;

    const responseTimes = dependencies
      .map((d) => d.responseTime)
      .filter((rt): rt is number => rt !== undefined);
    const averageResponseTime =
      responseTimes.length > 0
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
        : 0;

    const circuitBreakersOpen = dependencies.filter(
      (d) => d.circuitBreakerOpen,
    ).length;

    return {
      totalChecks: dependencies.length,
      healthyCount,
      degradedCount,
      unhealthyCount,
      averageResponseTime: Math.round(averageResponseTime),
      circuitBreakersOpen,
    };
  }

  /**
   * Manually reset circuit breaker for a dependency.
   */
  resetCircuitBreakerManually(name: string): void {
    this.circuitBreakers.delete(name);
    
    const state = this.dependencyState.get(name);
    if (state) {
      state.circuitBreakerOpen = false;
      state.consecutiveFailures = 0;
    }

    this.logger.log(`Circuit breaker manually reset for ${name}`);
  }

  /**
   * Get dependency state for monitoring.
   */
  getDependencyState(name: string): DependencyHealth | undefined {
    return this.dependencyState.get(name);
  }

  /**
   * List all registered dependencies.
   */
  listDependencies(): DependencyHealth[] {
    return Array.from(this.dependencyState.values());
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isCircuitBreakerOpen(name: string): boolean {
    const breaker = this.circuitBreakers.get(name);
    if (!breaker) return false;

    // Check if still open
    if (breaker.openUntil && new Date() < breaker.openUntil) {
      return true;
    }

    // Cooldown expired
    if (breaker.openUntil && new Date() >= breaker.openUntil) {
      this.circuitBreakers.delete(name);
      return false;
    }

    const config = this.dependencies.get(name);
    if (!config) return false;

    return breaker.failures >= config.circuitBreakerThreshold;
  }

  private recordFailure(name: string): void {
    const config = this.dependencies.get(name);
    if (!config) return;

    const breaker = this.circuitBreakers.get(name) || {
      failures: 0,
      lastFailure: new Date(),
    };

    breaker.failures++;
    breaker.lastFailure = new Date();

    // Open circuit breaker if threshold reached
    if (breaker.failures >= config.circuitBreakerThreshold) {
      breaker.openUntil = new Date(Date.now() + 60000); // 60 second cooldown
      this.logger.warn(
        `Circuit breaker opened for ${name} (${breaker.failures} failures)`,
      );
    }

    this.circuitBreakers.set(name, breaker);
  }

  private resetCircuitBreaker(name: string): void {
    this.circuitBreakers.delete(name);
  }

  private getRecoveryGuidance(config: DependencyConfig): string {
    switch (config.type) {
      case DependencyType.DATABASE:
        return 'Check database connection, verify credentials, and ensure database server is running';
      case DependencyType.CACHE:
        return 'Verify Redis/cache server is running and accessible';
      case DependencyType.EXTERNAL_API:
        return 'Check network connectivity, API credentials, and external service status';
      case DependencyType.MESSAGE_QUEUE:
        return 'Verify message queue service is running and connections are configured correctly';
      case DependencyType.FILE_STORAGE:
        return 'Check storage service connectivity and access permissions';
      case DependencyType.AUTH_SERVICE:
        return 'Verify authentication service is running and credentials are valid';
      case DependencyType.PAYMENT_GATEWAY:
        return 'Check payment gateway credentials and service status page';
      default:
        return 'Check logs and verify service configuration';
    }
  }
}

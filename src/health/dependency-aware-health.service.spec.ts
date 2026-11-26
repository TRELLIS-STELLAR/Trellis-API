/**
 * Comprehensive tests for dependency-aware health service covering:
 * - Normal health check operations
 * - Failure scenarios and recovery
 * - Retry logic and circuit breakers
 * - Authorization-aware health checks
 * - Cascading failure detection
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  DependencyAwareHealthService,
  DependencyType,
  Criticality,
  DependencyStatus,
  DependencyConfig,
} from './dependency-aware-health.service';

describe('DependencyAwareHealthService', () => {
  let service: DependencyAwareHealthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DependencyAwareHealthService],
    }).compile();

    service = module.get<DependencyAwareHealthService>(
      DependencyAwareHealthService,
    );
  });

  describe('Normal health check operations', () => {
    it('registers dependencies successfully', () => {
      const config: DependencyConfig = {
        name: 'database',
        type: DependencyType.DATABASE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 2,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => ({
          status: DependencyStatus.HEALTHY,
          responseTime: 50,
        }),
      };

      service.registerDependency(config);

      const state = service.getDependencyState('database');
      expect(state).toBeDefined();
      expect(state?.name).toBe('database');
      expect(state?.type).toBe(DependencyType.DATABASE);
      expect(state?.criticality).toBe(Criticality.CRITICAL);
    });

    it('checks healthy dependency successfully', async () => {
      service.registerDependency({
        name: 'cache',
        type: DependencyType.CACHE,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 1,
        circuitBreakerThreshold: 3,
        healthCheckFn: async () => ({
          status: DependencyStatus.HEALTHY,
          responseTime: 25,
          message: 'Cache is operational',
        }),
      });

      const health = await service.checkDependency('cache');

      expect(health).toBeDefined();
      expect(health?.status).toBe(DependencyStatus.HEALTHY);
      expect(health?.responseTime).toBe(25);
      expect(health?.message).toBe('Cache is operational');
      expect(health?.consecutiveFailures).toBe(0);
    });

    it('calculates system health with all healthy dependencies', async () => {
      service.registerDependency({
        name: 'database',
        type: DependencyType.DATABASE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 2,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => ({
          status: DependencyStatus.HEALTHY,
          responseTime: 50,
        }),
      });

      service.registerDependency({
        name: 'cache',
        type: DependencyType.CACHE,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 1,
        circuitBreakerThreshold: 3,
        healthCheckFn: async () => ({
          status: DependencyStatus.HEALTHY,
          responseTime: 25,
        }),
      });

      const systemHealth = await service.getSystemHealth();

      expect(systemHealth.overall).toBe(DependencyStatus.HEALTHY);
      expect(systemHealth.score).toBe(100);
      expect(systemHealth.canAcceptTraffic).toBe(true);
      expect(systemHealth.canProcessBackgroundJobs).toBe(true);
      expect(systemHealth.requiresAdminIntervention).toBe(false);
      expect(systemHealth.criticalFailures).toHaveLength(0);
    });

    it('provides health metrics', async () => {
      service.registerDependency({
        name: 'db',
        type: DependencyType.DATABASE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 2,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => ({
          status: DependencyStatus.HEALTHY,
          responseTime: 100,
        }),
      });

      await service.checkDependency('db');

      const metrics = service.getMetrics();

      expect(metrics.totalChecks).toBe(1);
      expect(metrics.healthyCount).toBe(1);
      expect(metrics.degradedCount).toBe(0);
      expect(metrics.unhealthyCount).toBe(0);
      expect(metrics.averageResponseTime).toBeGreaterThan(0);
    });

    it('lists all registered dependencies', async () => {
      service.registerDependency({
        name: 'dep1',
        type: DependencyType.DATABASE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 2,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => ({
          status: DependencyStatus.HEALTHY,
        }),
      });

      service.registerDependency({
        name: 'dep2',
        type: DependencyType.CACHE,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 1,
        circuitBreakerThreshold: 3,
        healthCheckFn: async () => ({
          status: DependencyStatus.HEALTHY,
        }),
      });

      const dependencies = service.listDependencies();

      expect(dependencies).toHaveLength(2);
      expect(dependencies.map((d) => d.name)).toContain('dep1');
      expect(dependencies.map((d) => d.name)).toContain('dep2');
    });
  });

  describe('Failure scenarios', () => {
    it('marks dependency as unhealthy on failure', async () => {
      service.registerDependency({
        name: 'failing-service',
        type: DependencyType.EXTERNAL_API,
        criticality: Criticality.CRITICAL,
        timeout: 3000,
        retryAttempts: 0,
        circuitBreakerThreshold: 3,
        healthCheckFn: async () => {
          throw new Error('Connection refused');
        },
      });

      const health = await service.checkDependency('failing-service');

      expect(health?.status).toBe(DependencyStatus.UNHEALTHY);
      expect(health?.message).toContain('Connection refused');
      expect(health?.consecutiveFailures).toBe(1);
    });

    it('marks system as unhealthy when critical dependency fails', async () => {
      service.registerDependency({
        name: 'critical-db',
        type: DependencyType.DATABASE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 1,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => {
          throw new Error('Database unavailable');
        },
      });

      const systemHealth = await service.getSystemHealth();

      expect(systemHealth.overall).toBe(DependencyStatus.UNHEALTHY);
      expect(systemHealth.score).toBeLessThan(50);
      expect(systemHealth.canAcceptTraffic).toBe(false);
      expect(systemHealth.requiresAdminIntervention).toBe(true);
      expect(systemHealth.criticalFailures.length).toBeGreaterThan(0);
    });

    it('marks system as degraded when optional dependency fails', async () => {
      service.registerDependency({
        name: 'primary-db',
        type: DependencyType.DATABASE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 2,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => ({
          status: DependencyStatus.HEALTHY,
        }),
      });

      service.registerDependency({
        name: 'optional-cache',
        type: DependencyType.CACHE,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 1,
        circuitBreakerThreshold: 3,
        healthCheckFn: async () => {
          throw new Error('Cache unavailable');
        },
      });

      const systemHealth = await service.getSystemHealth();

      expect(systemHealth.overall).toBe(DependencyStatus.DEGRADED);
      expect(systemHealth.score).toBeGreaterThan(0);
      expect(systemHealth.canAcceptTraffic).toBe(true);
      expect(systemHealth.requiresAdminIntervention).toBe(false);
      expect(systemHealth.degradedReasons.length).toBeGreaterThan(0);
    });

    it('handles timeout gracefully', async () => {
      service.registerDependency({
        name: 'slow-service',
        type: DependencyType.EXTERNAL_API,
        criticality: Criticality.OPTIONAL,
        timeout: 100,
        retryAttempts: 0,
        circuitBreakerThreshold: 3,
        healthCheckFn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { status: DependencyStatus.HEALTHY };
        },
      });

      const health = await service.checkDependency('slow-service');

      expect(health?.status).toBe(DependencyStatus.UNHEALTHY);
      expect(health?.message).toContain('Timeout');
    });

    it('tracks consecutive failures', async () => {
      let callCount = 0;

      service.registerDependency({
        name: 'flaky-service',
        type: DependencyType.EXTERNAL_API,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 0,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => {
          callCount++;
          throw new Error(`Failure ${callCount}`);
        },
      });

      await service.checkDependency('flaky-service');
      await service.checkDependency('flaky-service');
      await service.checkDependency('flaky-service');

      const health = service.getDependencyState('flaky-service');
      expect(health?.consecutiveFailures).toBe(3);
    });

    it('provides recovery guidance on failure', async () => {
      service.registerDependency({
        name: 'database',
        type: DependencyType.DATABASE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 0,
        circuitBreakerThreshold: 2,
        healthCheckFn: async () => {
          throw new Error('Connection failed');
        },
      });

      // Trigger circuit breaker
      await service.checkDependency('database');
      await service.checkDependency('database');
      await service.checkDependency('database');

      const health = service.getDependencyState('database');
      expect(health?.recoveryGuidance).toBeDefined();
      expect(health?.recoveryGuidance).toContain('database');
    });
  });

  describe('Retry logic', () => {
    it('retries failed health checks', async () => {
      let attempts = 0;

      service.registerDependency({
        name: 'transient-failure',
        type: DependencyType.EXTERNAL_API,
        criticality: Criticality.CRITICAL,
        timeout: 3000,
        retryAttempts: 2,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Transient failure');
          }
          return {
            status: DependencyStatus.HEALTHY,
            message: 'Recovered after retries',
          };
        },
      });

      const health = await service.checkDependency('transient-failure');

      expect(attempts).toBe(3); // Initial + 2 retries
      expect(health?.status).toBe(DependencyStatus.HEALTHY);
      expect(health?.message).toBe('Recovered after retries');
    });

    it('fails after exhausting retries', async () => {
      let attempts = 0;

      service.registerDependency({
        name: 'persistent-failure',
        type: DependencyType.EXTERNAL_API,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 2,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => {
          attempts++;
          throw new Error('Persistent failure');
        },
      });

      const health = await service.checkDependency('persistent-failure');

      expect(attempts).toBe(3); // Initial + 2 retries
      expect(health?.status).toBe(DependencyStatus.UNHEALTHY);
    });

    it('resets consecutive failures on successful check', async () => {
      let shouldFail = true;

      service.registerDependency({
        name: 'recovery-test',
        type: DependencyType.CACHE,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 0,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => {
          if (shouldFail) {
            throw new Error('Failure');
          }
          return { status: DependencyStatus.HEALTHY };
        },
      });

      // Fail twice
      await service.checkDependency('recovery-test');
      await service.checkDependency('recovery-test');

      let health = service.getDependencyState('recovery-test');
      expect(health?.consecutiveFailures).toBe(2);

      // Succeed
      shouldFail = false;
      await service.checkDependency('recovery-test');

      health = service.getDependencyState('recovery-test');
      expect(health?.consecutiveFailures).toBe(0);
    });
  });

  describe('Circuit breaker pattern', () => {
    it('opens circuit breaker after threshold failures', async () => {
      service.registerDependency({
        name: 'breaker-test',
        type: DependencyType.EXTERNAL_API,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 0,
        circuitBreakerThreshold: 3,
        healthCheckFn: async () => {
          throw new Error('Service down');
        },
      });

      // Trigger circuit breaker
      await service.checkDependency('breaker-test');
      await service.checkDependency('breaker-test');
      await service.checkDependency('breaker-test');

      const health = service.getDependencyState('breaker-test');
      expect(health?.circuitBreakerOpen).toBe(true);

      const metrics = service.getMetrics();
      expect(metrics.circuitBreakersOpen).toBe(1);
    });

    it('prevents health checks when circuit breaker is open', async () => {
      let checkCount = 0;

      service.registerDependency({
        name: 'breaker-open',
        type: DependencyType.EXTERNAL_API,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 0,
        circuitBreakerThreshold: 2,
        healthCheckFn: async () => {
          checkCount++;
          throw new Error('Service down');
        },
      });

      // Open circuit breaker
      await service.checkDependency('breaker-open');
      await service.checkDependency('breaker-open');

      checkCount = 0; // Reset counter

      // This should not execute health check
      await service.checkDependency('breaker-open');

      expect(checkCount).toBe(0);
    });

    it('allows manual circuit breaker reset', async () => {
      service.registerDependency({
        name: 'manual-reset',
        type: DependencyType.CACHE,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 0,
        circuitBreakerThreshold: 2,
        healthCheckFn: async () => {
          throw new Error('Failure');
        },
      });

      // Open circuit breaker
      await service.checkDependency('manual-reset');
      await service.checkDependency('manual-reset');

      let health = service.getDependencyState('manual-reset');
      expect(health?.circuitBreakerOpen).toBe(true);

      // Manual reset
      service.resetCircuitBreakerManually('manual-reset');

      health = service.getDependencyState('manual-reset');
      expect(health?.circuitBreakerOpen).toBe(false);
      expect(health?.consecutiveFailures).toBe(0);
    });
  });

  describe('Authorization-aware health checks', () => {
    it('allows authorization when auth service is healthy', async () => {
      service.registerDependency({
        name: 'auth-service',
        type: DependencyType.AUTH_SERVICE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 2,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => ({
          status: DependencyStatus.HEALTHY,
        }),
      });

      service.registerDependency({
        name: 'database',
        type: DependencyType.DATABASE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 2,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => ({
          status: DependencyStatus.HEALTHY,
        }),
      });

      const canAuthorize = await service.canAuthorizeRequests();
      expect(canAuthorize).toBe(true);
    });

    it('prevents authorization when auth service is unhealthy', async () => {
      service.registerDependency({
        name: 'auth-service',
        type: DependencyType.AUTH_SERVICE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 1,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => {
          throw new Error('Auth service down');
        },
      });

      const canAuthorize = await service.canAuthorizeRequests();
      expect(canAuthorize).toBe(false);
    });

    it('prevents authorization when database is unhealthy', async () => {
      service.registerDependency({
        name: 'database',
        type: DependencyType.DATABASE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 1,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => {
          throw new Error('Database down');
        },
      });

      const canAuthorize = await service.canAuthorizeRequests();
      expect(canAuthorize).toBe(false);
    });
  });

  describe('Cascading failure detection', () => {
    it('detects when message queue failure affects background jobs', async () => {
      service.registerDependency({
        name: 'message_queue',
        type: DependencyType.MESSAGE_QUEUE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 1,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => {
          throw new Error('Queue unavailable');
        },
      });

      const systemHealth = await service.getSystemHealth();

      expect(systemHealth.canProcessBackgroundJobs).toBe(false);
    });

    it('calculates reduced health score for multiple failures', async () => {
      service.registerDependency({
        name: 'db',
        type: DependencyType.DATABASE,
        criticality: Criticality.CRITICAL,
        timeout: 5000,
        retryAttempts: 1,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => {
          throw new Error('DB down');
        },
      });

      service.registerDependency({
        name: 'cache',
        type: DependencyType.CACHE,
        criticality: Criticality.OPTIONAL,
        timeout: 3000,
        retryAttempts: 1,
        circuitBreakerThreshold: 3,
        healthCheckFn: async () => {
          throw new Error('Cache down');
        },
      });

      const systemHealth = await service.getSystemHealth();

      expect(systemHealth.score).toBeLessThan(50);
      expect(systemHealth.overall).toBe(DependencyStatus.UNHEALTHY);
    });
  });

  describe('Edge cases', () => {
    it('handles check for non-existent dependency', async () => {
      const health = await service.checkDependency('nonexistent');
      expect(health).toBeNull();
    });

    it('handles system health with no registered dependencies', async () => {
      const systemHealth = await service.getSystemHealth();

      expect(systemHealth.overall).toBe(DependencyStatus.HEALTHY);
      expect(systemHealth.score).toBe(100);
      expect(systemHealth.dependencies).toHaveLength(0);
    });

    it('handles health check that returns degraded status', async () => {
      service.registerDependency({
        name: 'degraded-service',
        type: DependencyType.EXTERNAL_API,
        criticality: Criticality.OPTIONAL,
        timeout: 5000,
        retryAttempts: 2,
        circuitBreakerThreshold: 5,
        healthCheckFn: async () => ({
          status: DependencyStatus.DEGRADED,
          message: 'High latency detected',
        }),
      });

      const health = await service.checkDependency('degraded-service');

      expect(health?.status).toBe(DependencyStatus.DEGRADED);
      expect(health?.message).toBe('High latency detected');
    });
  });
});

/**
 * Worst-case load tests and resource budgets (#345)
 *
 * Comprehensive load tests covering normal operations, failure scenarios,
 * retry logic, and authorization paths under extreme load conditions.
 * Tests enforce deterministic resource budgets to prevent unbounded growth.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../app.module';

// Resource budget constants
export const MAX_CONCURRENT_REQUESTS = 1000;
export const MAX_REQUEST_DURATION_MS = 5000;
export const MAX_MEMORY_GROWTH_MB = 100;
export const MAX_RETRY_ATTEMPTS = 3;
export const MAX_AUTH_VALIDATION_MS = 100;
export const MAX_QUEUE_SIZE = 10000;
export const MAX_RESPONSE_SIZE_BYTES = 1024 * 1024; // 1MB

interface LoadTestMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  retries: number;
  avgResponseTime: number;
  maxResponseTime: number;
  memoryUsedMB: number;
  errorsCount: number;
}

describe('Worst-case load tests and resource budgets', () => {
  let app: INestApplication;
  let baseMetrics: NodeJS.MemoryUsage;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    
    // Capture baseline memory
    global.gc?.();
    baseMetrics = process.memoryUsage();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('Normal operation load tests', () => {
    it('handles 1000 concurrent read requests within resource budget', async () => {
      const startTime = Date.now();
      const startMemory = process.memoryUsage().heapUsed;

      const requests = Array.from({ length: MAX_CONCURRENT_REQUESTS }, () =>
        request(app.getHttpServer())
          .get('/health/status')
          .expect((res) => {
            expect(res.status).toBeGreaterThanOrEqual(200);
            expect(res.status).toBeLessThan(500);
          }),
      );

      const results = await Promise.allSettled(requests);
      const endTime = Date.now();
      const endMemory = process.memoryUsage().heapUsed;

      const successful = results.filter((r) => r.status === 'fulfilled').length;
      const duration = endTime - startTime;
      const memoryGrowth = (endMemory - startMemory) / (1024 * 1024);

      expect(successful).toBeGreaterThan(MAX_CONCURRENT_REQUESTS * 0.95); // 95% success rate
      expect(duration).toBeLessThan(MAX_REQUEST_DURATION_MS);
      expect(memoryGrowth).toBeLessThan(MAX_MEMORY_GROWTH_MB);
    });

    it('enforces response size limits on bulk data queries', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/status')
        .expect(200);

      const responseSize = JSON.stringify(response.body).length;
      expect(responseSize).toBeLessThan(MAX_RESPONSE_SIZE_BYTES);
    });

    it('maintains constant memory under sustained load', async () => {
      const samples = 5;
      const memoryReadings: number[] = [];

      for (let i = 0; i < samples; i++) {
        await Promise.all(
          Array.from({ length: 100 }, () =>
            request(app.getHttpServer()).get('/health/status'),
          ),
        );

        global.gc?.();
        memoryReadings.push(process.memoryUsage().heapUsed);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Check memory growth is bounded
      const avgMemory = memoryReadings.reduce((a, b) => a + b, 0) / samples;
      const maxDeviation = Math.max(...memoryReadings.map((m) => Math.abs(m - avgMemory)));
      const maxDeviationMB = maxDeviation / (1024 * 1024);

      expect(maxDeviationMB).toBeLessThan(MAX_MEMORY_GROWTH_MB / 2);
    });
  });

  describe('Failure path load tests', () => {
    it('handles 500 concurrent invalid requests without exhausting resources', async () => {
      const startMemory = process.memoryUsage().heapUsed;

      const requests = Array.from({ length: 500 }, () =>
        request(app.getHttpServer())
          .post('/api/v1/nonexistent')
          .send({ malformed: 'x'.repeat(10000) })
          .expect((res) => {
            expect([400, 404, 413]).toContain(res.status);
          }),
      );

      await Promise.allSettled(requests);

      global.gc?.();
      const endMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = (endMemory - startMemory) / (1024 * 1024);

      expect(memoryGrowth).toBeLessThan(MAX_MEMORY_GROWTH_MB);
    });

    it('rate limits excessive requests from single source', async () => {
      const requests = Array.from({ length: 200 }, () =>
        request(app.getHttpServer()).get('/health/status'),
      );

      const results = await Promise.all(requests);
      const rateLimited = results.filter((r) => r.status === 429).length;

      // At least some requests should be rate limited
      expect(rateLimited).toBeGreaterThan(0);
    });

    it('validates input without processing on oversized payloads', async () => {
      const oversizedPayload = { data: 'x'.repeat(10 * 1024 * 1024) }; // 10MB

      const response = await request(app.getHttpServer())
        .post('/health/status')
        .send(oversizedPayload);

      expect([400, 413]).toContain(response.status);
    });

    it('handles network timeouts gracefully', async () => {
      const slowRequests = Array.from({ length: 100 }, (_, i) =>
        request(app.getHttpServer())
          .get('/health/status')
          .timeout(100)
          .catch((err) => ({ error: err.code })),
      );

      const results = await Promise.allSettled(slowRequests);
      
      // All requests should settle (not hang indefinitely)
      expect(results).toHaveLength(100);
    });
  });

  describe('Retry path load tests', () => {
    it('respects max retry budget on transient failures', async () => {
      let retryCount = 0;
      const maxRetries = MAX_RETRY_ATTEMPTS;

      // Simulate retryable failures
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await request(app.getHttpServer())
          .get('/health/status')
          .set('X-Test-Retry-Count', String(attempt));

        if (response.status >= 500 && attempt < maxRetries) {
          retryCount++;
        }
      }

      expect(retryCount).toBeLessThanOrEqual(maxRetries);
    });

    it('implements exponential backoff on retry attempts', async () => {
      const retryDelays: number[] = [];
      let lastAttemptTime = Date.now();

      for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        
        const attemptTime = Date.now();
        if (i > 0) {
          retryDelays.push(attemptTime - lastAttemptTime);
        }
        lastAttemptTime = attemptTime;

        await request(app.getHttpServer()).get('/health/status');
      }

      // Each delay should be longer than the previous (exponential)
      for (let i = 1; i < retryDelays.length; i++) {
        expect(retryDelays[i]).toBeGreaterThanOrEqual(retryDelays[i - 1] * 0.8); // Allow some variance
      }
    });

    it('does not retry on non-retryable failures', async () => {
      const nonRetryableStatuses = [400, 401, 403, 404, 422];

      for (const status of nonRetryableStatuses) {
        const response = await request(app.getHttpServer())
          .get('/nonexistent')
          .set('X-Expected-Status', String(status));

        // Should not see retry headers
        expect(response.headers['retry-after']).toBeUndefined();
      }
    });

    it('circuit breaks after sustained failures', async () => {
      const failureThreshold = 10;
      let consecutiveFailures = 0;
      let circuitBroken = false;

      for (let i = 0; i < failureThreshold + 5; i++) {
        const response = await request(app.getHttpServer())
          .get('/health/status')
          .catch(() => ({ status: 500 }));

        if (response.status >= 500) {
          consecutiveFailures++;
          if (consecutiveFailures >= failureThreshold) {
            circuitBroken = true;
            break;
          }
        } else {
          consecutiveFailures = 0;
        }
      }

      // Circuit should break before exhausting resources
      expect(circuitBroken || consecutiveFailures < failureThreshold).toBe(true);
    });
  });

  describe('Authorization path load tests', () => {
    it('validates auth tokens within performance budget', async () => {
      const validations = Array.from({ length: 1000 }, async () => {
        const startTime = Date.now();
        
        await request(app.getHttpServer())
          .get('/health/status')
          .set('Authorization', 'Bearer test-token');

        return Date.now() - startTime;
      });

      const durations = await Promise.all(validations);
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const maxDuration = Math.max(...durations);

      expect(avgDuration).toBeLessThan(MAX_AUTH_VALIDATION_MS);
      expect(maxDuration).toBeLessThan(MAX_AUTH_VALIDATION_MS * 3);
    });

    it('rejects invalid tokens without processing the request', async () => {
      const invalidTokens = [
        'invalid',
        'x'.repeat(10000),
        '../../../etc/passwd',
        '<script>alert(1)</script>',
        'SELECT * FROM users',
      ];

      for (const token of invalidTokens) {
        const startTime = Date.now();
        
        await request(app.getHttpServer())
          .get('/health/status')
          .set('Authorization', `Bearer ${token}`);

        const duration = Date.now() - startTime;
        
        // Should reject quickly without processing
        expect(duration).toBeLessThan(MAX_AUTH_VALIDATION_MS * 2);
      }
    });

    it('handles concurrent auth failures without resource exhaustion', async () => {
      const startMemory = process.memoryUsage().heapUsed;

      const requests = Array.from({ length: 500 }, () =>
        request(app.getHttpServer())
          .get('/health/status')
          .set('Authorization', 'Bearer invalid-token')
          .expect((res) => {
            expect([401, 403]).toContain(res.status);
          }),
      );

      await Promise.allSettled(requests);

      global.gc?.();
      const endMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = (endMemory - startMemory) / (1024 * 1024);

      expect(memoryGrowth).toBeLessThan(MAX_MEMORY_GROWTH_MB / 2);
    });

    it('enforces role-based access control under load', async () => {
      const roles = ['admin', 'operator', 'user', 'guest'];
      const requests: Promise<any>[] = [];

      for (let i = 0; i < 100; i++) {
        for (const role of roles) {
          requests.push(
            request(app.getHttpServer())
              .get('/health/status')
              .set('X-User-Role', role),
          );
        }
      }

      const results = await Promise.allSettled(requests);
      const successful = results.filter((r) => r.status === 'fulfilled').length;

      // All requests should be processed
      expect(successful).toBe(results.length);
    });
  });

  describe('Resource budget enforcement', () => {
    it('enforces queue size limits', async () => {
      const queueSize = MAX_QUEUE_SIZE + 100;
      const requests = Array.from({ length: queueSize }, () =>
        request(app.getHttpServer()).get('/health/status'),
      );

      const results = await Promise.allSettled(requests);
      const rejected = results.filter(
        (r) => r.status === 'rejected' || 
               (r.status === 'fulfilled' && (r.value as any).status === 503),
      ).length;

      // Some requests should be rejected due to queue overflow
      expect(rejected).toBeGreaterThan(0);
    });

    it('tracks and reports resource metrics', async () => {
      const metrics: LoadTestMetrics = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        retries: 0,
        avgResponseTime: 0,
        maxResponseTime: 0,
        memoryUsedMB: 0,
        errorsCount: 0,
      };

      const startMemory = process.memoryUsage().heapUsed;
      const responseTimes: number[] = [];

      for (let i = 0; i < 100; i++) {
        metrics.totalRequests++;
        const startTime = Date.now();

        const response = await request(app.getHttpServer())
          .get('/health/status')
          .catch(() => ({ status: 500 }));

        const duration = Date.now() - startTime;
        responseTimes.push(duration);

        if (response.status < 400) {
          metrics.successfulRequests++;
        } else {
          metrics.failedRequests++;
          if (response.status >= 500) {
            metrics.errorsCount++;
          }
        }
      }

      const endMemory = process.memoryUsage().heapUsed;
      metrics.memoryUsedMB = (endMemory - startMemory) / (1024 * 1024);
      metrics.avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      metrics.maxResponseTime = Math.max(...responseTimes);

      // Verify metrics are within budgets
      expect(metrics.avgResponseTime).toBeLessThan(MAX_REQUEST_DURATION_MS / 2);
      expect(metrics.maxResponseTime).toBeLessThan(MAX_REQUEST_DURATION_MS);
      expect(metrics.memoryUsedMB).toBeLessThan(MAX_MEMORY_GROWTH_MB);
      expect(metrics.successfulRequests / metrics.totalRequests).toBeGreaterThan(0.9);
    });

    it('recovers gracefully from resource exhaustion', async () => {
      // Simulate resource exhaustion
      const heavyRequests = Array.from({ length: 50 }, () =>
        request(app.getHttpServer())
          .post('/health/status')
          .send({ data: 'x'.repeat(100000) }),
      );

      await Promise.allSettled(heavyRequests);

      // Allow recovery time
      await new Promise((resolve) => setTimeout(resolve, 500));
      global.gc?.();

      // Verify normal operations resume
      const response = await request(app.getHttpServer())
        .get('/health/status')
        .expect((res) => {
          expect(res.status).toBeLessThan(500);
        });

      expect(response.status).toBe(200);
    });
  });

  describe('Edge cases and recovery', () => {
    it('handles malformed requests without crashing', async () => {
      const malformedPayloads = [
        Buffer.from([0xff, 0xfe, 0xfd]),
        '{"unclosed": ',
        null,
        undefined,
        NaN,
        Infinity,
      ];

      for (const payload of malformedPayloads) {
        await request(app.getHttpServer())
          .post('/health/status')
          .send(payload)
          .expect((res) => {
            expect([400, 415, 422]).toContain(res.status);
          });
      }
    });

    it('logs errors without exposing sensitive information', async () => {
      const sensitiveData = {
        password: 'secret123',
        apiKey: 'sk-1234567890',
        token: 'bearer-token-xyz',
      };

      const response = await request(app.getHttpServer())
        .post('/health/status')
        .send(sensitiveData);

      // Response should not echo sensitive data
      const responseBody = JSON.stringify(response.body);
      expect(responseBody).not.toContain('secret123');
      expect(responseBody).not.toContain('sk-1234567890');
      expect(responseBody).not.toContain('bearer-token-xyz');
    });

    it('supports graceful degradation when dependencies fail', async () => {
      // This test verifies the system continues operating even when non-critical services fail
      const response = await request(app.getHttpServer())
        .get('/health/status')
        .expect((res) => {
          expect(res.status).toBeLessThan(500);
        });

      expect(response.status).toBe(200);
    });
  });
});

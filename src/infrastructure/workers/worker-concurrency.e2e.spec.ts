import { Test, TestingModule } from "@nestjs/testing";
import { EventEmitter2, EventEmitterModule } from "@nestjs/event-emitter";
import { ConcurrencyLimiterService, BackpressureStrategy, ConcurrencyConfig } from "./concurrency-limiter.service";
import { BackgroundWorkerService } from "./background-worker.service";
import { BackgroundWorkerModule } from "./background-worker.module";
import { ConfigModule } from "@nestjs/config";
import { JobStatus, JobPriority } from "./worker.interface";

describe("Worker Concurrency with Backpressure (E2E)", () => {
  let module: TestingModule;
  let workerService: BackgroundWorkerService;
  let concurrencyLimiter: ConcurrencyLimiterService;
  let eventEmitter: EventEmitter2;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        EventEmitterModule.forRoot(),
        BackgroundWorkerModule,
      ],
    }).compile();

    workerService = module.get<BackgroundWorkerService>(BackgroundWorkerService);
    concurrencyLimiter = module.get<ConcurrencyLimiterService>(ConcurrencyLimiterService);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);

    // Reset to default config for each test
    concurrencyLimiter.updateConfig({
      maxConcurrent: 10,
      backpressureStrategy: BackpressureStrategy.QUEUE,
      maxQueueSize: 100,
      throttleTimeoutMs: 30000,
    });
  });

  afterEach(async () => {
    await module.close();
  });

  describe("Normal flow - under concurrency limit", () => {
    it("should enqueue jobs when under the limit", async () => {
      const job1 = await workerService.enqueue({
        type: "test.job",
        payload: { data: "test1" },
      });

      const job2 = await workerService.enqueue({
        type: "test.job",
        payload: { data: "test2" },
      });

      expect(job1.status).toBe(JobStatus.PENDING);
      expect(job2.status).toBe(JobStatus.PENDING);

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.activeJobs).toBe(2);
      expect(metrics.queuedJobs).toBe(0);
      expect(metrics.limitReached).toBe(false);
    });

    it("should release slots when jobs complete", async () => {
      const job = await workerService.enqueue({
        type: "test.job",
        payload: { data: "test" },
      });

      let metricsBefore = concurrencyLimiter.getMetrics();
      expect(metricsBefore.activeJobs).toBe(1);

      // Simulate completion
      concurrencyLimiter.release(job.id);

      let metricsAfter = concurrencyLimiter.getMetrics();
      expect(metricsAfter.activeJobs).toBe(0);
    });
  });

  describe("Backpressure - REJECT strategy", () => {
    beforeEach(() => {
      concurrencyLimiter.updateConfig({
        maxConcurrent: 2,
        backpressureStrategy: BackpressureStrategy.REJECT,
      });
    });

    it("should reject jobs when limit is reached", async () => {
      // Fill the slots
      await workerService.enqueue({ type: "test.job", payload: { data: "1" } });
      await workerService.enqueue({ type: "test.job", payload: { data: "2" } });

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.activeJobs).toBe(2);
      expect(metrics.limitReached).toBe(true);

      // Next job should be rejected
      await expect(
        workerService.enqueue({ type: "test.job", payload: { data: "3" } })
      ).rejects.toThrow(/Concurrency limit reached/);
    });

    it("should emit backpressure events", async () => {
      const limitReachedSpy = jest.fn();
      const backpressureSpy = jest.fn();
      const rejectedSpy = jest.fn();

      eventEmitter.on("concurrency.limit.reached", limitReachedSpy);
      eventEmitter.on("concurrency.backpressure.applied", backpressureSpy);
      eventEmitter.on("concurrency.job.rejected", rejectedSpy);

      // Fill slots
      await workerService.enqueue({ type: "test.job", payload: { data: "1" } });
      await workerService.enqueue({ type: "test.job", payload: { data: "2" } });

      // Try to exceed
      try {
        await workerService.enqueue({ type: "test.job", payload: { data: "3" } });
      } catch (err) {
        // Expected
      }

      expect(limitReachedSpy).toHaveBeenCalled();
      expect(backpressureSpy).toHaveBeenCalled();
      expect(rejectedSpy).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "limit_reached" })
      );
    });
  });

  describe("Backpressure - QUEUE strategy", () => {
    beforeEach(() => {
      concurrencyLimiter.updateConfig({
        maxConcurrent: 2,
        backpressureStrategy: BackpressureStrategy.QUEUE,
        maxQueueSize: 5,
      });
    });

    it("should queue jobs when limit is reached", async () => {
      // Fill slots
      const job1 = await workerService.enqueue({ type: "test.job", payload: { data: "1" } });
      const job2 = await workerService.enqueue({ type: "test.job", payload: { data: "2" } });

      // Start queueing (this will block until released)
      const job3Promise = workerService.enqueue({ type: "test.job", payload: { data: "3" } });

      // Give it time to queue
      await new Promise((resolve) => setTimeout(resolve, 50));

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.activeJobs).toBe(2);
      expect(metrics.queuedJobs).toBe(1);

      // Release a slot
      concurrencyLimiter.release(job1.id);

      // Wait for queued job to be processed
      const job3 = await job3Promise;
      expect(job3.status).toBe(JobStatus.PENDING);

      const metricsAfter = concurrencyLimiter.getMetrics();
      expect(metricsAfter.activeJobs).toBe(2);
      expect(metricsAfter.queuedJobs).toBe(0);
    });

    it("should reject when queue is full", async () => {
      // Fill all slots and queue
      await workerService.enqueue({ type: "test.job", payload: { data: "1" } });
      await workerService.enqueue({ type: "test.job", payload: { data: "2" } });

      const queuePromises = [];
      for (let i = 3; i <= 7; i++) {
        queuePromises.push(
          workerService.enqueue({ type: "test.job", payload: { data: String(i) } })
        );
      }

      // Give time to queue
      await new Promise((resolve) => setTimeout(resolve, 50));

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.queuedJobs).toBe(5); // maxQueueSize

      // Next job should be rejected (queue full)
      await expect(
        workerService.enqueue({ type: "test.job", payload: { data: "overflow" } })
      ).rejects.toThrow(/Queue full/);
    });

    it("should emit queue events", async () => {
      const queuedSpy = jest.fn();
      const dequeuedSpy = jest.fn();

      eventEmitter.on("concurrency.job.queued", queuedSpy);
      eventEmitter.on("concurrency.job.dequeued", dequeuedSpy);

      // Fill slots
      const job1 = await workerService.enqueue({ type: "test.job", payload: { data: "1" } });
      await workerService.enqueue({ type: "test.job", payload: { data: "2" } });

      // Queue a job
      const job3Promise = workerService.enqueue({ type: "test.job", payload: { data: "3" } });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(queuedSpy).toHaveBeenCalled();

      // Release and dequeue
      concurrencyLimiter.release(job1.id);
      await job3Promise;

      expect(dequeuedSpy).toHaveBeenCalled();
    });
  });

  describe("Backpressure - THROTTLE strategy", () => {
    beforeEach(() => {
      concurrencyLimiter.updateConfig({
        maxConcurrent: 2,
        backpressureStrategy: BackpressureStrategy.THROTTLE,
        throttleTimeoutMs: 500, // Short timeout for testing
      });
    });

    it("should block until slot available", async () => {
      // Fill slots
      const job1 = await workerService.enqueue({ type: "test.job", payload: { data: "1" } });
      await workerService.enqueue({ type: "test.job", payload: { data: "2" } });

      // Start throttled job (will block)
      const job3Promise = workerService.enqueue({ type: "test.job", payload: { data: "3" } });

      // Release after delay
      setTimeout(() => concurrencyLimiter.release(job1.id), 100);

      // Should complete after release
      const job3 = await job3Promise;
      expect(job3.status).toBe(JobStatus.PENDING);
    });

    it("should timeout and reject if no slot opens", async () => {
      // Fill slots
      await workerService.enqueue({ type: "test.job", payload: { data: "1" } });
      await workerService.enqueue({ type: "test.job", payload: { data: "2" } });

      // Try to enqueue with throttle (will timeout)
      await expect(
        workerService.enqueue({ type: "test.job", payload: { data: "3" } })
      ).rejects.toThrow(/Throttle timeout/);
    });
  });

  describe("Retry flow with concurrency", () => {
    it("should acquire slot when retrying a job", async () => {
      concurrencyLimiter.updateConfig({ maxConcurrent: 2 });

      const job1 = await workerService.enqueue({ type: "test.job", payload: { data: "1" } });

      // Simulate failure
      const jobStore = (workerService as any).jobStore;
      const job = jobStore.get(job1.id);
      job.status = JobStatus.FAILED;
      concurrencyLimiter.release(job1.id);

      let metricsBefore = concurrencyLimiter.getMetrics();
      expect(metricsBefore.activeJobs).toBe(0);

      // Retry should acquire slot
      await workerService.retryJob(job1.id);

      let metricsAfter = concurrencyLimiter.getMetrics();
      expect(metricsAfter.activeJobs).toBe(1);
    });

    it("should fail retry if no slot available", async () => {
      concurrencyLimiter.updateConfig({
        maxConcurrent: 1,
        backpressureStrategy: BackpressureStrategy.REJECT,
      });

      const job1 = await workerService.enqueue({ type: "test.job", payload: { data: "1" } });

      // Create a failed job
      const job2 = await workerService.enqueue({ type: "test.job", payload: { data: "2" } });
      const jobStore = (workerService as any).jobStore;
      const job = jobStore.get(job2.id);
      job.status = JobStatus.FAILED;
      concurrencyLimiter.release(job2.id);

      // Retry should fail (slot occupied by job1)
      await expect(workerService.retryJob(job2.id)).rejects.toThrow(/Concurrency limit reached/);
    });
  });

  describe("Cancellation with concurrency", () => {
    it("should release slot when job is cancelled", async () => {
      const job = await workerService.enqueue({ type: "test.job", payload: { data: "test" } });

      let metricsBefore = concurrencyLimiter.getMetrics();
      expect(metricsBefore.activeJobs).toBe(1);

      await workerService.cancelJob(job.id);

      let metricsAfter = concurrencyLimiter.getMetrics();
      expect(metricsAfter.activeJobs).toBe(0);
    });

    it("should release slot on cooperative cancellation", async () => {
      const job = await workerService.enqueue({ type: "test.job", payload: { data: "test" } });

      // Simulate active job requesting cancel
      const jobStore = (workerService as any).jobStore;
      const storedJob = jobStore.get(job.id);
      storedJob.status = JobStatus.ACTIVE;
      storedJob.cancelRequested = true;

      let metricsBefore = concurrencyLimiter.getMetrics();
      expect(metricsBefore.activeJobs).toBe(1);

      await workerService.acknowledgeCancel(job.id);

      let metricsAfter = concurrencyLimiter.getMetrics();
      expect(metricsAfter.activeJobs).toBe(0);
    });
  });

  describe("Authorization paths", () => {
    it("should respect concurrency limits across different job types", async () => {
      concurrencyLimiter.updateConfig({ maxConcurrent: 2 });

      await workerService.enqueue({ type: "webhook.delivery", payload: { url: "test1" } });
      await workerService.enqueue({ type: "email.send", payload: { to: "test2" } });

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.activeJobs).toBe(2);
      expect(metrics.limitReached).toBe(true);

      // Should reject regardless of type
      await expect(
        workerService.enqueue({ type: "data.export", payload: { data: "test3" } })
      ).rejects.toThrow();
    });

    it("should allow high-priority jobs to enqueue (but still count against limit)", async () => {
      concurrencyLimiter.updateConfig({ maxConcurrent: 2 });

      await workerService.enqueue({
        type: "test.job",
        payload: { data: "1" },
        priority: JobPriority.LOW,
      });

      await workerService.enqueue({
        type: "test.job",
        payload: { data: "2" },
        priority: JobPriority.CRITICAL,
      });

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.activeJobs).toBe(2);

      // High priority still counts against concurrency limit
      await expect(
        workerService.enqueue({
          type: "test.job",
          payload: { data: "3" },
          priority: JobPriority.CRITICAL,
        })
      ).rejects.toThrow();
    });
  });

  describe("Metrics and monitoring", () => {
    it("should track utilization percentage", async () => {
      concurrencyLimiter.updateConfig({ maxConcurrent: 10 });

      await workerService.enqueue({ type: "test.job", payload: { data: "1" } });
      await workerService.enqueue({ type: "test.job", payload: { data: "2" } });

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.utilizationPercent).toBe(20); // 2/10 = 20%
    });

    it("should track queue wait times", async () => {
      concurrencyLimiter.updateConfig({
        maxConcurrent: 1,
        backpressureStrategy: BackpressureStrategy.QUEUE,
      });

      await workerService.enqueue({ type: "test.job", payload: { data: "1" } });

      // Queue a job
      const job2Promise = workerService.enqueue({ type: "test.job", payload: { data: "2" } });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.avgQueueWaitMs).toBeGreaterThan(0);
      expect(metrics.maxQueueWaitMs).toBeGreaterThan(0);
    });

    it("should include concurrency metrics in worker metrics", async () => {
      const metrics = await workerService.getMetrics();
      expect(metrics.concurrency).toBeDefined();
      expect(metrics.concurrency.activeJobs).toBeDefined();
      expect(metrics.concurrency.maxConcurrent).toBeDefined();
      expect(metrics.concurrency.utilizationPercent).toBeDefined();
    });
  });

  describe("Edge cases and failure modes", () => {
    it("should handle rapid release and acquire cycles", async () => {
      concurrencyLimiter.updateConfig({ maxConcurrent: 2 });

      for (let i = 0; i < 10; i++) {
        const job = await workerService.enqueue({ type: "test.job", payload: { data: String(i) } });
        concurrencyLimiter.release(job.id);
      }

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.activeJobs).toBe(0);
    });

    it("should not crash on double release", async () => {
      const job = await workerService.enqueue({ type: "test.job", payload: { data: "test" } });

      concurrencyLimiter.release(job.id);
      expect(() => concurrencyLimiter.release(job.id)).not.toThrow();

      const metrics = concurrencyLimiter.getMetrics();
      expect(metrics.activeJobs).toBe(0);
    });

    it("should clear queue on demand", async () => {
      concurrencyLimiter.updateConfig({
        maxConcurrent: 1,
        backpressureStrategy: BackpressureStrategy.QUEUE,
      });

      await workerService.enqueue({ type: "test.job", payload: { data: "1" } });

      // Queue some jobs
      const promises = [
        workerService.enqueue({ type: "test.job", payload: { data: "2" } }),
        workerService.enqueue({ type: "test.job", payload: { data: "3" } }),
      ];

      await new Promise((resolve) => setTimeout(resolve, 50));

      let metricsBefore = concurrencyLimiter.getMetrics();
      expect(metricsBefore.queuedJobs).toBe(2);

      concurrencyLimiter.clearQueue();

      let metricsAfter = concurrencyLimiter.getMetrics();
      expect(metricsAfter.queuedJobs).toBe(0);

      // Promises should be rejected
      await expect(Promise.all(promises)).rejects.toThrow(/Queue cleared/);
    });

    it("should handle config updates at runtime", async () => {
      concurrencyLimiter.updateConfig({ maxConcurrent: 5 });

      await workerService.enqueue({ type: "test.job", payload: { data: "1" } });
      await workerService.enqueue({ type: "test.job", payload: { data: "2" } });

      let metricsBefore = concurrencyLimiter.getMetrics();
      expect(metricsBefore.maxConcurrent).toBe(5);

      // Reduce limit
      concurrencyLimiter.updateConfig({ maxConcurrent: 1 });

      let metricsAfter = concurrencyLimiter.getMetrics();
      expect(metricsAfter.maxConcurrent).toBe(1);
      expect(metricsAfter.limitReached).toBe(true); // Now over limit
    });
  });
});

import { Test, TestingModule } from "@nestjs/testing";
import { DeadLetterInspectionService } from "./dead-letter-inspection.service";
import { BackgroundWorkerService } from "./background-worker.service";
import { JobStatus, JobPriority } from "./worker.interface";

describe("DeadLetterInspectionService", () => {
  let service: DeadLetterInspectionService;
  let workerService: jest.Mocked<BackgroundWorkerService>;

  beforeEach(async () => {
    const mockWorkerService = {
      listJobs: jest.fn(),
      getJob: jest.fn(),
      retryJob: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeadLetterInspectionService,
        {
          provide: BackgroundWorkerService,
          useValue: mockWorkerService,
        },
      ],
    }).compile();

    service = module.get<DeadLetterInspectionService>(DeadLetterInspectionService);
    workerService = module.get(BackgroundWorkerService) as jest.Mocked<BackgroundWorkerService>;
  });

  describe("getDeadLetterStats", () => {
    it("should return comprehensive statistics for dead-lettered jobs", async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago

      const mockJobs = [
        {
          id: "job_1",
          type: "webhook.delivery",
          status: JobStatus.DEAD_LETTER,
          error: "Connection timeout",
          attempts: 5,
          deadLetteredAt: oldDate,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 5,
          backoffMs: 1000,
          createdAt: oldDate,
          updatedAt: oldDate,
          schemaVersion: "1.0.0",
        },
        {
          id: "job_2",
          type: "webhook.delivery",
          status: JobStatus.DEAD_LETTER,
          error: "Connection timeout",
          attempts: 5,
          deadLetteredAt: now,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 5,
          backoffMs: 1000,
          createdAt: now,
          updatedAt: now,
          schemaVersion: "1.0.0",
        },
        {
          id: "job_3",
          type: "email.send",
          status: JobStatus.DEAD_LETTER,
          error: "SMTP error: Invalid recipient",
          attempts: 3,
          deadLetteredAt: now,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 3,
          backoffMs: 1000,
          createdAt: now,
          updatedAt: now,
          schemaVersion: "1.0.0",
        },
      ];

      workerService.listJobs.mockResolvedValue(mockJobs);

      const stats = await service.getDeadLetterStats();

      expect(stats.total).toBe(3);
      expect(stats.byType["webhook.delivery"]).toBe(2);
      expect(stats.byType["email.send"]).toBe(1);
      expect(stats.oldestJob).toBeDefined();
      expect(stats.oldestJob?.id).toBe("job_1");
      expect(stats.recentFailures).toHaveLength(3);
    });

    it("should handle empty dead-letter queue", async () => {
      workerService.listJobs.mockResolvedValue([]);

      const stats = await service.getDeadLetterStats();

      expect(stats.total).toBe(0);
      expect(stats.byType).toEqual({});
      expect(stats.oldestJob).toBeUndefined();
      expect(stats.recentFailures).toHaveLength(0);
    });
  });

  describe("listDeadLetterJobs", () => {
    it("should filter jobs by type", async () => {
      const mockJobs = [
        {
          id: "job_1",
          type: "webhook.delivery",
          status: JobStatus.DEAD_LETTER,
          error: "timeout",
          attempts: 5,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 5,
          backoffMs: 1000,
          createdAt: new Date(),
          updatedAt: new Date(),
          schemaVersion: "1.0.0",
        },
        {
          id: "job_2",
          type: "email.send",
          status: JobStatus.DEAD_LETTER,
          error: "smtp error",
          attempts: 3,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 3,
          backoffMs: 1000,
          createdAt: new Date(),
          updatedAt: new Date(),
          schemaVersion: "1.0.0",
        },
      ];

      workerService.listJobs.mockResolvedValue(mockJobs);

      const filtered = await service.listDeadLetterJobs({ type: "webhook.delivery" });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].type).toBe("webhook.delivery");
    });

    it("should filter jobs by error pattern", async () => {
      const mockJobs = [
        {
          id: "job_1",
          type: "webhook.delivery",
          status: JobStatus.DEAD_LETTER,
          error: "Connection timeout",
          attempts: 5,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 5,
          backoffMs: 1000,
          createdAt: new Date(),
          updatedAt: new Date(),
          schemaVersion: "1.0.0",
        },
        {
          id: "job_2",
          type: "email.send",
          status: JobStatus.DEAD_LETTER,
          error: "SMTP error",
          attempts: 3,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 3,
          backoffMs: 1000,
          createdAt: new Date(),
          updatedAt: new Date(),
          schemaVersion: "1.0.0",
        },
      ];

      workerService.listJobs.mockResolvedValue(mockJobs);

      const filtered = await service.listDeadLetterJobs({ errorPattern: "timeout" });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].error).toContain("timeout");
    });

    it("should filter jobs by age", async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 50 * 60 * 60 * 1000); // 50 hours ago
      const recentDate = new Date(now.getTime() - 10 * 60 * 60 * 1000); // 10 hours ago

      const mockJobs = [
        {
          id: "job_old",
          type: "webhook.delivery",
          status: JobStatus.DEAD_LETTER,
          error: "timeout",
          attempts: 5,
          deadLetteredAt: oldDate,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 5,
          backoffMs: 1000,
          createdAt: oldDate,
          updatedAt: oldDate,
          schemaVersion: "1.0.0",
        },
        {
          id: "job_recent",
          type: "email.send",
          status: JobStatus.DEAD_LETTER,
          error: "smtp error",
          attempts: 3,
          deadLetteredAt: recentDate,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 3,
          backoffMs: 1000,
          createdAt: recentDate,
          updatedAt: recentDate,
          schemaVersion: "1.0.0",
        },
      ];

      workerService.listJobs.mockResolvedValue(mockJobs);

      const filtered = await service.listDeadLetterJobs({ minAge: 24 });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("job_old");
    });
  });

  describe("safeRetryJob", () => {
    it("should retry a dead-lettered job", async () => {
      const mockJob = {
        id: "job_1",
        type: "webhook.delivery",
        status: JobStatus.DEAD_LETTER,
        error: "timeout",
        attempts: 5,
        payload: {},
        priority: JobPriority.NORMAL,
        maxAttempts: 5,
        backoffMs: 1000,
        createdAt: new Date(),
        updatedAt: new Date(),
        schemaVersion: "1.0.0",
      };

      workerService.getJob.mockResolvedValue(mockJob);
      workerService.retryJob.mockResolvedValue({ ...mockJob, status: JobStatus.PENDING });

      const result = await service.safeRetryJob("job_1", "operator@example.com");

      expect(result).toBeDefined();
      expect(result?.status).toBe(JobStatus.PENDING);
      expect(workerService.retryJob).toHaveBeenCalledWith("job_1");
    });

    it("should return null for non-existent jobs", async () => {
      workerService.getJob.mockResolvedValue(undefined);

      const result = await service.safeRetryJob("nonexistent", "operator@example.com");

      expect(result).toBeNull();
      expect(workerService.retryJob).not.toHaveBeenCalled();
    });

    it("should return null for jobs not in dead-letter state", async () => {
      const mockJob = {
        id: "job_1",
        type: "webhook.delivery",
        status: JobStatus.COMPLETED,
        attempts: 1,
        payload: {},
        priority: JobPriority.NORMAL,
        maxAttempts: 5,
        backoffMs: 1000,
        createdAt: new Date(),
        updatedAt: new Date(),
        schemaVersion: "1.0.0",
      };

      workerService.getJob.mockResolvedValue(mockJob);

      const result = await service.safeRetryJob("job_1", "operator@example.com");

      expect(result).toBeNull();
      expect(workerService.retryJob).not.toHaveBeenCalled();
    });
  });

  describe("batchRetryJobs", () => {
    it("should retry multiple jobs and report results", async () => {
      const mockJobs = [
        {
          id: "job_1",
          type: "webhook.delivery",
          status: JobStatus.DEAD_LETTER,
          error: "timeout",
          attempts: 5,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 5,
          backoffMs: 1000,
          createdAt: new Date(),
          updatedAt: new Date(),
          schemaVersion: "1.0.0",
        },
        {
          id: "job_2",
          type: "email.send",
          status: JobStatus.DEAD_LETTER,
          error: "smtp error",
          attempts: 3,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 3,
          backoffMs: 1000,
          createdAt: new Date(),
          updatedAt: new Date(),
          schemaVersion: "1.0.0",
        },
      ];

      workerService.listJobs.mockResolvedValue(mockJobs);
      workerService.getJob.mockImplementation((id) =>
        Promise.resolve(mockJobs.find((j) => j.id === id))
      );
      workerService.retryJob.mockResolvedValue({ ...mockJobs[0], status: JobStatus.PENDING });

      const result = await service.batchRetryJobs({}, "operator@example.com", false);

      expect(result.attempted).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
    });

    it("should support dry-run mode", async () => {
      const mockJobs = [
        {
          id: "job_1",
          type: "webhook.delivery",
          status: JobStatus.DEAD_LETTER,
          error: "timeout",
          attempts: 5,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 5,
          backoffMs: 1000,
          createdAt: new Date(),
          updatedAt: new Date(),
          schemaVersion: "1.0.0",
        },
      ];

      workerService.listJobs.mockResolvedValue(mockJobs);

      const result = await service.batchRetryJobs({}, "operator@example.com", true);

      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(workerService.retryJob).not.toHaveBeenCalled();
    });
  });

  describe("purgeOldDeadLetterJobs", () => {
    it("should report jobs that would be purged in dry-run mode", async () => {
      const oldDate = new Date(Date.now() - 50 * 60 * 60 * 1000); // 50 hours ago
      const mockJobs = [
        {
          id: "job_1",
          type: "webhook.delivery",
          status: JobStatus.DEAD_LETTER,
          error: "timeout",
          attempts: 5,
          deadLetteredAt: oldDate,
          payload: {},
          priority: JobPriority.NORMAL,
          maxAttempts: 5,
          backoffMs: 1000,
          createdAt: oldDate,
          updatedAt: oldDate,
          schemaVersion: "1.0.0",
        },
      ];

      workerService.listJobs.mockResolvedValue(mockJobs);

      const result = await service.purgeOldDeadLetterJobs(24, "admin@example.com", true);

      expect(result.purged).toBe(1);
      expect(result.dryRun).toBe(true);
    });
  });
});


import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { PartialFailureService } from "./partial-failure.service";
import { PartialFailure, PartialFailureStatus, PartialFailureSeverity } from "./entities/partial-failure.entity";

describe("PartialFailureService", () => {
  let service: PartialFailureService;
  let mockRepo: any;

  beforeEach(async () => {
    mockRepo = {
      create: jest.fn().mockImplementation((dto) => dto),
      save: jest.fn().mockImplementation((entity) => Promise.resolve({ id: "123", ...entity })),
      findOne: jest.fn(),
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartialFailureService,
        {
          provide: getRepositoryToken(PartialFailure),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<PartialFailureService>(PartialFailureService);
  });

  it("should report a new failure and scrub secrets", async () => {
    const data = {
      operationType: "API_CALL",
      metadata: { password: "secret123", other: "ok" }
    };
    const result = await service.reportFailure(data as any);
    expect(result.metadata.password).toBe("[REDACTED]");
    expect(result.metadata.other).toBe("ok");
    expect(mockRepo.save).toHaveBeenCalled();
  });

  it("should resolve a failure", async () => {
    mockRepo.findOne.mockResolvedValue({ id: "1", status: PartialFailureStatus.UNRESOLVED });
    const result = await service.resolveFailure("1");
    expect(result.status).toBe(PartialFailureStatus.RESOLVED);
    expect(result.resolvedAt).toBeDefined();
    expect(mockRepo.save).toHaveBeenCalledWith(result);
  });

  it("should ignore a failure", async () => {
    mockRepo.findOne.mockResolvedValue({ id: "1", status: PartialFailureStatus.UNRESOLVED });
    const result = await service.ignoreFailure("1");
    expect(result.status).toBe(PartialFailureStatus.IGNORED);
    expect(result.resolvedAt).toBeDefined();
    expect(mockRepo.save).toHaveBeenCalledWith(result);
  });

  it("should group failures by operation type for dashboard", async () => {
    mockRepo.find.mockResolvedValue([
      { id: "1", operationType: "OP_A", status: PartialFailureStatus.UNRESOLVED, createdAt: new Date() },
      { id: "2", operationType: "OP_A", status: PartialFailureStatus.UNRESOLVED, createdAt: new Date(Date.now() - 3600000) }, // stale
      { id: "3", operationType: "OP_B", retryable: true, status: PartialFailureStatus.UNRESOLVED, createdAt: new Date() },
    ]);
    const report = await service.getDashboardReport();
    expect(report.totalUnresolved).toBe(3);
    expect(report.groupedByType["OP_A"]).toHaveLength(2);
    expect(report.groupedByType["OP_B"]).toHaveLength(1);
    expect(report.summary[1].ageInHours).toBeGreaterThanOrEqual(1);
  });
});

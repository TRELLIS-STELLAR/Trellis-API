import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { HttpStatus } from "@nestjs/common";
import { SyntheticJourneyController } from "../../src/monitoring/synthetic-journey/synthetic-journey.controller";
import { SyntheticJourneyMonitorService } from "../../src/monitoring/synthetic-journey/synthetic-journey.service";
import { MonitoringMetricsService } from "../../src/monitoring/monitoring-metrics.service";
import { Response } from "express";

describe("Synthetic Journey Monitoring Controller & E2E Flow", () => {
  let controller: SyntheticJourneyController;
  let service: SyntheticJourneyMonitorService;
  let mockMetrics: Partial<MonitoringMetricsService>;

  beforeEach(async () => {
    mockMetrics = {
      incrementCounter: jest.fn(),
      gauge: jest.fn().mockReturnValue({ set: jest.fn() }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SyntheticJourneyController],
      providers: [
        SyntheticJourneyMonitorService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => (key === "NODE_ENV" ? "test" : undefined)),
          },
        },
        {
          provide: MonitoringMetricsService,
          useValue: mockMetrics,
        },
      ],
    }).compile();

    controller = module.get<SyntheticJourneyController>(SyntheticJourneyController);
    service = module.get<SyntheticJourneyMonitorService>(SyntheticJourneyMonitorService);
  });

  afterEach(() => {
    service.stopScheduler();
  });

  describe("GET /monitoring/synthetic/status", () => {
    it("should return the latest synthetic journey report", async () => {
      // Execute a journey to populate status
      await service.runJourney({ trigger: "MANUAL" });

      const report = await controller.getStatus();
      expect(report).toBeDefined();
      expect(report.journeyName).toBe("E2E_CORE_HAPPY_PATH_JOURNEY");
      expect(report.totalSteps).toBe(5);
      expect(report.status).toBe("SUCCESS");
      expect(report.steps).toHaveLength(5);
    });
  });

  describe("POST /monitoring/synthetic/run", () => {
    const createMockResponse = () => {
      const res: Partial<Response> = {
        status: jest.fn().mockReturnThis(),
      };
      return res as Response;
    };

    it("should trigger a journey run on-demand and respond with status 200 on success", async () => {
      const res = createMockResponse();
      const report = await controller.runJourney(res);

      expect(report.status).toBe("SUCCESS");
      expect(report.passedSteps).toBe(5);
      expect(report.failedSteps).toBe(0);
      expect(res.status).not.toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it("should respond with HTTP 503 SERVICE_UNAVAILABLE when an upstream dependency fails", async () => {
      const res = createMockResponse();
      const report = await controller.runJourney(res, "step_portfolio_rebalance");

      expect(report.status).toBe("FAILED");
      expect(report.dependencyBlame).toContain("POSTGRES_DB");
      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it("should attribute Horizon failure and provide remediation instructions", async () => {
      const res = createMockResponse();
      const report = await controller.runJourney(res, "step_settlement_reconcile");

      expect(report.status).toBe("FAILED");
      expect(report.dependencyBlame).toContain("STELLAR_HORIZON");
      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);

      const failedStep = report.steps.find((s) => s.stepId === "step_settlement_reconcile");
      expect(failedStep?.error?.remediation).toMatch(/Horizon/);
    });
  });
});

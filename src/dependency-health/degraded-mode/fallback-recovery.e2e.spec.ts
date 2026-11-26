import { Test, TestingModule } from "@nestjs/testing";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ConfigService } from "@nestjs/config";
import { DependencyDegradedModeService } from "./degraded-mode.service";
import { FallbackHandlerService } from "./fallback-handler.service";
import { RecoveryDetectorService } from "./recovery-detector.service";
import {
  DegradedCapability,
  DegradedModeDecision,
  CapabilityFallback,
} from "./degraded-mode.types";
import { DependencyHealthService } from "../dependency-health.service";

describe("Dependency Outage Fallback and Recovery (e2e)", () => {
  let module: TestingModule;
  let degradedModeService: DependencyDegradedModeService;
  let fallbackHandler: FallbackHandlerService;
  let recoveryDetector: RecoveryDetectorService;
  let eventEmitter: EventEmitter2;

  beforeEach(async () => {
    const mockDependencyHealthService = {
      run: jest.fn().mockResolvedValue({
        status: "healthy",
        advisory: "healthy",
        generatedAt: new Date().toISOString(),
        durationMs: 100,
        counts: {
          healthy: 5,
          degraded: 0,
          unavailable: 0,
          misconfigured: 0,
          disabled: 0,
        },
        criticalFindings: [],
        advisoryFindings: [],
        checks: [],
        networkProbesSkipped: false,
      }),
    };

    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => defaultValue),
    };

    module = await Test.createTestingModule({
      providers: [
        DependencyDegradedModeService,
        FallbackHandlerService,
        RecoveryDetectorService,
        EventEmitter2,
        {
          provide: DependencyHealthService,
          useValue: mockDependencyHealthService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    degradedModeService = module.get<DependencyDegradedModeService>(
      DependencyDegradedModeService,
    );
    fallbackHandler = module.get<FallbackHandlerService>(FallbackHandlerService);
    recoveryDetector = module.get<RecoveryDetectorService>(
      RecoveryDetectorService,
    );
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
  });

  afterEach(async () => {
    await module.close();
  });

  describe("Normal Operation Path", () => {
    it("should execute operation normally when service is healthy", async () => {
      const operation = jest.fn().mockResolvedValue({ success: true });
      const fallback: CapabilityFallback = {
        behavior: "reject_with_503",
        note: "Service temporarily unavailable",
      };

      const result = await fallbackHandler.executeWithFallback(
        {
          capability: "payments",
          operation: "process_payment",
          userId: "user-123",
        },
        operation,
        fallback,
      );

      expect(result.success).toBe(true);
      expect(result.fallbackUsed).toBe(false);
      expect(result.data).toEqual({ success: true });
      expect(operation).toHaveBeenCalled();
    });

    it("should cache successful results for potential stale serving", async () => {
      const data = { portfolio: "data" };
      const operation = jest.fn().mockResolvedValue(data);
      const fallback: CapabilityFallback = {
        behavior: "serve_stale",
        note: "Serving cached data",
      };

      await fallbackHandler.executeWithFallback(
        {
          capability: "trades",
          operation: "get_portfolio",
          userId: "user-123",
        },
        operation,
        fallback,
      );

      // Verify cache was populated (indirectly by triggering stale serve)
      const staleFallback = await fallbackHandler.executeWithFallback(
        {
          capability: "trades",
          operation: "get_portfolio",
          userId: "user-123",
        },
        async () => {
          throw new Error("Service down");
        },
        fallback,
      );

      expect(staleFallback.success).toBe(true);
      expect(staleFallback.fallbackUsed).toBe(true);
      expect(staleFallback.fallbackType).toBe("serve_stale");
    });
  });

  describe("Failure Path - Queue for Later", () => {
    it("should queue operation when service is unavailable", async () => {
      const eventSpy = jest.fn();
      eventEmitter.on("fallback.applied", eventSpy);

      const operation = jest.fn().mockRejectedValue(new Error("Service down"));
      const fallback: CapabilityFallback = {
        behavior: "queue_for_later",
        note: "Operation queued",
      };

      const result = await fallbackHandler.executeWithFallback(
        {
          capability: "payments",
          operation: "process_payment",
          userId: "user-123",
        },
        operation,
        fallback,
      );

      expect(result.success).toBe(false);
      expect(result.fallbackUsed).toBe(true);
      expect(result.fallbackType).toBe("queue_for_later");
      expect(result.queuedForLater).toBe(true);
      expect(result.message).toContain("queued");
      expect(result.retryAfter).toBe(300);

      expect(fallbackHandler.getPendingCount("payments")).toBe(1);
      expect(eventSpy).toHaveBeenCalled();
    });

    it("should process queued operations after recovery", async () => {
      // Queue some operations
      const fallback: CapabilityFallback = {
        behavior: "queue_for_later",
        note: "Queued",
      };

      for (let i = 0; i < 3; i++) {
        await fallbackHandler.executeWithFallback(
          {
            capability: "trades",
            operation: `trade_${i}`,
          },
          async () => {
            throw new Error("Down");
          },
          fallback,
        );
      }

      expect(fallbackHandler.getPendingCount("trades")).toBe(3);

      // Process queue after recovery
      const result = await fallbackHandler.processQueuedOperations("trades");

      expect(result.processed).toBe(3);
      expect(fallbackHandler.getPendingCount("trades")).toBe(0);
    });
  });

  describe("Failure Path - Serve Stale", () => {
    it("should serve stale data when available", async () => {
      const staleData = { price: 100 };
      const fallback: CapabilityFallback = {
        behavior: "serve_stale",
        note: "Serving cached data",
      };

      // First request succeeds and caches data
      await fallbackHandler.executeWithFallback(
        {
          capability: "oracle",
          operation: "get_price",
          userId: "user-123",
        },
        async () => staleData,
        fallback,
      );

      // Second request fails but serves stale
      const result = await fallbackHandler.executeWithFallback(
        {
          capability: "oracle",
          operation: "get_price",
          userId: "user-123",
        },
        async () => {
          throw new Error("Service down");
        },
        fallback,
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual(staleData);
      expect(result.fallbackUsed).toBe(true);
      expect(result.fallbackType).toBe("serve_stale");
      expect(result.message).toContain("cached data");
    });

    it("should reject when no stale data available", async () => {
      const fallback: CapabilityFallback = {
        behavior: "serve_stale",
        note: "No data available",
      };

      await expect(
        fallbackHandler.executeWithFallback(
          {
            capability: "search",
            operation: "search_query",
          },
          async () => {
            throw new Error("Service down");
          },
          fallback,
        ),
      ).rejects.toThrow("Service Unavailable");
    });
  });

  describe("Failure Path - Read Only", () => {
    it("should enforce read-only mode", async () => {
      const fallback: CapabilityFallback = {
        behavior: "read_only",
        note: "Write operations disabled",
      };

      const result = await fallbackHandler.executeWithFallback(
        {
          capability: "imports",
          operation: "upload_data",
        },
        async () => {
          throw new Error("Service down");
        },
        fallback,
      );

      expect(result.success).toBe(false);
      expect(result.fallbackUsed).toBe(true);
      expect(result.fallbackType).toBe("read_only");
      expect(result.message).toContain("Write operations");
      expect(result.message).toContain("disabled");
    });
  });

  describe("Failure Path - Reject with 503", () => {
    it("should throw ServiceUnavailableException", async () => {
      const fallback: CapabilityFallback = {
        behavior: "reject_with_503",
        note: "Service unavailable",
      };

      await expect(
        fallbackHandler.executeWithFallback(
          {
            capability: "webhooks",
            operation: "send_webhook",
          },
          async () => {
            throw new Error("Service down");
          },
          fallback,
        ),
      ).rejects.toThrow("Service Unavailable");
    });
  });

  describe("Recovery Detection Path", () => {
    it("should detect capability recovery", async () => {
      const eventSpy = jest.fn();
      eventEmitter.on("recovery.capability.recovered", eventSpy);

      // Mock initial degraded state
      jest
        .spyOn(degradedModeService, "getMode")
        .mockResolvedValueOnce({
          level: "restricted",
          active: true,
          allowedCapabilities: ["admin"],
          disabledCapabilities: ["payments"],
          degradedCapabilities: [],
          reasons: ["Database unavailable"],
          criticalFindings: ["postgres"],
          advisoryFindings: [],
          manualOverride: false,
          generatedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          level: "normal",
          active: false,
          allowedCapabilities: ["payments", "admin"],
          disabledCapabilities: [],
          degradedCapabilities: [],
          reasons: [],
          criticalFindings: [],
          advisoryFindings: [],
          manualOverride: false,
          generatedAt: new Date().toISOString(),
        });

      // Trigger initial check
      await recoveryDetector.checkForRecovery();

      // Trigger recovery check
      await recoveryDetector.checkForRecovery();

      // Should emit recovery event
      expect(eventSpy).toHaveBeenCalled();
    });

    it("should detect capability degradation", async () => {
      const eventSpy = jest.fn();
      eventEmitter.on("recovery.capability.degraded", eventSpy);

      // Mock healthy then degraded state
      jest
        .spyOn(degradedModeService, "getMode")
        .mockResolvedValueOnce({
          level: "normal",
          active: false,
          allowedCapabilities: ["payments", "admin"],
          disabledCapabilities: [],
          degradedCapabilities: [],
          reasons: [],
          criticalFindings: [],
          advisoryFindings: [],
          manualOverride: false,
          generatedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          level: "degraded",
          active: true,
          allowedCapabilities: ["payments", "admin"],
          disabledCapabilities: [],
          degradedCapabilities: ["payments"],
          reasons: ["Database slow"],
          criticalFindings: [],
          advisoryFindings: ["postgres"],
          manualOverride: false,
          generatedAt: new Date().toISOString(),
        });

      await recoveryDetector.checkForRecovery();
      await recoveryDetector.checkForRecovery();

      expect(eventSpy).toHaveBeenCalled();
    });
  });

  describe("Retry Path", () => {
    it("should maintain fallback behavior across retries", async () => {
      const fallback: CapabilityFallback = {
        behavior: "queue_for_later",
        note: "Queued for retry",
      };

      // Multiple retries should all queue
      for (let i = 0; i < 3; i++) {
        const result = await fallbackHandler.executeWithFallback(
          {
            capability: "notifications",
            operation: "send_notification",
            correlationId: `retry-${i}`,
          },
          async () => {
            throw new Error("Service down");
          },
          fallback,
        );

        expect(result.fallbackUsed).toBe(true);
        expect(result.queuedForLater).toBe(true);
      }

      expect(fallbackHandler.getPendingCount("notifications")).toBe(3);
    });
  });

  describe("Authorization Path", () => {
    it("should respect manual degraded mode override", async () => {
      const admin = { id: "admin-1", role: "ADMIN" };

      const decision = await degradedModeService.activateManualDegradation(
        {
          level: "maintenance",
          reason: "Planned maintenance",
          disabledCapabilities: ["payments", "trades"],
        },
        admin,
      );

      expect(decision.level).toBe("maintenance");
      expect(decision.manualOverride).toBe(true);
      expect(decision.disabledCapabilities).toContain("payments");
      expect(decision.disabledCapabilities).toContain("trades");
    });

    it("should reject manual override from non-admin", async () => {
      const user = { id: "user-1", role: "USER" };

      await expect(
        degradedModeService.activateManualDegradation(
          {
            level: "maintenance",
            reason: "Unauthorized",
          },
          user,
        ),
      ).rejects.toThrow();
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty queue gracefully", async () => {
      const result = await fallbackHandler.processQueuedOperations("exports");
      expect(result.processed).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("should handle multiple capabilities in queue", async () => {
      const counts = fallbackHandler.getAllPendingCounts();
      expect(typeof counts).toBe("object");
    });

    it("should clear stale cache for specific capability", () => {
      fallbackHandler.clearStaleCache("oracle");
      // Should not throw
    });

    it("should return metrics", () => {
      const metrics = recoveryDetector.getMetrics();
      expect(metrics).toHaveProperty("recoveries");
      expect(metrics).toHaveProperty("degradations");
      expect(metrics).toHaveProperty("lastRecovery");
      expect(metrics).toHaveProperty("lastDegradation");
      expect(metrics).toHaveProperty("currentLevel");
      expect(metrics).toHaveProperty("pendingOperations");
    });
  });
});

import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { ExecutionContext, ServiceUnavailableException, NotFoundException } from "@nestjs/common";
import { FeatureRolloutService } from "./feature-rollout.service";
import { FeatureRolloutGuard, FEATURE_KEY_METADATA } from "./feature-rollout.guard";

describe("FeatureRolloutService & Guard", () => {
  let service: FeatureRolloutService;
  let guard: FeatureRolloutGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureRolloutService,
        FeatureRolloutGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<FeatureRolloutService>(FeatureRolloutService);
    guard = module.get<FeatureRolloutGuard>(FeatureRolloutGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  describe("Feature Registration and Basic Evaluation", () => {
    it("should throw NotFoundException for unregistered features", () => {
      expect(() => service.isEnabled("unknown-feature")).toThrow(NotFoundException);
    });

    it("should return globally_disabled when master switch enabled=false", () => {
      service.registerFeature({
        key: "beta-trading",
        description: "Beta trading engine",
        enabled: false,
        rolloutPercentage: 50,
      });

      const result = service.isEnabled("beta-trading", { userId: "user-123" });
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe("globally_disabled");
    });

    it("should enable feature when rolloutPercentage is 100", () => {
      service.registerFeature({
        key: "instant-settlement",
        description: "Instant settlement",
        enabled: true,
        rolloutPercentage: 100,
      });

      const res1 = service.isEnabled("instant-settlement", { userId: "user-1" });
      const res2 = service.isEnabled("instant-settlement");

      expect(res1.enabled).toBe(true);
      expect(res1.reason).toBe("percentage_rollout_included");
      expect(res2.enabled).toBe(true);
      expect(res2.reason).toBe("percentage_rollout_included");
    });

    it("should default off when rolloutPercentage is 0 and no context provided", () => {
      service.registerFeature({
        key: "dark-mode",
        description: "Dark mode UI",
        enabled: true,
        rolloutPercentage: 0,
      });

      const result = service.isEnabled("dark-mode");
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe("default_off");
    });
  });

  describe("Deterministic Percentage Rollout", () => {
    beforeEach(() => {
      service.registerFeature({
        key: "ai-assistant",
        description: "AI Financial Assistant",
        enabled: true,
        rolloutPercentage: 50,
      });
    });

    it("should deterministically produce identical evaluation results for the same userId", () => {
      const userA = "user-alice-789";
      const result1 = service.isEnabled("ai-assistant", { userId: userA });
      const result2 = service.isEnabled("ai-assistant", { userId: userA });
      const result3 = service.isEnabled("ai-assistant", { userId: userA });

      expect(result1.enabled).toBe(result2.enabled);
      expect(result2.enabled).toBe(result3.enabled);
      expect(result1.reason).toBe(result2.reason);
    });

    it("should partition distinct users predictably according to SHA-256 hash modulo 100", () => {
      const sampleSize = 100;
      let includedCount = 0;

      for (let i = 0; i < sampleSize; i++) {
        const userId = `deterministic-test-user-${i}`;
        const res = service.isEnabled("ai-assistant", { userId });
        if (res.enabled) {
          includedCount++;
          expect(res.reason).toBe("percentage_rollout_included");
        } else {
          expect(res.reason).toBe("percentage_rollout_excluded");
        }
      }

      // 50% rollout across 100 pseudo-random hashes should yield between 35% and 65%
      expect(includedCount).toBeGreaterThanOrEqual(35);
      expect(includedCount).toBeLessThanOrEqual(65);
    });
  });

  describe("Allowlists (User and Role)", () => {
    it("should allow allowlisted users even if rollout percentage is 0", () => {
      service.registerFeature({
        key: "experimental-oracle",
        description: "Next-gen oracle reader",
        enabled: true,
        rolloutPercentage: 0,
        allowlistedUsers: ["vip-user-1", "vip-user-2"],
      });

      const allowed = service.isEnabled("experimental-oracle", { userId: "vip-user-1" });
      const regular = service.isEnabled("experimental-oracle", { userId: "regular-user" });

      expect(allowed.enabled).toBe(true);
      expect(allowed.reason).toBe("allowlisted_user");

      expect(regular.enabled).toBe(false);
      expect(regular.reason).toBe("percentage_rollout_excluded");
    });

    it("should allow allowlisted roles even if rollout percentage is 0", () => {
      service.registerFeature({
        key: "admin-metrics",
        description: "Admin analytics module",
        enabled: true,
        rolloutPercentage: 0,
        allowlistedRoles: ["ADMIN", "INTERNAL_AUDITOR"],
      });

      const adminUser = service.isEnabled("admin-metrics", {
        userId: "user-admin",
        role: "ADMIN",
      });
      const standardUser = service.isEnabled("admin-metrics", {
        userId: "user-standard",
        role: "USER",
      });

      expect(adminUser.enabled).toBe(true);
      expect(adminUser.reason).toBe("allowlisted_role");

      expect(standardUser.enabled).toBe(false);
    });
  });

  describe("Emergency Kill-Switch and Recovery", () => {
    beforeEach(() => {
      service.registerFeature({
        key: "bridge-v2",
        description: "Cross-chain bridge v2",
        enabled: true,
        rolloutPercentage: 100,
        allowlistedUsers: ["admin-1"],
      });
    });

    it("should immediately block all traffic when emergencyDisable is activated", () => {
      service.emergencyDisable("bridge-v2", "Zero-day exploit detected in cross-chain adapter", "SecOps");

      const feature = service.getFeature("bridge-v2");
      expect(feature?.emergencyDisabled).toBe(true);
      expect(feature?.enabled).toBe(false);
      expect(feature?.emergencyReason).toBe("Zero-day exploit detected in cross-chain adapter");
      expect(feature?.emergencyDisabledBy).toBe("SecOps");
      expect(feature?.emergencyDisabledAt).toBeInstanceOf(Date);

      const resAllowlist = service.isEnabled("bridge-v2", { userId: "admin-1" });
      const resGeneral = service.isEnabled("bridge-v2", { userId: "user-general" });

      expect(resAllowlist.enabled).toBe(false);
      expect(resAllowlist.reason).toBe("emergency_disabled");

      expect(resGeneral.enabled).toBe(false);
      expect(resGeneral.reason).toBe("emergency_disabled");
    });

    it("should lift emergency disablement and restart in canary mode", () => {
      service.emergencyDisable("bridge-v2", "Patching in progress", "IncidentCommander");
      expect(service.isEnabled("bridge-v2", { userId: "admin-1" }).enabled).toBe(false);

      service.liftEmergencyDisable("bridge-v2", "IncidentCommander", 10);

      const feature = service.getFeature("bridge-v2");
      expect(feature?.emergencyDisabled).toBe(false);
      expect(feature?.enabled).toBe(true);
      expect(feature?.rolloutPercentage).toBe(10);
      expect(feature?.emergencyReason).toBeUndefined();

      // Allowlist should now be re-enabled
      const resAllowlist = service.isEnabled("bridge-v2", { userId: "admin-1" });
      expect(resAllowlist.enabled).toBe(true);
      expect(resAllowlist.reason).toBe("allowlisted_user");
    });
  });

  describe("Automated Error Rate Circuit Breaking", () => {
    it("should trip circuit breaker and emergency disable feature when error threshold is exceeded", () => {
      service.registerFeature({
        key: "synthetic-assets",
        description: "Synthetic token pairs",
        enabled: true,
        rolloutPercentage: 100,
        maxErrorThreshold: 3,
      });

      expect(service.isEnabled("synthetic-assets").enabled).toBe(true);

      // Record 1st error
      service.recordError("synthetic-assets", new Error("RPC timeout"));
      expect(service.isEnabled("synthetic-assets").enabled).toBe(true);

      // Record 2nd error
      service.recordError("synthetic-assets", new Error("Validation mismatch"));
      expect(service.isEnabled("synthetic-assets").enabled).toBe(true);

      // Record 3rd error - exceeds threshold
      service.recordError("synthetic-assets", new Error("Fatal invariant failure"));

      const feature = service.getFeature("synthetic-assets");
      expect(feature?.emergencyDisabled).toBe(true);
      expect(feature?.emergencyReason).toContain("Automated circuit break: Exceeded max consecutive error threshold (3/3)");
      expect(feature?.emergencyDisabledBy).toBe("SYSTEM_GUARDRAIL");

      const result = service.isEnabled("synthetic-assets");
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe("emergency_disabled");
    });

    it("should reset error counter on recordSuccess, avoiding false tripping", () => {
      service.registerFeature({
        key: "flash-loans",
        description: "Flash loan module",
        enabled: true,
        rolloutPercentage: 100,
        maxErrorThreshold: 3,
      });

      service.recordError("flash-loans", new Error("Temporary glitch 1"));
      service.recordError("flash-loans", new Error("Temporary glitch 2"));

      // Intermittent success resets consecutive counter
      service.recordSuccess("flash-loans");

      service.recordError("flash-loans", new Error("Temporary glitch 3"));

      const feature = service.getFeature("flash-loans");
      expect(feature?.emergencyDisabled).toBe(false);
      expect(service.isEnabled("flash-loans").enabled).toBe(true);
    });
  });

  describe("FeatureRolloutGuard", () => {
    const mockContext = (userId?: string, role?: string): ExecutionContext => {
      return {
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue({
            user: userId ? { id: userId, role } : undefined,
          }),
        }),
      } as unknown as ExecutionContext;
    };

    it("should allow request if no @RequireFeature metadata is present", () => {
      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);

      const ctx = mockContext();
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it("should throw ServiceUnavailableException if feature is emergency disabled", () => {
      service.registerFeature({
        key: "staking-rewards",
        description: "Rewards payout",
        enabled: true,
        rolloutPercentage: 100,
      });
      service.emergencyDisable("staking-rewards", "Accounting discrepancy", "SecOps");

      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue("staking-rewards");

      const ctx = mockContext("user-1");
      expect(() => guard.canActivate(ctx)).toThrow(ServiceUnavailableException);
      expect(() => guard.canActivate(ctx)).toThrow(/temporarily disabled under emergency maintenance/);
    });

    it("should throw ServiceUnavailableException if user is not in rollout", () => {
      service.registerFeature({
        key: "algo-trading",
        description: "Algorithmic trading",
        enabled: true,
        rolloutPercentage: 0,
      });

      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue("algo-trading");

      const ctx = mockContext("user-not-in-rollout");
      expect(() => guard.canActivate(ctx)).toThrow(ServiceUnavailableException);
      expect(() => guard.canActivate(ctx)).toThrow(/not active for this account/);
    });

    it("should allow request if user passes evaluation", () => {
      service.registerFeature({
        key: "premium-reports",
        description: "Premium reporting",
        enabled: true,
        rolloutPercentage: 0,
        allowlistedRoles: ["VIP_TRADER"],
      });

      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue("premium-reports");

      const ctx = mockContext("user-vip", "VIP_TRADER");
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });
});

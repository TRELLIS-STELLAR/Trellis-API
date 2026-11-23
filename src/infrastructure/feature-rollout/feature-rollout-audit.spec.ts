import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { FeatureRolloutService } from "./feature-rollout.service";
import { AdminConfigAuditService } from "../audit/admin-config/admin-config-audit.service";
import { SensitiveActionAuditService } from "../audit/sensitive-actions/sensitive-action-audit.service";
import { SensitiveAction } from "../audit/sensitive-actions/sensitive-action.enum";
import {
  SensitiveActionEvent,
  SensitiveActionStatus,
} from "../audit/entities/sensitive-action-event.entity";
import { SensitiveActionChainHead } from "../audit/entities/sensitive-action-chain-head.entity";

function createAuditHarness() {
  const events: SensitiveActionEvent[] = [];
  let chainHead: SensitiveActionChainHead | null = null;

  const sortSeq =
    (dir: "ASC" | "DESC") =>
    (a: SensitiveActionEvent, b: SensitiveActionEvent) => {
      const diff = Number(BigInt(a.sequence) - BigInt(b.sequence));
      return dir === "ASC" ? diff : -diff;
    };

  const auditRepo = {
    failNextSaves: 0,
    create: (partial: Partial<SensitiveActionEvent>) =>
      ({ ...partial }) as SensitiveActionEvent,
    async save(event: SensitiveActionEvent) {
      if (auditRepo.failNextSaves > 0) {
        auditRepo.failNextSaves -= 1;
        throw new Error("Transient audit database connection error");
      }
      (event as any).id = (event as any).id ?? `evt-${event.sequence}`;
      events.push(event);
      return event;
    },
    async findOne(options?: { order?: { sequence?: "ASC" | "DESC" } }) {
      return (
        [...events].sort(sortSeq(options?.order?.sequence ?? "DESC"))[0] ?? null
      );
    },
    async find(options?: { order?: { sequence?: "ASC" | "DESC" } }) {
      return [...events].sort(sortSeq(options?.order?.sequence ?? "ASC"));
    },
  };

  const headRepo = {
    create: (partial: Partial<SensitiveActionChainHead>) =>
      ({ ...partial }) as SensitiveActionChainHead,
    async save(head: SensitiveActionChainHead) {
      chainHead = { ...head };
      return head;
    },
    async findOne() {
      return chainHead ? { ...chainHead } : null;
    },
  };

  const auditService = new SensitiveActionAuditService(
    auditRepo as any,
    headRepo as any,
  );
  return { events, auditRepo, auditService };
}

class TestAdminConfigAuditService extends AdminConfigAuditService {
  delays: number[] = [];
  protected async delay(ms: number): Promise<void> {
    this.delays.push(ms);
  }
}

describe("FeatureRolloutService - Audit Evidence Integration (#425)", () => {
  let harness: ReturnType<typeof createAuditHarness>;
  let adminConfigAudit: TestAdminConfigAuditService;
  let service: FeatureRolloutService;

  const adminActor = {
    id: "admin-425",
    role: "ADMIN",
    ipAddress: "192.168.1.100",
    userAgent: "trellis-ops/2.0",
  };

  const maintainerActor = {
    id: "maintainer-425",
    role: "MAINTAINER",
    ipAddress: "192.168.1.101",
    userAgent: "trellis-ops/2.0",
  };

  const unauthorizedActor = {
    id: "user-425",
    role: "USER",
    ipAddress: "10.0.0.1",
    userAgent: "browser/1.0",
  };

  beforeEach(() => {
    harness = createAuditHarness();
    adminConfigAudit = new TestAdminConfigAuditService(harness.auditService, {
      maxAttempts: 3,
      baseDelayMs: 5,
    });
    service = new FeatureRolloutService(adminConfigAudit);
  });

  describe("Normal Path", () => {
    it("registers a new feature flag with tamper-evident audit evidence", async () => {
      const result = await service.registerFeatureWithEvidence(
        {
          key: "dark-mode",
          description: "Enable dark mode UI",
          enabled: true,
          rolloutPercentage: 25,
          allowlistedUsers: ["u-1"],
        },
        adminActor,
        "Q3 UI feature rollout",
      );

      expect(result.key).toBe("dark-mode");
      expect(result.rolloutPercentage).toBe(25);
      expect(service.getFeature("dark-mode")).toBeDefined();

      expect(harness.events).toHaveLength(1);
      const event = harness.events[0];
      expect(event.action).toBe(SensitiveAction.FEATURE_FLAG_CHANGED);
      expect(event.actorId).toBe("admin-425");
      expect(event.actorRole).toBe("ADMIN");
      expect(event.status).toBe(SensitiveActionStatus.SUCCEEDED);
      expect(event.beforeState).toBeNull();
      expect(event.afterState).toMatchObject({
        key: "dark-mode",
        enabled: true,
        rolloutPercentage: 25,
      });

      const chainValidation = await harness.auditService.verifyChain();
      expect(chainValidation.valid).toBe(true);
      expect(chainValidation.verified).toBe(1);
    });

    it("updates feature percentage rollout with before/after state capture", async () => {
      await service.registerFeatureWithEvidence(
        {
          key: "ai-copilot",
          description: "AI copilot feature",
          enabled: true,
          rolloutPercentage: 10,
        },
        adminActor,
        "Initial canary",
      );

      const updated = await service.updateFeatureWithEvidence(
        "ai-copilot",
        { rolloutPercentage: 50 },
        maintainerActor,
        "Expand to 50% following successful canary",
      );

      expect(updated.rolloutPercentage).toBe(50);
      expect(harness.events).toHaveLength(2);

      const updateEvent = harness.events[1];
      expect(updateEvent.actorId).toBe("maintainer-425");
      expect(updateEvent.actorRole).toBe("MAINTAINER");
      expect(updateEvent.beforeState).toMatchObject({ rolloutPercentage: 10 });
      expect(updateEvent.afterState).toMatchObject({ rolloutPercentage: 50 });
      expect(updateEvent.reason).toBe("Expand to 50% following successful canary");
    });

    it("activates emergency kill-switch and records emergency disablement evidence", async () => {
      await service.registerFeatureWithEvidence(
        {
          key: "high-frequency-rebalance",
          description: "Automated rebalancer",
          enabled: true,
          rolloutPercentage: 100,
        },
        adminActor,
        "Full deploy",
      );

      const disabled = await service.emergencyDisableWithEvidence(
        "high-frequency-rebalance",
        "Discovered arithmetic regression in calculation",
        adminActor,
      );

      expect(disabled.emergencyDisabled).toBe(true);
      expect(disabled.enabled).toBe(false);
      expect(disabled.emergencyReason).toBe(
        "Discovered arithmetic regression in calculation",
      );

      const disableEvent = harness.events[1];
      expect(disableEvent.afterState).toMatchObject({
        emergencyDisabled: true,
        enabled: false,
      });
    });

    it("lifts emergency disable and resumes controlled canary rollout", async () => {
      await service.registerFeatureWithEvidence(
        {
          key: "fee-optimization",
          description: "Fee optimizer",
          enabled: false,
          emergencyDisabled: true,
          rolloutPercentage: 0,
        },
        adminActor,
        "Initial setup",
      );

      const resumed = await service.liftEmergencyDisableWithEvidence(
        "fee-optimization",
        adminActor,
        15,
        "Patch verified in staging; resuming canary at 15%",
      );

      expect(resumed.emergencyDisabled).toBe(false);
      expect(resumed.enabled).toBe(true);
      expect(resumed.rolloutPercentage).toBe(15);
    });
  });

  describe("Authorization Path", () => {
    it("refuses unauthorized actor (USER role) and records failed audit event", async () => {
      await expect(
        service.registerFeatureWithEvidence(
          {
            key: "secret-feature",
            description: "Admin feature",
            enabled: true,
            rolloutPercentage: 100,
          },
          unauthorizedActor,
          "Attempted user config change",
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(service.getFeature("secret-feature")).toBeUndefined();
      expect(harness.events).toHaveLength(1);
      expect(harness.events[0]).toMatchObject({
        actorId: "user-425",
        status: SensitiveActionStatus.FAILED,
        metadata: { outcome: "unauthorized" },
      });
    });
  });

  describe("Failure Path", () => {
    it("records apply_failed and rethrows when updating non-existent feature", async () => {
      await expect(
        service.updateFeatureWithEvidence(
          "non-existent-flag",
          { rolloutPercentage: 50 },
          adminActor,
          "Update non-existent",
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(harness.events).toHaveLength(1);
      expect(harness.events[0]).toMatchObject({
        status: SensitiveActionStatus.FAILED,
        metadata: { outcome: "apply_failed", error: "NotFoundException" },
      });
    });
  });

  describe("Retry Path", () => {
    it("retries transient audit store failures with exponential backoff and succeeds", async () => {
      harness.auditRepo.failNextSaves = 2; // Fail first 2 attempts, succeed on 3rd

      const result = await service.registerFeatureWithEvidence(
        {
          key: "resilient-feature",
          description: "Feature with transient audit store retry",
          enabled: true,
          rolloutPercentage: 10,
        },
        adminActor,
        "Deploy resilient feature",
      );

      expect(result.key).toBe("resilient-feature");
      expect(service.getFeature("resilient-feature")).toBeDefined();
      expect(harness.events).toHaveLength(1);
      expect(adminConfigAudit.delays).toEqual([5, 10]);
    });
  });

  describe("Fail-Closed Rollback Path", () => {
    it("reverts feature registration when audit evidence write persistently fails", async () => {
      harness.auditRepo.failNextSaves = 5; // Exceeds maxAttempts (3)

      await expect(
        service.registerFeatureWithEvidence(
          {
            key: "doomed-flag",
            description: "Feature whose audit cannot be saved",
            enabled: true,
            rolloutPercentage: 50,
          },
          adminActor,
          "Attempt deploy",
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Verify fail-closed: unaudited feature is NOT in memory
      expect(service.getFeature("doomed-flag")).toBeUndefined();
    });

    it("reverts feature update to prior snapshot when audit evidence write fails", async () => {
      await service.registerFeatureWithEvidence(
        {
          key: "stable-flag",
          description: "Feature initially at 10%",
          enabled: true,
          rolloutPercentage: 10,
        },
        adminActor,
        "Initial deploy",
      );

      harness.auditRepo.failNextSaves = 5;

      await expect(
        service.updateFeatureWithEvidence(
          "stable-flag",
          { rolloutPercentage: 100 },
          adminActor,
          "Risky full rollout",
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Verify reverted to snapshot (10%, not 100%)
      const current = service.getFeature("stable-flag");
      expect(current?.rolloutPercentage).toBe(10);
    });
  });

  describe("Emergency disablement guard (#565)", () => {
    const key = "instant-settlement";
    const register = (actor = adminActor) =>
      service.registerFeatureWithEvidence(
        {
          key,
          description: "Instant settlement",
          enabled: true,
          rolloutPercentage: 100,
        },
        actor,
        "Full rollout",
      );
    const disable = () =>
      service.emergencyDisableWithEvidence(key, "Horizon errors", adminActor);

    it("normal path: re-registering an emergency-disabled feature keeps the kill switch until it is lifted", async () => {
      await register();
      await disable();

      const reRegistered = await register(maintainerActor);

      expect(reRegistered).toMatchObject({
        enabled: false,
        emergencyDisabled: true,
        emergencyReason: "Horizon errors",
        emergencyDisabledBy: "admin-425",
        rolloutPercentage: 100,
      });
      expect(service.isEnabled(key, { userId: "u-1" }).reason).toBe(
        "emergency_disabled",
      );

      const lifted = await service.liftEmergencyDisableWithEvidence(
        key,
        adminActor,
        5,
        "Patched",
      );
      expect(lifted).toMatchObject({
        enabled: true,
        emergencyDisabled: false,
        rolloutPercentage: 5,
      });
    });

    it("failure path: lifting a feature that is not emergency-disabled is refused, audited and changes nothing", async () => {
      await service.registerFeatureWithEvidence(
        {
          key: "dormant",
          description: "Staged",
          enabled: false,
          rolloutPercentage: 0,
        },
        adminActor,
        "Staged off",
      );

      await expect(
        service.liftEmergencyDisableWithEvidence(
          "dormant",
          adminActor,
          5,
          "Wrong flag",
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(service.getFeature("dormant")).toMatchObject({
        enabled: false,
        rolloutPercentage: 0,
      });
      expect(harness.events[harness.events.length - 1]).toMatchObject({
        status: SensitiveActionStatus.FAILED,
        metadata: { outcome: "apply_failed", error: "ConflictException" },
      });
    });

    it("retry path: a retried lift does not reset a widened rollout back to the canary percentage", async () => {
      await register();
      await disable();
      await service.liftEmergencyDisableWithEvidence(
        key,
        adminActor,
        5,
        "Patched",
      );
      await service.updateFeatureWithEvidence(
        key,
        { rolloutPercentage: 25 },
        adminActor,
        "Widen canary",
      );

      await expect(
        service.liftEmergencyDisableWithEvidence(key, adminActor, 5, "Patched"),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(service.getFeature(key)).toMatchObject({
        enabled: true,
        rolloutPercentage: 25,
      });
    });

    it("authorization path: an unauthorized actor can neither lift nor re-register away the kill switch", async () => {
      await register();
      await disable();

      await expect(
        service.liftEmergencyDisableWithEvidence(
          key,
          unauthorizedActor,
          100,
          "Let me in",
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(register(unauthorizedActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(service.isEnabled(key, { userId: "u-1" }).reason).toBe(
        "emergency_disabled",
      );
    });
  });
});


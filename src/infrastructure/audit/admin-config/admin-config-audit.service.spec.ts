import {
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AdminConfigAuditService } from "./admin-config-audit.service";
import { SensitiveActionAuditService } from "../sensitive-actions/sensitive-action-audit.service";
import { SensitiveAction } from "../sensitive-actions/sensitive-action.enum";
import {
  SensitiveActionEvent,
  SensitiveActionStatus,
} from "../entities/sensitive-action-event.entity";
import { SensitiveActionChainHead } from "../entities/sensitive-action-chain-head.entity";
import { PublicStatusService } from "../../../health/public-status.service";
import { PauseControlService } from "../../pause-control/pause-control.service";
import { PausableScope } from "../../pause-control/dto/activate-pause.dto";

/**
 * Audit evidence for administrative configuration changes (#280).
 *
 * Uses the real SensitiveActionAuditService over in-memory repositories so the
 * evidence goes through catalogue validation, sanitization and the hash chain.
 */

function auditHarness() {
  const rows: SensitiveActionEvent[] = [];
  let head: SensitiveActionChainHead | null = null;
  const sortSeq =
    (dir: "ASC" | "DESC") =>
    (a: SensitiveActionEvent, b: SensitiveActionEvent) => {
      const diff = Number(BigInt(a.sequence) - BigInt(b.sequence));
      return dir === "ASC" ? diff : -diff;
    };
  const repo = {
    failNextSaves: 0,
    create: (partial: Partial<SensitiveActionEvent>) =>
      ({ ...partial }) as SensitiveActionEvent,
    async save(event: SensitiveActionEvent) {
      if (repo.failNextSaves > 0) {
        repo.failNextSaves -= 1;
        throw new Error("connection terminated unexpectedly");
      }
      (event as any).id = (event as any).id ?? `evt-${event.sequence}`;
      rows.push(event);
      return event;
    },
    async findOne(options?: { order?: { sequence?: "ASC" | "DESC" } }) {
      return (
        [...rows].sort(sortSeq(options?.order?.sequence ?? "DESC"))[0] ?? null
      );
    },
    async find(options?: { order?: { sequence?: "ASC" | "DESC" } }) {
      return [...rows].sort(sortSeq(options?.order?.sequence ?? "ASC"));
    },
  };
  const headRepo = {
    create: (partial: Partial<SensitiveActionChainHead>) =>
      ({ ...partial }) as SensitiveActionChainHead,
    async save(value: SensitiveActionChainHead) {
      head = { ...value };
      return value;
    },
    async findOne() {
      return head ? { ...head } : null;
    },
  };
  const audit = new SensitiveActionAuditService(repo as any, headRepo as any);
  return { rows, repo, audit };
}

class NoDelayAdminConfigAuditService extends AdminConfigAuditService {
  delays: number[] = [];
  protected async delay(ms: number): Promise<void> {
    this.delays.push(ms);
  }
}

function makeService(options = { maxAttempts: 3, baseDelayMs: 10 }) {
  const harness = auditHarness();
  const service = new NoDelayAdminConfigAuditService(harness.audit, options);
  return { ...harness, service };
}

const admin = {
  id: "admin-1",
  role: "ADMIN",
  ipAddress: "203.0.113.9",
  userAgent: "ops-cli/1.0",
};

function change(overrides: Record<string, unknown> = {}) {
  const config = { value: "old" };
  return {
    config,
    spec: {
      action: SensitiveAction.FEATURE_FLAG_CHANGED,
      actor: admin,
      resourceType: "feature-flag",
      resourceId: "new-dashboard",
      reason: "Roll out to 10%",
      snapshot: () => ({ ...config }),
      apply: async () => {
        config.value = "new";
        return "applied";
      },
      revert: (before: { value: string }) => {
        config.value = before.value;
      },
      ...overrides,
    },
  };
}

describe("AdminConfigAuditService", () => {
  it("applies the change and records before/after evidence with actor attribution", async () => {
    const { service, rows, audit } = makeService();
    const { config, spec } = change({ metadata: { operation: "set" } });

    await expect(service.applyWithEvidence(spec as any)).resolves.toBe(
      "applied",
    );

    expect(config.value).toBe("new");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: SensitiveAction.FEATURE_FLAG_CHANGED,
      actorId: "admin-1",
      actorRole: "ADMIN",
      resourceType: "feature-flag",
      resourceId: "new-dashboard",
      reason: "Roll out to 10%",
      status: SensitiveActionStatus.SUCCEEDED,
      ipAddress: "203.0.113.9",
      beforeState: { value: "old" },
      afterState: { value: "new" },
      metadata: { operation: "set", outcome: "applied" },
    });
    await expect(audit.verifyChain()).resolves.toMatchObject({
      valid: true,
      verified: 1,
    });
  });

  it("accepts legacy lowercase roles", async () => {
    const { service } = makeService();
    const { spec } = change({ actor: { ...admin, role: "admin" } });
    await expect(service.applyWithEvidence(spec as any)).resolves.toBe(
      "applied",
    );
  });

  it("refuses a caller without an allowed role and records the attempt", async () => {
    const { service, rows } = makeService();
    const { config, spec } = change({ actor: { id: "user-7", role: "USER" } });

    await expect(service.applyWithEvidence(spec as any)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(config.value).toBe("old");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: "user-7",
      status: SensitiveActionStatus.FAILED,
      metadata: { outcome: "unauthorized" },
    });
  });

  it("refuses an actor allowed elsewhere but not for this change", async () => {
    const { service } = makeService();
    const { spec } = change({
      actor: { id: "m-1", role: "MAINTAINER" },
      allowedRoles: ["ADMIN"],
    });
    await expect(service.applyWithEvidence(spec as any)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("records a failed event and rethrows when the change itself fails", async () => {
    const { service, rows } = makeService();
    const failure = new RangeError("percentage must be 0-100");
    const { spec } = change({ apply: async () => Promise.reject(failure) });

    await expect(service.applyWithEvidence(spec as any)).rejects.toBe(failure);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: SensitiveActionStatus.FAILED,
      beforeState: { value: "old" },
      afterState: null,
      metadata: { outcome: "apply_failed", error: "RangeError" },
    });
  });

  it("retries a transient evidence write and keeps the change", async () => {
    const { service, rows, repo } = makeService();
    repo.failNextSaves = 2;
    const { config, spec } = change();

    await expect(service.applyWithEvidence(spec as any)).resolves.toBe(
      "applied",
    );

    expect(config.value).toBe("new");
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ recordAttempt: 3 });
    expect(service.delays).toEqual([10, 20]);
  });

  it("rolls the change back (fail closed) when evidence cannot be recorded", async () => {
    const { service, rows, repo } = makeService();
    repo.failNextSaves = 10;
    const { config, spec } = change();

    await expect(service.applyWithEvidence(spec as any)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(config.value).toBe("old");
    expect(rows).toHaveLength(0);
  });

  it("reports manual reconciliation when both evidence and rollback fail", async () => {
    const { service, repo } = makeService({ maxAttempts: 1, baseDelayMs: 0 });
    repo.failNextSaves = 10;
    const { spec } = change({
      revert: () => {
        throw new Error("revert failed");
      },
    });

    await expect(service.applyWithEvidence(spec as any)).rejects.toThrow(
      /manual reconciliation required/,
    );
  });

  it("redacts secrets in before/after state before they are stored", async () => {
    const { service, rows } = makeService();
    const config: Record<string, string> = {
      endpoint: "https://hooks.example.com",
      apiKey: "old",
    };
    await service.applyWithEvidence({
      action: SensitiveAction.FEATURE_FLAG_CHANGED,
      actor: admin,
      resourceType: "integration",
      resourceId: "partner",
      reason: "Rotate partner key",
      snapshot: () => ({ ...config }),
      apply: async () => {
        config.apiKey = "sk_live_supersecret";
      },
      revert: () => undefined,
    });
    expect(JSON.stringify(rows[0].afterState)).not.toContain(
      "sk_live_supersecret",
    );
  });
});

describe("PublicStatusService operator changes with evidence", () => {
  function statusService() {
    const harness = makeService({ maxAttempts: 2, baseDelayMs: 0 });
    const service = new PublicStatusService(
      undefined,
      undefined,
      undefined,
      undefined,
      harness.service,
    );
    return { ...harness, status: service };
  }

  const now = new Date("2026-10-18T12:00:00.000Z");

  it("records maintenance activation and clearing as chained evidence", async () => {
    const { status, rows, audit } = statusService();

    await status.activateMaintenance(
      { reason: "DB upgrade" },
      "admin-1",
      "ADMIN",
      now,
      {
        ipAddress: "198.51.100.4",
      },
    );
    await status.clearMaintenance("Upgrade done", "admin-1", "ADMIN", now);

    expect(
      rows.map((r) => [r.action, r.resourceType, r.metadata?.operation]),
    ).toEqual([
      [
        SensitiveAction.MAINTENANCE_WINDOW_CHANGED,
        "status.maintenance-window",
        "activate",
      ],
      [
        SensitiveAction.MAINTENANCE_WINDOW_CHANGED,
        "status.maintenance-window",
        "clear",
      ],
    ]);
    expect(rows[0].beforeState).toEqual({ maintenanceWindow: null });
    expect(rows[0].afterState).toMatchObject({
      maintenanceWindow: { active: true, reason: "DB upgrade" },
    });
    expect(rows[0].ipAddress).toBe("198.51.100.4");
    expect(rows[1].afterState).toEqual({ maintenanceWindow: null });
    await expect(audit.verifyChain()).resolves.toMatchObject({
      valid: true,
      verified: 2,
    });
  });

  it("rolls a maintenance window back when evidence cannot be recorded", async () => {
    const { status, repo } = statusService();
    repo.failNextSaves = 10;

    await expect(
      status.activateMaintenance(
        { reason: "DB upgrade" },
        "admin-1",
        "ADMIN",
        now,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const operator = await status.getOperatorStatus({ now });
    expect((operator as any).maintenanceWindow ?? null).toBeNull();
    expect(status.getStateHistory()[0].operatorNote).toMatch(/Rolled back/);
  });

  it("records degradation declare/clear and restores the prior declaration on rollback", async () => {
    const { status, rows, repo } = statusService();

    await status.declareComponentDegradation(
      { componentId: "payments" as any, reason: "Horizon slow" },
      "admin-1",
      now,
      { actorRole: "ADMIN" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: SensitiveAction.COMPONENT_DEGRADATION_CHANGED,
      resourceId: "payments",
    });

    repo.failNextSaves = 10;
    await expect(
      status.clearComponentDegradation(
        "payments" as any,
        "Recovered",
        "admin-1",
        now,
        {
          actorRole: "ADMIN",
        },
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // The clear was rolled back: the declaration is still in force.
    expect((status as any).manualDegradations.get("payments")).toMatchObject({
      reason: "Horizon slow",
    });
  });

  it("refuses an operator change from a non-admin role", async () => {
    const { status, rows } = statusService();
    await expect(
      status.declareComponentDegradation(
        { componentId: "payments" as any, reason: "x" },
        "maint-1",
        now,
        { actorRole: "MAINTAINER" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((status as any).manualDegradations.size).toBe(0);
    expect(rows[0]).toMatchObject({ status: SensitiveActionStatus.FAILED });
  });

  it("keeps the previous behaviour when no audit service is wired in", async () => {
    const status = new PublicStatusService();
    await status.activateMaintenance(
      { reason: "DB upgrade" },
      "admin-1",
      "ADMIN",
      now,
    );
    expect((status as any).maintenanceWindow).toMatchObject({ active: true });
  });
});

describe("PauseControlService pause toggles with evidence", () => {
  function pauseService() {
    const harness = makeService({ maxAttempts: 2, baseDelayMs: 0 });
    const pauses: any[] = [];
    const pauseRepo = {
      create: (dto: any) => ({ id: `pause-${pauses.length + 1}`, ...dto }),
      async save(entity: any) {
        const i = pauses.findIndex((p) => p.id === entity.id);
        if (i >= 0) pauses[i] = { ...entity };
        else pauses.push({ ...entity });
        return { ...entity };
      },
      async findOne({ where }: any) {
        const match = pauses.find(
          (p) =>
            (!where.id || p.id === where.id) &&
            (!where.scope || p.scope === where.scope) &&
            (where.active === undefined || p.active === where.active),
        );
        return match ? { ...match } : null;
      },
    };
    const pauseAudit: any[] = [];
    const auditRepo = {
      create: (dto: any) => dto,
      async save(entry: any) {
        pauseAudit.push(entry);
        return entry;
      },
    };
    const emitter = { emit: jest.fn() };
    const service = new PauseControlService(
      pauseRepo as any,
      auditRepo as any,
      emitter as any,
      harness.service,
    );
    return { ...harness, service, pauses, pauseAudit, emitter };
  }

  const activate = {
    scope: PausableScope.ALL,
    reason: "Exploit in progress",
    actorId: "admin-1",
    actorRole: "ADMIN",
    ipAddress: "203.0.113.20",
  };

  it("records activation and resume evidence", async () => {
    const { service, rows } = pauseService();

    await service.activatePause(activate);
    await service.resumePause(PausableScope.ALL, "Patched", "admin-1", "ADMIN");

    expect(
      rows.map((r) => [r.action, r.metadata?.operation, r.status]),
    ).toEqual([
      [
        SensitiveAction.EMERGENCY_PAUSE_TOGGLED,
        "activate",
        SensitiveActionStatus.SUCCEEDED,
      ],
      [
        SensitiveAction.EMERGENCY_PAUSE_TOGGLED,
        "resume",
        SensitiveActionStatus.SUCCEEDED,
      ],
    ]);
    expect(rows[0].beforeState).toEqual({ pause: null });
    expect(rows[0].afterState).toMatchObject({
      pause: { active: true, scope: PausableScope.ALL },
    });
    expect(rows[1].afterState).toMatchObject({
      pause: { active: false, resumeReason: "Patched" },
    });
    expect(rows[0].ipAddress).toBe("203.0.113.20");
  });

  it("lifts a new pause again when its evidence cannot be recorded", async () => {
    const { service, repo, pauses, emitter } = pauseService();
    repo.failNextSaves = 10;

    await expect(service.activatePause(activate)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toMatchObject({
      active: false,
      resumeReason: expect.stringMatching(/Rolled back/),
    });
    expect(emitter.emit).toHaveBeenLastCalledWith(
      "pause.resumed",
      expect.anything(),
    );
  });

  it("re-activates a pause whose resume could not be audited", async () => {
    const { service, repo, pauses } = pauseService();
    await service.activatePause(activate);

    repo.failNextSaves = 10;
    await expect(
      service.resumePause(PausableScope.ALL, "Patched", "admin-1", "ADMIN"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(pauses[0]).toMatchObject({ active: true, resumedAt: null });
  });

  it("records nothing when there is no active pause to resume", async () => {
    const { service, rows } = pauseService();
    await expect(
      service.resumePause(PausableScope.ALL, "Patched", "admin-1", "ADMIN"),
    ).resolves.toBeNull();
    expect(rows).toHaveLength(0);
  });
});

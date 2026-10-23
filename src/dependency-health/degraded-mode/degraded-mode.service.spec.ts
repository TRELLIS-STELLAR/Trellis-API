import { ConfigService } from "@nestjs/config";
import { DependencyHealthService } from "../dependency-health.service";
import {
  DependencyCheckResult,
  DependencyCriticality,
  DependencyReport,
  DependencyState,
} from "../dependency-health.types";
import { DependencyDegradedModeService } from "./degraded-mode.service";
import {
  DegradedModeAuthorizationError,
  DegradedModeCapabilityBlockedError,
} from "./degraded-mode.errors";
import { evaluateDegradedMode } from "./degraded-mode.policy";

function check(
  id: string,
  state: DependencyState,
  criticality: DependencyCriticality = "critical",
): DependencyCheckResult {
  return {
    id,
    label: id,
    kind: "service",
    criticality,
    state,
    detail: `${id} is ${state}`,
    verification: "network",
    configKeys: [],
    remediation: `fix ${id}`,
  };
}

function report(checks: DependencyCheckResult[]): DependencyReport {
  return {
    status: "healthy",
    advisory: "healthy",
    generatedAt: new Date().toISOString(),
    durationMs: 1,
    counts: { healthy: 0, degraded: 0, unavailable: 0, misconfigured: 0, disabled: 0 },
    criticalFindings: checks.filter((c) => c.state !== "healthy").map((c) => c.id),
    advisoryFindings: [],
    checks,
    networkProbesSkipped: true,
  };
}

function buildService(run: jest.Mock): DependencyDegradedModeService {
  const health = { run } as unknown as DependencyHealthService;
  const config = { get: () => undefined } as unknown as ConfigService;
  return new DependencyDegradedModeService(health, config);
}

describe("evaluateDegradedMode (pure policy)", () => {
  it("returns normal when every dependency is healthy", () => {
    const decision = evaluateDegradedMode(report([check("database", "healthy")]));
    expect(decision.level).toBe("normal");
    expect(decision.active).toBe(false);
    expect(decision.disabledCapabilities).toEqual([]);
  });

  it("restricts capabilities when a critical dependency is unavailable", () => {
    const decision = evaluateDegradedMode(
      report([check("database", "unavailable", "critical")]),
    );
    expect(decision.level).toBe("restricted");
    expect(decision.disabledCapabilities).toEqual(
      expect.arrayContaining(["payments", "trades", "imports", "exports", "admin"]),
    );
    expect(decision.allowedCapabilities).toContain("search");
    expect(decision.reasons.join(" ")).toContain("database");
  });

  it("degrades but does not disable capabilities when a critical dependency is slow", () => {
    const decision = evaluateDegradedMode(
      report([check("database", "degraded", "critical")]),
    );
    expect(decision.level).toBe("degraded");
    expect(decision.disabledCapabilities).toEqual([]);
    expect(decision.degradedCapabilities).toContain("payments");
  });

  it("degrades optional dependencies without disabling their capabilities", () => {
    const decision = evaluateDegradedMode(report([check("smtp", "degraded", "optional")]));
    expect(decision.level).toBe("degraded");
    expect(decision.degradedCapabilities).toContain("notifications");
    expect(decision.disabledCapabilities).toEqual([]);
  });

  it("lets a manual maintenance override disable every user-facing capability", () => {
    const decision = evaluateDegradedMode(
      report([check("database", "healthy")]),
      undefined,
      { level: "maintenance", reason: "deploy window" },
    );
    expect(decision.level).toBe("maintenance");
    expect(decision.manualOverride).toBe(true);
    expect(decision.disabledCapabilities).not.toContain("admin");
    expect(decision.disabledCapabilities).toContain("payments");
    expect(decision.allowedCapabilities).toEqual(["admin"]);
  });
});

describe("DependencyDegradedModeService", () => {
  it("normal path: returns a normal decision from a healthy report", async () => {
    const run = jest.fn().mockResolvedValue(report([check("database", "healthy")]));
    const service = buildService(run);

    const decision = await service.getMode();

    expect(decision.level).toBe("normal");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("failure path: assertCapabilityEnabled throws for a disabled capability", async () => {
    const run = jest
      .fn()
      .mockResolvedValue(report([check("database", "unavailable", "critical")]));
    const service = buildService(run);

    await expect(service.assertCapabilityEnabled("payments")).rejects.toBeInstanceOf(
      DegradedModeCapabilityBlockedError,
    );
    const view = await service.assertCapabilityEnabled("search");
    expect(view.state).toBe("available");
  });

  it("retry path: retries a transient health failure and succeeds", async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(report([check("database", "healthy")]));
    const service = buildService(run);

    const decision = await service.getMode();

    expect(decision.level).toBe("normal");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails safe when dependency health never recovers", async () => {
    const run = jest.fn().mockRejectedValue(new Error("down"));
    const service = buildService(run);

    const decision = await service.getMode();

    expect(decision.level).toBe("restricted");
    expect(decision.allowedCapabilities).toEqual(["admin"]);
    expect(decision.disabledCapabilities).toContain("payments");
  });

  it("authorization path: rejects a non-admin manual override", async () => {
    const run = jest.fn().mockResolvedValue(report([check("database", "healthy")]));
    const service = buildService(run);

    await expect(
      service.activateManualDegradation(
        { level: "restricted", reason: "nope" },
        { id: "u1", role: "MAINTAINER" },
      ),
    ).rejects.toBeInstanceOf(DegradedModeAuthorizationError);
  });

  it("lets an admin activate and clear a manual override", async () => {
    const run = jest.fn().mockResolvedValue(report([check("database", "healthy")]));
    const service = buildService(run);

    const activated = await service.activateManualDegradation(
      { level: "restricted", reason: "db failover", disabledCapabilities: ["search"] },
      { id: "admin-1", role: "ADMIN" },
    );
    expect(activated.level).toBe("restricted");
    expect(activated.manualOverride).toBe(true);
    expect(activated.disabledCapabilities).toContain("search");

    const cleared = await service.clearManualDegradation({ id: "admin-1", role: "ADMIN" });
    expect(cleared.manualOverride).toBe(false);
    expect(cleared.level).toBe("normal");
  });
});

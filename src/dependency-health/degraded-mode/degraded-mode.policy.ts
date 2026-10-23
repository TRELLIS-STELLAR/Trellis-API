import { DependencyReport } from "../dependency-health.types";
import {
  ALL_DEGRADED_CAPABILITIES,
  DegradedCapability,
  DegradedModeDecision,
  DegradedModeLevel,
  DependencyCapabilityMap,
  ManualDegradedModeInput,
} from "./degraded-mode.types";

/** Higher is more restrictive. */
export const DEGRADED_MODE_SEVERITY: Record<DegradedModeLevel, number> = {
  normal: 0,
  degraded: 1,
  restricted: 2,
  maintenance: 3,
};

/**
 * Default mapping from a dependency id to the capabilities that cannot run
 * without it. Derived from the dependency registry (issue #124): the database
 * gates money movement, Redis gates queues and search, Horizon gates payments
 * and trades, the EVM RPC gates oracle submission, and so on.
 */
export const DEFAULT_DEPENDENCY_CAPABILITY_MAP: DependencyCapabilityMap = {
  database: ["payments", "trades", "imports", "exports", "admin"],
  redis: ["notifications", "webhooks", "search"],
  background_jobs: ["notifications", "webhooks"],
  stellar_horizon: ["payments", "trades"],
  stellar_network_passphrase: ["payments", "trades"],
  eth_rpc: ["oracle"],
  object_storage: ["imports", "exports"],
  smtp: ["notifications"],
  elasticsearch: ["search"],
  otel_collector: [],
  sentry: [],
  ai_provider: [],
};

/**
 * Pure function: dependency report (+ optional manual override) → operating
 * mode. No I/O, no clock — identical input produces identical output, which is
 * what makes the policy unit-testable and safe to run on every request.
 */
export function evaluateDegradedMode(
  report: DependencyReport,
  capabilityMap: DependencyCapabilityMap = DEFAULT_DEPENDENCY_CAPABILITY_MAP,
  manual?: ManualDegradedModeInput | null,
  generatedAt: string = new Date().toISOString(),
): DegradedModeDecision {
  const disabled = new Set<DegradedCapability>();
  const degraded = new Set<DegradedCapability>();
  const reasons: string[] = [];

  for (const check of report.checks) {
    const capabilities = capabilityMap[check.id] ?? [];
    const isCritical = check.criticality === "critical";

    if (check.state === "unavailable" || check.state === "misconfigured") {
      if (isCritical) {
        capabilities.forEach((capability) => disabled.add(capability));
      } else {
        capabilities.forEach((capability) => degraded.add(capability));
      }
      reasons.push(`${check.id}: ${check.state}${isCritical ? " (critical)" : " (optional)"}`);
    } else if (check.state === "degraded") {
      capabilities.forEach((capability) => degraded.add(capability));
      reasons.push(`${check.id}: degraded${isCritical ? " (critical)" : " (optional)"}`);
    }
  }

  let level: DegradedModeLevel = "normal";
  if (disabled.size > 0) {
    level = "restricted";
  } else if (degraded.size > 0) {
    level = "degraded";
  }

  let manualOverride = false;
  if (manual) {
    manualOverride = true;
    if (DEGRADED_MODE_SEVERITY[manual.level] > DEGRADED_MODE_SEVERITY[level]) {
      level = manual.level;
    }
    (manual.disabledCapabilities ?? []).forEach((capability) => disabled.add(capability));
    reasons.unshift(`manual override: ${manual.reason}`);

    if (manual.level === "maintenance") {
      // Maintenance stops all user-facing capabilities but leaves admin
      // available so operators can clear the window.
      ALL_DEGRADED_CAPABILITIES.filter((capability) => capability !== "admin").forEach(
        (capability) => disabled.add(capability),
      );
    }
  }

  const disabledCapabilities = ALL_DEGRADED_CAPABILITIES.filter((capability) =>
    disabled.has(capability),
  );
  const degradedCapabilities = ALL_DEGRADED_CAPABILITIES.filter(
    (capability) => degraded.has(capability) && !disabled.has(capability),
  );

  return {
    level,
    active: level !== "normal",
    allowedCapabilities: ALL_DEGRADED_CAPABILITIES.filter(
      (capability) => !disabled.has(capability),
    ),
    disabledCapabilities,
    degradedCapabilities,
    reasons,
    criticalFindings: report.criticalFindings,
    advisoryFindings: report.advisoryFindings,
    manualOverride,
    generatedAt,
  };
}

/** True when `candidate` is at least as restrictive as `current`. */
export function isWorseOrEqual(
  candidate: DegradedModeLevel,
  current: DegradedModeLevel,
): boolean {
  return DEGRADED_MODE_SEVERITY[candidate] >= DEGRADED_MODE_SEVERITY[current];
}

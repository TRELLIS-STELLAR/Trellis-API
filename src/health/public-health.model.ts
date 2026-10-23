/**
 * Pure aggregation rules for the public, dependency-aware health endpoint (#281).
 *
 * Kept free of Nest and I/O so the status contract can be tested exhaustively:
 * which inputs make the API `ok`, `degraded` or `down`, and that nothing but a
 * fixed vocabulary of names and states ever leaves this function.
 */

/** Overall verdict. `down` is the only state that maps to HTTP 503. */
export type PublicHealthStatus = "ok" | "degraded" | "down";

/** Per-check state exposed publicly. Deliberately coarse. */
export type PublicCheckStatus = "up" | "degraded" | "down" | "disabled";

export interface PublicHealthCheck {
  /** Stable identifier from a fixed allow-list; never a host, URL or key name. */
  name: string;
  status: PublicCheckStatus;
  /** Whether a failure of this check takes the API out of service. */
  critical: boolean;
}

export interface PublicHealthView {
  status: PublicHealthStatus;
  timestamp: string;
  /** Seconds since process start, rounded; useful for spotting restart loops. */
  uptimeSeconds: number;
  checks: PublicHealthCheck[];
}

export interface CoreProbeInput {
  status: "up" | "down";
  /** Round-trip latency, used only to downgrade a slow but reachable dependency. */
  responseTime?: number;
}

/** Subset of the dependency-health summary the public view relies on. */
export interface DependencySummaryInput {
  status: "healthy" | "degraded" | "unavailable" | "misconfigured" | "disabled";
  advisory:
    | "healthy"
    | "degraded"
    | "unavailable"
    | "misconfigured"
    | "disabled";
}

export interface PublicHealthInput {
  database: CoreProbeInput;
  /** `null` when Redis is not configured for this deployment. */
  redis: CoreProbeInput | null;
  /**
   * Local-only dependency summary. `undefined` when the dependency check could
   * not run at all (treated as degraded, never as down: the core probes above
   * are authoritative for serving traffic).
   */
  dependencies?: DependencySummaryInput;
  /** Latency above which a reachable core dependency is reported `degraded`. */
  slowThresholdMs: number;
  now: Date;
  uptimeSeconds: number;
}

function coreStatus(
  probe: CoreProbeInput,
  slowThresholdMs: number,
): PublicCheckStatus {
  if (probe.status === "down") return "down";
  if (probe.responseTime !== undefined && probe.responseTime > slowThresholdMs)
    return "degraded";
  return "up";
}

function dependencyCheckStatus(
  state: DependencySummaryInput["status"] | undefined,
): PublicCheckStatus {
  switch (state) {
    case "healthy":
      return "up";
    case "disabled":
      return "disabled";
    case "degraded":
      return "degraded";
    case "unavailable":
    case "misconfigured":
      return "down";
    default:
      // The check itself failed to run: report it, but do not guess "down".
      return "degraded";
  }
}

export function buildPublicHealthView(
  input: PublicHealthInput,
): PublicHealthView {
  const checks: PublicHealthCheck[] = [
    {
      name: "database",
      critical: true,
      status: coreStatus(input.database, input.slowThresholdMs),
    },
    {
      name: "cache",
      // Only critical when it is actually configured; an absent cache is a
      // deployment choice, not an outage.
      critical: input.redis !== null,
      status: input.redis
        ? coreStatus(input.redis, input.slowThresholdMs)
        : "disabled",
    },
    {
      name: "external-dependencies",
      critical: true,
      status: dependencyCheckStatus(input.dependencies?.status),
    },
    {
      name: "optional-dependencies",
      critical: false,
      status: input.dependencies
        ? dependencyCheckStatus(input.dependencies.advisory)
        : "degraded",
    },
  ];

  const criticalDown = checks.some((c) => c.critical && c.status === "down");
  const anyImpaired = checks.some(
    (c) => c.status === "down" || c.status === "degraded",
  );

  return {
    status: criticalDown ? "down" : anyImpaired ? "degraded" : "ok",
    timestamp: input.now.toISOString(),
    uptimeSeconds: Math.max(0, Math.round(input.uptimeSeconds)),
    checks,
  };
}

/** HTTP status for a verdict: only a critical outage is 503; degraded still serves. */
export function httpStatusForHealth(status: PublicHealthStatus): 200 | 503 {
  return status === "down" ? 503 : 200;
}

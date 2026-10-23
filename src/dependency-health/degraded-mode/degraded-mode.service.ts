import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DependencyHealthService } from "../dependency-health.service";
import { DependencyReport } from "../dependency-health.types";
import {
  DEFAULT_DEPENDENCY_CAPABILITY_MAP,
  evaluateDegradedMode,
} from "./degraded-mode.policy";
import {
  ALL_DEGRADED_CAPABILITIES,
  DegradedCapability,
  DegradedModeCapabilityView,
  DegradedModeDecision,
  ManualDegradedModeInput,
} from "./degraded-mode.types";
import {
  DegradedModeAuthorizationError,
  DegradedModeCapabilityBlockedError,
} from "./degraded-mode.errors";

interface CacheEntry {
  decision: DegradedModeDecision;
  expiresAt: number;
}

/**
 * Turns the dependency health report (issue #124) into an enforceable
 * operating mode (issue #355).
 *
 * Instead of failing every request when a dependency is unhealthy, the API
 * enters a defined mode:
 *
 * - `normal`  — every capability is available.
 * - `degraded`— optional dependencies are degraded, or a critical dependency
 *   is slow; affected capabilities stay available but are flagged.
 * - `restricted` — a critical dependency is unavailable or misconfigured, so
 *   the capabilities that depend on it are disabled.
 * - `maintenance` — an operator-declared window; all user-facing capabilities
 *   are disabled and admin remains available.
 *
 * Paths:
 * - **Normal** — the report is healthy and no override is active.
 * - **Failure** — a critical dependency is down; `assertCapabilityEnabled`
 *   throws for the affected capabilities.
 * - **Retry** — the dependency health service throws; the service retries and
 *   then fails safe to the last known decision, or to a restricted decision.
 * - **Authorization** — only ADMIN may set or clear the manual override.
 */
@Injectable()
export class DependencyDegradedModeService {
  private readonly logger = new Logger(DependencyDegradedModeService.name);
  private readonly healthMaxAttempts: number;
  private readonly healthRetryDelayMs: number;
  private readonly cacheTtlMs: number;
  private cache: CacheEntry | null = null;
  private manualOverride: ManualDegradedModeInput | null = null;

  constructor(
    private readonly dependencyHealthService: DependencyHealthService,
    private readonly configService: ConfigService,
  ) {
    this.healthMaxAttempts =
      Number(this.configService.get("DEGRADED_MODE_HEALTH_MAX_ATTEMPTS")) || 3;
    this.healthRetryDelayMs =
      Number(this.configService.get("DEGRADED_MODE_HEALTH_RETRY_DELAY_MS")) || 50;
    this.cacheTtlMs =
      Number(this.configService.get("DEGRADED_MODE_CACHE_TTL_MS")) || 5000;
  }

  async evaluate(options: { refresh?: boolean } = {}): Promise<DegradedModeDecision> {
    if (!options.refresh && this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.decision;
    }

    let report: DependencyReport;
    try {
      report = await this.runHealthWithRetry(options.refresh ?? false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`dependency health evaluation failed: ${detail}; failing safe`);
      const fallback = this.failSafeDecision(detail);
      this.cacheDecision(fallback);
      return fallback;
    }

    const decision = evaluateDegradedMode(
      report,
      DEFAULT_DEPENDENCY_CAPABILITY_MAP,
      this.manualOverride,
    );
    this.cacheDecision(decision);
    return decision;
  }

  async getMode(): Promise<DegradedModeDecision> {
    return this.evaluate();
  }

  listCapabilities(decision: DegradedModeDecision): DegradedModeCapabilityView[] {
    const disabled = new Set(decision.disabledCapabilities);
    const degraded = new Set(decision.degradedCapabilities);
    return decision.allowedCapabilities
      .concat(decision.disabledCapabilities)
      .map((capability) => {
        if (disabled.has(capability)) {
          return { capability, state: "disabled" as const, reason: decision.reasons.join("; ") || undefined };
        }
        if (degraded.has(capability)) {
          return { capability, state: "degraded" as const, reason: decision.reasons.join("; ") || undefined };
        }
        return { capability, state: "available" as const };
      });
  }

  async assertCapabilityEnabled(
    capability: DegradedCapability,
    decision?: DegradedModeDecision,
  ): Promise<DegradedModeCapabilityView> {
    const mode = decision ?? (await this.evaluate());
    if (mode.disabledCapabilities.includes(capability)) {
      throw new DegradedModeCapabilityBlockedError(
        capability,
        mode.reasons.join("; ") || `capability disabled in ${mode.level} mode`,
      );
    }
    const view = this.listCapabilities(mode).find((entry) => entry.capability === capability);
    return view ?? { capability, state: "available" };
  }

  async activateManualDegradation(
    input: ManualDegradedModeInput,
    requester: { id: string; role: string },
  ): Promise<DegradedModeDecision> {
    this.assertAdmin(requester);
    this.manualOverride = { ...input };
    this.invalidate();
    this.logger.warn(
      `Manual degraded mode '${input.level}' activated by ${requester.id}: ${input.reason}`,
    );
    return this.evaluate({ refresh: true });
  }

  async clearManualDegradation(requester: { id: string; role: string }): Promise<DegradedModeDecision> {
    this.assertAdmin(requester);
    this.manualOverride = null;
    this.invalidate();
    this.logger.log(`Manual degraded mode cleared by ${requester.id}`);
    return this.evaluate({ refresh: true });
  }

  getManualOverride(): ManualDegradedModeInput | null {
    return this.manualOverride ? { ...this.manualOverride } : null;
  }

  invalidate(): void {
    this.cache = null;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private assertAdmin(requester: { id: string; role: string }): void {
    if (String(requester.role ?? "").toUpperCase() !== "ADMIN") {
      throw new DegradedModeAuthorizationError();
    }
  }

  private async runHealthWithRetry(refresh: boolean): Promise<DependencyReport> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.healthMaxAttempts; attempt++) {
      try {
        return await this.dependencyHealthService.run({ networkProbes: false, refresh });
      } catch (error) {
        lastError = error;
        if (attempt < this.healthMaxAttempts) {
          await this.delay(this.healthRetryDelayMs * attempt);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private failSafeDecision(reason: string): DegradedModeDecision {
    if (this.cache) return this.cache.decision;
    // Fail safe: block every user-facing capability but leave admin available
    // so operators can inspect the system and clear the mode.
    const disabledCapabilities = ALL_DEGRADED_CAPABILITIES.filter(
      (capability) => capability !== "admin",
    );
    return {
      level: "restricted",
      active: true,
      allowedCapabilities: ["admin"],
      disabledCapabilities,
      degradedCapabilities: [],
      reasons: [`dependency health unavailable: ${reason}`],
      criticalFindings: [],
      advisoryFindings: [],
      manualOverride: false,
      generatedAt: new Date().toISOString(),
    };
  }

  private cacheDecision(decision: DegradedModeDecision): void {
    if (this.cacheTtlMs > 0) {
      this.cache = { decision, expiresAt: Date.now() + this.cacheTtlMs };
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

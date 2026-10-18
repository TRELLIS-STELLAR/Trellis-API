import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HealthService } from "./health.service";
import { DependencyHealthService } from "../dependency-health/dependency-health.service";
import {
  buildPublicHealthView,
  CoreProbeInput,
  DependencySummaryInput,
  PublicHealthView,
} from "./public-health.model";

export interface PublicHealthResult {
  view: PublicHealthView;
  /** True when the view was served from the short-lived cache. */
  cached: boolean;
  /** Seconds a client should wait before polling again after a `down` verdict. */
  retryAfterSeconds: number;
}

const DEFAULTS = {
  cacheTtlMs: 5_000,
  probeRetries: 1,
  retryDelayMs: 200,
  retryAfterSeconds: 15,
  slowThresholdMs: 1_000,
};

function readPositiveInt(
  value: unknown,
  fallback: number,
  { allowZero = false } = {},
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0))
    return fallback;
  return Math.floor(parsed);
}

/**
 * Public, dependency-aware health (#281).
 *
 * - **Dependency-aware:** combines the database and (when configured) cache
 *   probes with the local-only dependency-health summary, classifying each as
 *   critical or optional.
 * - **Safe to expose:** the view contains fixed check names and coarse states
 *   only. Probe error text (which can contain hosts or credentials) is logged
 *   server-side and never returned.
 * - **Cheap under load:** results are cached briefly and concurrent callers
 *   share one in-flight evaluation, so an unauthenticated endpoint cannot be
 *   used to hammer the database or Redis.
 * - **No flapping:** a critical probe that fails is retried before the API is
 *   reported `down`.
 */
@Injectable()
export class PublicHealthService {
  private readonly logger = new Logger(PublicHealthService.name);
  private readonly cacheTtlMs: number;
  private readonly probeRetries: number;
  private readonly retryDelayMs: number;
  private readonly retryAfterSeconds: number;
  private readonly slowThresholdMs: number;

  private cache: { view: PublicHealthView; expiresAt: number } | null = null;
  private inFlight: Promise<PublicHealthView> | null = null;

  constructor(
    private readonly healthService: HealthService,
    @Optional()
    private readonly dependencyHealthService?: DependencyHealthService,
    @Optional() configService?: ConfigService,
  ) {
    const get = (key: string) => configService?.get(key) ?? process.env[key];
    this.cacheTtlMs = readPositiveInt(
      get("HEALTH_PUBLIC_CACHE_TTL_MS"),
      DEFAULTS.cacheTtlMs,
      {
        allowZero: true,
      },
    );
    this.probeRetries = readPositiveInt(
      get("HEALTH_PUBLIC_PROBE_RETRIES"),
      DEFAULTS.probeRetries,
      {
        allowZero: true,
      },
    );
    this.retryDelayMs = readPositiveInt(
      get("HEALTH_PUBLIC_RETRY_DELAY_MS"),
      DEFAULTS.retryDelayMs,
      {
        allowZero: true,
      },
    );
    this.retryAfterSeconds = readPositiveInt(
      get("HEALTH_PUBLIC_RETRY_AFTER_SECONDS"),
      DEFAULTS.retryAfterSeconds,
    );
    this.slowThresholdMs = readPositiveInt(
      get("HEALTH_PUBLIC_SLOW_THRESHOLD_MS"),
      DEFAULTS.slowThresholdMs,
    );
  }

  async getHealth(): Promise<PublicHealthResult> {
    const now = this.clock();
    if (this.cache && this.cache.expiresAt > now) {
      return {
        view: this.cache.view,
        cached: true,
        retryAfterSeconds: this.retryAfterSeconds,
      };
    }

    // Single-flight: every caller that arrives while an evaluation is running
    // waits for that one instead of starting its own probes.
    if (!this.inFlight) {
      this.inFlight = this.evaluate().finally(() => {
        this.inFlight = null;
      });
    }
    const view = await this.inFlight;
    return { view, cached: false, retryAfterSeconds: this.retryAfterSeconds };
  }

  /** Drops the cached verdict, e.g. after an operator fixes an outage. */
  invalidate(): void {
    this.cache = null;
  }

  /** Clock seam for tests. */
  protected clock(): number {
    return Date.now();
  }

  /** Backoff seam for tests. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async evaluate(): Promise<PublicHealthView> {
    let attempt = 0;
    let core = await this.probeCore();

    // Retry only when a critical core probe failed: one transient blip (a
    // dropped connection, a GC pause) should not flip the public status.
    while (this.coreDown(core) && attempt < this.probeRetries) {
      attempt += 1;
      if (this.retryDelayMs > 0) await this.sleep(this.retryDelayMs);
      core = await this.probeCore();
    }

    const dependencies = await this.probeDependencies();
    const view = buildPublicHealthView({
      ...core,
      dependencies,
      slowThresholdMs: this.slowThresholdMs,
      now: new Date(this.clock()),
      uptimeSeconds: process.uptime(),
    });

    if (view.status !== "ok") {
      const impaired = view.checks.filter(
        (c) => c.status === "down" || c.status === "degraded",
      );
      this.logger.warn(
        `public health ${view.status} after ${attempt + 1} attempt(s): ` +
          impaired.map((c) => `${c.name}=${c.status}`).join(", "),
      );
    }

    if (this.cacheTtlMs > 0) {
      this.cache = { view, expiresAt: this.clock() + this.cacheTtlMs };
    }
    return view;
  }

  private coreDown(core: {
    database: CoreProbeInput;
    redis: CoreProbeInput | null;
  }): boolean {
    return core.database.status === "down" || core.redis?.status === "down";
  }

  private async probeCore(): Promise<{
    database: CoreProbeInput;
    redis: CoreProbeInput | null;
  }> {
    try {
      const { database, redis } =
        await this.healthService.checkCoreComponents();
      if (database.status === "down" && database.message) {
        // Server-side only: messages can carry hosts or connection strings.
        this.logger.warn(`database probe failed: ${database.message}`);
      }
      if (redis?.status === "down" && redis.message) {
        this.logger.warn(`cache probe failed: ${redis.message}`);
      }
      return {
        database: {
          status: database.status,
          responseTime: database.responseTime,
        },
        redis: redis
          ? { status: redis.status, responseTime: redis.responseTime }
          : null,
      };
    } catch (error) {
      this.logger.error(
        `core health probes threw: ${(error as Error)?.message ?? error}`,
      );
      return { database: { status: "down" }, redis: null };
    }
  }

  private async probeDependencies(): Promise<
    DependencySummaryInput | undefined
  > {
    if (!this.dependencyHealthService) {
      return { status: "disabled", advisory: "disabled" };
    }
    try {
      // Local checks only: this endpoint is public and must never trigger
      // outbound requests to third parties.
      const summary = await this.dependencyHealthService.getSummary({
        networkProbes: false,
      });
      return { status: summary.status, advisory: summary.advisory };
    } catch (error) {
      this.logger.error(
        `dependency health summary failed: ${(error as Error)?.message ?? error}`,
      );
      return undefined;
    }
  }
}

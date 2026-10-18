import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { logger } from "../../config/logger";
import { CacheService } from "./cache.service";

/**
 * A warmer function that pre-loads data into the cache.
 *
 * @returns The number of entries warmed.
 */
export type CacheWarmerFn = (cache: CacheService) => Promise<number>;

/**
 * Describes a single warming task.
 */
export interface CacheWarmer {
  /** Human-readable name (used in logs). */
  name: string;

  /** The function that warms the cache. */
  execute: CacheWarmerFn;
}

/**
 * Pre-loads frequently accessed data into the cache on application startup.
 *
 * Register warmers via {@link registerWarmer}. Startup warming is launched
 * without delaying application bootstrap, while each warmer runs sequentially
 * with full error isolation.
 */
@Injectable()
export class CacheWarmingService implements OnApplicationBootstrap {
  private readonly warmers: CacheWarmer[] = [];
  private activeWarm: Promise<{ totalEntries: number; durationMs: number }> | null = null;

  constructor(private readonly cache: CacheService) {}

  /**
   * Register a warmer for execution at startup.
   */
  registerWarmer(warmer: CacheWarmer): void {
    this.warmers.push(warmer);
  }

  /** Launch startup warming in the background so remote reads never block boot. */
  onApplicationBootstrap(): void {
    void this.warm().catch((err) => {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Startup cache warming failed");
    });
  }

  /** Refresh warmed data every fifteen minutes. */
  @Cron("0 */15 * * * *")
  async warmOnSchedule(): Promise<void> {
    await this.warm();
  }

  /**
   * Manually trigger all warmers (e.g. via a scheduled job).
   */
  async warm(): Promise<{ totalEntries: number; durationMs: number }> {
    if (this.activeWarm) return this.activeWarm;

    this.activeWarm = this.runWarmers();
    try {
      return await this.activeWarm;
    } finally {
      this.activeWarm = null;
    }
  }

  private async runWarmers(): Promise<{ totalEntries: number; durationMs: number }> {
    if (this.warmers.length === 0) {
      logger.info("Cache warming: no warmers registered, skipping");
      return { totalEntries: 0, durationMs: 0 };
    }

    const start = Date.now();
    let totalEntries = 0;
    let successCount = 0;
    let failCount = 0;

    logger.info({ warmerCount: this.warmers.length }, "Cache warming started");

    for (const warmer of this.warmers) {
      try {
        const count = await warmer.execute(this.cache);
        totalEntries += count;
        successCount++;
      } catch (err) {
        failCount++;
        logger.error(
          { warmer: warmer.name, error: err instanceof Error ? err.message : String(err) },
          "Cache warmer failed",
        );
      }
    }

    const durationMs = Date.now() - start;
    logger.info(
      { warmers: this.warmers.length, success: successCount, failed: failCount, totalEntries, durationMs },
      "Cache warming completed",
    );
    return { totalEntries, durationMs };
  }

  /** List registered warmer names. */
  listWarmers(): string[] {
    return this.warmers.map((w) => w.name);
  }
}

import { Logger, BadRequestException, ForbiddenException } from "@nestjs/common";
import { randomUUID } from "crypto";

export type CacheEntryStatus = "fresh" | "stale" | "expired";

export interface BoundedCacheOptions {
  maxEntries?: number;
  defaultTtlMs?: number;
  defaultStaleTtlMs?: number;
  onEvict?: (key: string, reason: "capacity" | "expired" | "explicit") => void;
}

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  createdAt: number;
  freshUntil: number;
  staleUntil: number;
  version: number;
  tags: Set<string>;
}

export interface BoundedCacheGetResult<T = unknown> {
  value: T;
  status: CacheEntryStatus;
  isStale: boolean;
  version: number;
  createdAt: number;
  freshUntil: number;
  staleUntil: number;
}

export interface BoundedCacheStats {
  size: number;
  maxEntries: number;
  hits: number;
  misses: number;
  staleHits: number;
  evictions: number;
  invalidations: number;
  hitRate: number;
}

export interface StaleEntryInspection<T = unknown> {
  key: string;
  status: CacheEntryStatus;
  ageMs: number;
  freshTtlRemainingMs: number;
  staleTtlRemainingMs: number;
  version: number;
  tags: string[];
}

export interface StaleDetectionReport<T = unknown> {
  timestamp: string;
  totalEntries: number;
  freshCount: number;
  staleCount: number;
  expiredCount: number;
  entries: StaleEntryInspection<T>[];
  recommendations: string[];
}

export interface InvalidateBoundedOptions {
  key?: string;
  prefix?: string;
  tag?: string;
  minVersion?: number;
  maxKeysToInvalidate?: number;
  actor?: {
    id: string;
    roles: string[];
  };
}

export interface InvalidationSnapshot<T = unknown> {
  snapshotId: string;
  timestamp: string;
  entries: CacheEntry<T>[];
}

export interface BoundedInvalidationReceipt<T = unknown> {
  receiptId: string;
  timestamp: string;
  invalidatedCount: number;
  invalidatedKeys: string[];
  snapshot: InvalidationSnapshot<T>;
}

export interface GetOrRevalidateWithRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  ttlMs?: number;
  staleTtlMs?: number;
  tags?: string[];
  version?: number;
}

export interface GetOrRevalidateWithRetryResult<T = unknown> {
  value: T;
  degraded: boolean;
  fromCache: boolean;
  error?: string;
}

/**
 * A memory-bounded LRU cache with explicit invalidation rules
 * and stale-while-revalidate (SWR) stale detection.
 */
export class BoundedCache<T = unknown> {
  private readonly logger = new Logger(BoundedCache.name);
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly tagMap = new Map<string, Set<string>>();
  private readonly inflightRevalidations = new Map<string, Promise<T>>();

  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly defaultStaleTtlMs: number;
  private readonly onEvict?: (
    key: string,
    reason: "capacity" | "expired" | "explicit",
  ) => void;

  private hits = 0;
  private misses = 0;
  private staleHits = 0;
  private evictions = 0;
  private invalidations = 0;

  constructor(options: BoundedCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 1000);
    this.defaultTtlMs = Math.max(0, options.defaultTtlMs ?? 60_000);
    this.defaultStaleTtlMs = Math.max(0, options.defaultStaleTtlMs ?? 300_000);
    this.onEvict = options.onEvict;
  }

  /**
   * Get an item from the cache with stale status evaluation.
   */
  get(key: string, now: number = Date.now()): BoundedCacheGetResult<T> | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Refresh LRU order on access
    this.entries.delete(key);
    this.entries.set(key, entry);

    if (now >= entry.staleUntil) {
      // Past acceptable stale window -> expired
      this.evict(key, "expired");
      this.misses++;
      return null;
    }

    const isStale = now >= entry.freshUntil;
    const status: CacheEntryStatus = isStale ? "stale" : "fresh";

    if (isStale) {
      this.staleHits++;
    } else {
      this.hits++;
    }

    return {
      value: entry.value,
      status,
      isStale,
      version: entry.version,
      createdAt: entry.createdAt,
      freshUntil: entry.freshUntil,
      staleUntil: entry.staleUntil,
    };
  }

  /**
   * Set an item with explicit TTL, stale tolerance, tags, and version.
   */
  set(
    key: string,
    value: T,
    options?: {
      ttlMs?: number;
      staleTtlMs?: number;
      tags?: string[];
      version?: number;
      now?: number;
    },
  ): void {
    const now = options?.now ?? Date.now();
    const ttlMs = options?.ttlMs ?? this.defaultTtlMs;
    const staleTtlMs = options?.staleTtlMs ?? this.defaultStaleTtlMs;
    const tags = new Set(options?.tags ?? []);
    const version = options?.version ?? 1;

    // Remove existing key to refresh LRU position
    if (this.entries.has(key)) {
      this.removeKeyFromTags(key);
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      // Evict oldest (first key in map iteration)
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.evict(oldestKey, "capacity");
      }
    }

    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: now,
      freshUntil: now + ttlMs,
      staleUntil: now + ttlMs + staleTtlMs,
      version,
      tags,
    };

    this.entries.set(key, entry);
    this.addKeyToTags(key, tags);
  }

  /**
   * Stale-while-revalidate pattern:
   * Returns immediately if fresh. If stale, returns cached value and
   * revalidates in the background with singleflight protection.
   * If missing or expired, revalidates synchronously.
   */
  async getOrRevalidate(
    key: string,
    fetchFn: () => Promise<T>,
    options?: {
      ttlMs?: number;
      staleTtlMs?: number;
      tags?: string[];
      version?: number;
    },
  ): Promise<T> {
    const cached = this.get(key);

    if (cached && !cached.isStale) {
      return cached.value;
    }

    if (cached && cached.isStale) {
      // Background revalidation
      this.revalidateInBackground(key, fetchFn, options);
      return cached.value;
    }

    // Cache miss or expired -> synchronous compute
    return this.executeRevalidation(key, fetchFn, options);
  }

  private revalidateInBackground(
    key: string,
    fetchFn: () => Promise<T>,
    options?: {
      ttlMs?: number;
      staleTtlMs?: number;
      tags?: string[];
      version?: number;
    },
  ): void {
    if (this.inflightRevalidations.has(key)) return;

    this.executeRevalidation(key, fetchFn, options).catch((err) => {
      this.logger.warn(
        { error: err.message, key },
        "Background cache revalidation failed, retained stale value",
      );
    });
  }

  private async executeRevalidation(
    key: string,
    fetchFn: () => Promise<T>,
    options?: {
      ttlMs?: number;
      staleTtlMs?: number;
      tags?: string[];
      version?: number;
    },
  ): Promise<T> {
    if (this.inflightRevalidations.has(key)) {
      return this.inflightRevalidations.get(key)!;
    }

    const promise = (async () => {
      try {
        const freshValue = await fetchFn();
        this.set(key, freshValue, options);
        return freshValue;
      } finally {
        this.inflightRevalidations.delete(key);
      }
    })();

    this.inflightRevalidations.set(key, promise);
    return promise;
  }

  /**
   * Explicitly invalidate a single key.
   */
  invalidate(key: string): boolean {
    if (!this.entries.has(key)) return false;
    this.evict(key, "explicit");
    this.invalidations++;
    return true;
  }

  /**
   * Explicitly invalidate all keys associated with a given tag.
   */
  invalidateTag(tag: string): number {
    const keys = this.tagMap.get(tag);
    if (!keys || keys.size === 0) return 0;

    let count = 0;
    for (const key of Array.from(keys)) {
      if (this.invalidate(key)) {
        count++;
      }
    }
    this.tagMap.delete(tag);
    return count;
  }

  /**
   * Explicitly invalidate all keys starting with a prefix.
   */
  invalidatePrefix(prefix: string): number {
    let count = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) {
        if (this.invalidate(key)) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Explicitly invalidate entries where version is less than required version.
   */
  invalidateStaleVersion(minVersion: number): number {
    let count = 0;
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (entry.version < minVersion) {
        if (this.invalidate(key)) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Clear all entries and tags.
   */
  clear(): void {
    this.entries.clear();
    this.tagMap.clear();
    this.inflightRevalidations.clear();
  }

  /**
   * Check if an active entry exists.
   */
  has(key: string, now: number = Date.now()): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (now >= entry.staleUntil) {
      this.evict(key, "expired");
      return false;
    }
    return true;
  }

  /**
   * Current number of cached entries.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Retrieve performance and capacity statistics.
   */
  getStats(): BoundedCacheStats {
    const totalRequests = this.hits + this.staleHits + this.misses;
    const hitRate = totalRequests > 0 ? (this.hits + this.staleHits) / totalRequests : 0;

    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      staleHits: this.staleHits,
      evictions: this.evictions,
      invalidations: this.invalidations,
      hitRate: Math.round(hitRate * 1000) / 1000,
    };
  }

  /**
   * Stale detection & health inspection (#486).
   * Analyzes active cache entries to identify fresh, stale, and expired items,
   * calculating age, TTL remaining, and actionable maintenance recommendations.
   */
  detectStaleEntries(now: number = Date.now()): StaleDetectionReport<T> {
    const inspections: StaleEntryInspection<T>[] = [];
    let freshCount = 0;
    let staleCount = 0;
    let expiredCount = 0;

    for (const [key, entry] of this.entries.entries()) {
      const isExpired = now >= entry.staleUntil;
      const isStale = !isExpired && now >= entry.freshUntil;

      let status: CacheEntryStatus = "fresh";
      if (isExpired) {
        status = "expired";
        expiredCount++;
      } else if (isStale) {
        status = "stale";
        staleCount++;
      } else {
        freshCount++;
      }

      inspections.push({
        key,
        status,
        ageMs: Math.max(0, now - entry.createdAt),
        freshTtlRemainingMs: Math.max(0, entry.freshUntil - now),
        staleTtlRemainingMs: Math.max(0, entry.staleUntil - now),
        version: entry.version,
        tags: Array.from(entry.tags),
      });
    }

    const recommendations: string[] = [];
    if (staleCount > 0) {
      recommendations.push(
        `Found ${staleCount} stale entries eligible for background revalidation`,
      );
    }
    if (expiredCount > 0) {
      recommendations.push(
        `Found ${expiredCount} expired entries recommended for immediate bounded eviction`,
      );
    }
    const stats = this.getStats();
    if (stats.hitRate < 0.5 && stats.misses > 10) {
      recommendations.push(
        "Low cache hit rate (<50%) detected; consider pre-warming hot keys or lengthening TTL",
      );
    }

    return {
      timestamp: new Date(now).toISOString(),
      totalEntries: this.entries.size,
      freshCount,
      staleCount,
      expiredCount,
      entries: inspections,
      recommendations,
    };
  }

  /**
   * Bounded cache invalidation with caller authorization, safety caps,
   * and atomic rollback snapshot generation (#486).
   */
  invalidateBounded(options: InvalidateBoundedOptions): BoundedInvalidationReceipt<T> {
    // 1. Authorization Path
    if (options.actor) {
      const roles = (options.actor.roles ?? []).map((r) => r.toUpperCase());
      const isAuthorized = roles.includes("ADMIN") || roles.includes("MAINTAINER");
      if (!isAuthorized) {
        throw new ForbiddenException(
          "Insufficient privileges: cache invalidation requires ADMIN or MAINTAINER role",
        );
      }
    }

    // 2. Failure Path: Validate at least one criteria is specified
    const hasCriteria =
      options.key !== undefined ||
      options.prefix !== undefined ||
      options.tag !== undefined ||
      options.minVersion !== undefined;

    if (!hasCriteria) {
      throw new BadRequestException(
        "At least one invalidation criteria (key, prefix, tag, minVersion) must be specified",
      );
    }

    const matchingKeys = new Set<string>();

    if (options.key) {
      if (this.entries.has(options.key)) {
        matchingKeys.add(options.key);
      }
    }

    if (options.prefix) {
      if (options.prefix.trim() === "") {
        throw new BadRequestException("Invalidation prefix must not be empty");
      }
      for (const k of this.entries.keys()) {
        if (k.startsWith(options.prefix)) {
          matchingKeys.add(k);
        }
      }
    }

    if (options.tag) {
      if (options.tag.trim() === "") {
        throw new BadRequestException("Invalidation tag must not be empty");
      }
      const taggedKeys = this.tagMap.get(options.tag);
      if (taggedKeys) {
        for (const k of taggedKeys) {
          matchingKeys.add(k);
        }
      }
    }

    if (options.minVersion !== undefined) {
      for (const [k, entry] of this.entries.entries()) {
        if (entry.version < options.minVersion) {
          matchingKeys.add(k);
        }
      }
    }

    // Safety limit check
    const maxKeys = options.maxKeysToInvalidate ?? 5000;
    if (matchingKeys.size > maxKeys) {
      throw new BadRequestException(
        `Invalidation target count (${matchingKeys.size}) exceeds safety bound (${maxKeys})`,
      );
    }

    // Capture rollback snapshot
    const snapshotEntries: CacheEntry<T>[] = [];
    for (const key of matchingKeys) {
      const entry = this.entries.get(key);
      if (entry) {
        snapshotEntries.push({
          ...entry,
          tags: new Set(entry.tags),
        });
      }
    }

    const snapshot: InvalidationSnapshot<T> = {
      snapshotId: randomUUID(),
      timestamp: new Date().toISOString(),
      entries: snapshotEntries,
    };

    // Evict matching keys
    const invalidatedKeys: string[] = [];
    for (const key of matchingKeys) {
      if (this.invalidate(key)) {
        invalidatedKeys.push(key);
      }
    }

    return {
      receiptId: randomUUID(),
      timestamp: new Date().toISOString(),
      invalidatedCount: invalidatedKeys.length,
      invalidatedKeys,
      snapshot,
    };
  }

  /**
   * Restores cache entries from an invalidation snapshot for rollback recovery (#486).
   */
  rollbackInvalidation(
    snapshot: InvalidationSnapshot<T>,
    actor?: { id: string; roles: string[] },
  ): { restoredCount: number; restoredKeys: string[] } {
    if (actor) {
      const roles = (actor.roles ?? []).map((r) => r.toUpperCase());
      const isAuthorized = roles.includes("ADMIN") || roles.includes("MAINTAINER");
      if (!isAuthorized) {
        throw new ForbiddenException(
          "Insufficient privileges: cache rollback requires ADMIN or MAINTAINER role",
        );
      }
    }

    if (!snapshot || !Array.isArray(snapshot.entries)) {
      throw new BadRequestException("Invalid snapshot: entries array required");
    }

    const restoredKeys: string[] = [];
    for (const entry of snapshot.entries) {
      this.entries.set(entry.key, {
        ...entry,
        tags: new Set(entry.tags),
      });
      this.addKeyToTags(entry.key, entry.tags);
      restoredKeys.push(entry.key);
    }

    return {
      restoredCount: restoredKeys.length,
      restoredKeys,
    };
  }

  /**
   * Resilient revalidation with retry and graceful degraded stale fallback (#486).
   * If downstream fetcher fails transiently, retries with exponential backoff.
   * If all retries fail but stale entry is available, serves stale data in degraded mode.
   */
  async getOrRevalidateWithRetry(
    key: string,
    fetchFn: () => Promise<T>,
    options?: GetOrRevalidateWithRetryOptions,
  ): Promise<GetOrRevalidateWithRetryResult<T>> {
    const now = Date.now();
    const cached = this.get(key, now);

    if (cached && !cached.isStale) {
      return { value: cached.value, degraded: false, fromCache: true };
    }

    const maxRetries = options?.maxRetries ?? 3;
    const initialDelay = options?.initialDelayMs ?? 10;

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const freshValue = await fetchFn();
        this.set(key, freshValue, {
          ttlMs: options?.ttlMs,
          staleTtlMs: options?.staleTtlMs,
          tags: options?.tags,
          version: options?.version,
        });
        return { value: freshValue, degraded: false, fromCache: false };
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) {
          const delay = initialDelay * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // Retries exhausted -> evaluate graceful degraded mode
    if (cached) {
      this.logger.warn(
        `Revalidation failed after ${maxRetries} attempts for key '${key}'. Serving degraded stale entry. Error: ${lastError?.message}`,
      );
      return {
        value: cached.value,
        degraded: true,
        fromCache: true,
        error: lastError?.message,
      };
    }

    throw lastError ?? new Error(`Failed to revalidate cache key '${key}'`);
  }

  private evict(key: string, reason: "capacity" | "expired" | "explicit"): void {
    this.removeKeyFromTags(key);
    this.entries.delete(key);
    this.evictions++;
    if (this.onEvict) {
      this.onEvict(key, reason);
    }
  }

  private addKeyToTags(key: string, tags: Set<string>): void {
    for (const tag of tags) {
      if (!this.tagMap.has(tag)) {
        this.tagMap.set(tag, new Set());
      }
      this.tagMap.get(tag)!.add(key);
    }
  }

  private removeKeyFromTags(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    for (const tag of entry.tags) {
      const keys = this.tagMap.get(tag);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) {
          this.tagMap.delete(tag);
        }
      }
    }
  }
}

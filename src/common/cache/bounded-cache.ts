import { Logger } from "@nestjs/common";

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

import { BoundedCache } from "./bounded-cache";

describe("BoundedCache (#294)", () => {
  it("bounds capacity and evicts least recently accessed entries", () => {
    const evicted: Array<{ key: string; reason: string }> = [];
    const cache = new BoundedCache<string>({
      maxEntries: 3,
      onEvict: (key, reason) => evicted.push({ key, reason }),
    });

    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    // Access "a" so "b" becomes the least recently used
    expect(cache.get("a")?.value).toBe("1");

    // Adding 4th item should evict "b"
    cache.set("d", "4");

    expect(cache.size).toBe(3);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")?.value).toBe("1");
    expect(cache.get("c")?.value).toBe("3");
    expect(cache.get("d")?.value).toBe("4");

    expect(evicted).toEqual([{ key: "b", reason: "capacity" }]);
  });

  it("detects fresh vs stale vs expired status correctly", () => {
    const baseTime = 1_000_000;
    const cache = new BoundedCache<string>({
      defaultTtlMs: 5000,
      defaultStaleTtlMs: 10000,
    });

    cache.set("item", "data", {
      ttlMs: 5000,
      staleTtlMs: 10000,
      now: baseTime,
    });

    // Fresh
    const fresh = cache.get("item", baseTime + 2000);
    expect(fresh?.status).toBe("fresh");
    expect(fresh?.isStale).toBe(false);
    expect(fresh?.value).toBe("data");

    // Stale but within acceptable window
    const stale = cache.get("item", baseTime + 7000);
    expect(stale?.status).toBe("stale");
    expect(stale?.isStale).toBe(true);
    expect(stale?.value).toBe("data");

    // Expired (past 5000 + 10000)
    const expired = cache.get("item", baseTime + 16000);
    expect(expired).toBeNull();
    expect(cache.has("item", baseTime + 16000)).toBe(false);
  });

  it("invalidates explicitly by key", () => {
    const cache = new BoundedCache<string>();
    cache.set("key1", "val1");
    cache.set("key2", "val2");

    expect(cache.invalidate("key1")).toBe(true);
    expect(cache.get("key1")).toBeNull();
    expect(cache.get("key2")?.value).toBe("val2");
    expect(cache.invalidate("key1")).toBe(false);
  });

  it("invalidates explicitly by tag", () => {
    const cache = new BoundedCache<string>();
    cache.set("user:1:portfolio", "p1", { tags: ["user:1", "portfolio"] });
    cache.set("user:1:settings", "s1", { tags: ["user:1", "settings"] });
    cache.set("user:2:portfolio", "p2", { tags: ["user:2", "portfolio"] });

    // Invalidate all for user:1
    const count = cache.invalidateTag("user:1");
    expect(count).toBe(2);

    expect(cache.get("user:1:portfolio")).toBeNull();
    expect(cache.get("user:1:settings")).toBeNull();
    expect(cache.get("user:2:portfolio")?.value).toBe("p2");
  });

  it("invalidates explicitly by prefix", () => {
    const cache = new BoundedCache<string>();
    cache.set("ledger:100", "v100");
    cache.set("ledger:101", "v101");
    cache.set("contract:100", "c100");

    const count = cache.invalidatePrefix("ledger:");
    expect(count).toBe(2);

    expect(cache.get("ledger:100")).toBeNull();
    expect(cache.get("ledger:101")).toBeNull();
    expect(cache.get("contract:100")?.value).toBe("c100");
  });

  it("invalidates entries with stale version", () => {
    const cache = new BoundedCache<string>();
    cache.set("schema:1", "old", { version: 1 });
    cache.set("schema:2", "current", { version: 2 });
    cache.set("schema:3", "new", { version: 3 });

    const count = cache.invalidateStaleVersion(2);
    expect(count).toBe(1);

    expect(cache.get("schema:1")).toBeNull();
    expect(cache.get("schema:2")?.value).toBe("current");
    expect(cache.get("schema:3")?.value).toBe("new");
  });

  it("supports stale-while-revalidate pattern with singleflight deduplication", async () => {
    const cache = new BoundedCache<number>({
      defaultTtlMs: 10,
      defaultStaleTtlMs: 1000,
    });

    let computeCount = 0;
    const fetchFn = async () => {
      computeCount++;
      return computeCount;
    };

    // First call: initial compute
    const val1 = await cache.getOrRevalidate("counter", fetchFn, {
      ttlMs: 20,
      staleTtlMs: 200,
    });
    expect(val1).toBe(1);
    expect(computeCount).toBe(1);

    // Immediate second call: fresh
    const val2 = await cache.getOrRevalidate("counter", fetchFn);
    expect(val2).toBe(1);
    expect(computeCount).toBe(1);

    // Wait until fresh window passes but stale window remains
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Stale call: returns stale value immediately and revalidates in background
    const val3 = await cache.getOrRevalidate("counter", fetchFn);
    expect(val3).toBe(1);

    // Allow background revalidation to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(computeCount).toBe(2);

    // Subsequent call gets fresh value
    const val4 = await cache.getOrRevalidate("counter", fetchFn);
    expect(val4).toBe(2);
  });

  it("reports accurate stats and hit rates", () => {
    const cache = new BoundedCache<string>({ maxEntries: 5 });

    cache.set("a", "1");
    cache.get("a"); // hit
    cache.get("b"); // miss
    cache.invalidate("a"); // invalidate

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.invalidations).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });
});

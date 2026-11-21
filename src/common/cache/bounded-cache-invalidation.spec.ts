import {
  BoundedCache,
  InvalidationSnapshot,
  StaleDetectionReport,
} from "./bounded-cache";

describe("Bounded Cache Invalidation and Stale Detection (#486)", () => {
  let cache: BoundedCache<string>;

  beforeEach(() => {
    cache = new BoundedCache<string>({
      maxEntries: 100,
      defaultTtlMs: 1000,
      defaultStaleTtlMs: 2000,
    });
  });

  describe("Normal Path: Invalidation, Inspection & Rollback", () => {
    it("invalidates by key, prefix, and tag and produces an atomic rollback snapshot", () => {
      cache.set("user:101:profile", "Profile 101", { tags: ["user", "profile"] });
      cache.set("user:102:profile", "Profile 102", { tags: ["user", "profile"] });
      cache.set("order:999:details", "Order 999", { tags: ["orders"] });

      // Invalidate by prefix with MAINTAINER actor
      const receipt = cache.invalidateBounded({
        prefix: "user:",
        actor: { id: "maint-1", roles: ["MAINTAINER"] },
      });

      expect(receipt.invalidatedCount).toBe(2);
      expect(receipt.invalidatedKeys).toEqual(
        expect.arrayContaining(["user:101:profile", "user:102:profile"]),
      );
      expect(cache.has("user:101:profile")).toBe(false);
      expect(cache.has("order:999:details")).toBe(true);

      // Verify Rollback
      const rollback = cache.rollbackInvalidation(receipt.snapshot, {
        id: "admin-1",
        roles: ["ADMIN"],
      });
      expect(rollback.restoredCount).toBe(2);
      expect(cache.has("user:101:profile")).toBe(true);
      expect(cache.get("user:101:profile")?.value).toBe("Profile 101");
    });

    it("performs comprehensive stale detection and health inspection", () => {
      const now = 1_000_000;
      // Entry 1: Fresh (expires at 1_001_000)
      cache.set("item:fresh", "Fresh Value", { ttlMs: 1000, staleTtlMs: 2000 });
      // Entry 2: Stale (freshUntil < now < staleUntil)
      cache.set("item:stale", "Stale Value", { ttlMs: 500, staleTtlMs: 1500 });
      // Entry 3: Expired (staleUntil < now)
      cache.set("item:expired", "Expired Value", { ttlMs: 200, staleTtlMs: 300 });

      const report: StaleDetectionReport<string> = cache.detectStaleEntries(
        Date.now() + 600,
      );

      expect(report.totalEntries).toBe(3);
      expect(report.staleCount).toBeGreaterThanOrEqual(1);
      expect(report.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe("Failure Path", () => {
    it("fails fast when no invalidation criteria is provided", () => {
      expect(() =>
        cache.invalidateBounded({
          actor: { id: "admin-1", roles: ["ADMIN"] },
        }),
      ).toThrow("At least one invalidation criteria");
    });

    it("fails fast on empty prefix or tag", () => {
      expect(() =>
        cache.invalidateBounded({
          prefix: "   ",
          actor: { id: "admin-1", roles: ["ADMIN"] },
        }),
      ).toThrow("Invalidation prefix must not be empty");

      expect(() =>
        cache.invalidateBounded({
          tag: "   ",
          actor: { id: "admin-1", roles: ["ADMIN"] },
        }),
      ).toThrow("Invalidation tag must not be empty");
    });

    it("enforces safety limit when invalidation targets exceed maxKeysToInvalidate", () => {
      for (let i = 0; i < 15; i++) {
        cache.set(`bulk:${i}`, `Val ${i}`);
      }

      expect(() =>
        cache.invalidateBounded({
          prefix: "bulk:",
          maxKeysToInvalidate: 10,
          actor: { id: "admin-1", roles: ["ADMIN"] },
        }),
      ).toThrow("exceeds safety bound (10)");
    });
  });

  describe("Retry Path & Degraded Stale Fallback", () => {
    it("retries transient revalidation errors with exponential backoff and succeeds", async () => {
      let attempts = 0;
      const fetcher = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Transient network timeout");
        }
        return "Recovered Value";
      };

      const result = await cache.getOrRevalidateWithRetry("retry:key", fetcher, {
        maxRetries: 3,
        initialDelayMs: 10,
      });

      expect(attempts).toBe(3);
      expect(result.value).toBe("Recovered Value");
      expect(result.degraded).toBe(false);
      expect(result.fromCache).toBe(false);
    });

    it("gracefully falls back to serving stale data in degraded mode when revalidation fails completely", async () => {
      // Seed a stale entry: fresh for 50ms, stale until 1000ms
      cache.set("stale:key", "Original Stale Value", {
        ttlMs: 50,
        staleTtlMs: 2000,
      });

      // Wait for it to become stale
      await new Promise((resolve) => setTimeout(resolve, 60));

      const failingFetcher = async () => {
        throw new Error("Downstream service completely unavailable");
      };

      const result = await cache.getOrRevalidateWithRetry(
        "stale:key",
        failingFetcher,
        {
          maxRetries: 2,
          initialDelayMs: 10,
        },
      );

      expect(result.degraded).toBe(true);
      expect(result.value).toBe("Original Stale Value");
      expect(result.fromCache).toBe(true);
      expect(result.error).toContain("Downstream service completely unavailable");
    });
  });

  describe("Authorization Path", () => {
    it("permits ADMIN and MAINTAINER for bounded invalidation and rollback", () => {
      cache.set("auth:1", "Value 1");

      const receipt = cache.invalidateBounded({
        key: "auth:1",
        actor: { id: "admin-1", roles: ["ADMIN"] },
      });
      expect(receipt.invalidatedCount).toBe(1);

      expect(() =>
        cache.rollbackInvalidation(receipt.snapshot, {
          id: "maint-1",
          roles: ["MAINTAINER"],
        }),
      ).not.toThrow();
    });

    it("rejects unauthorized users with 403 Forbidden", () => {
      cache.set("protected:key", "Value");

      expect(() =>
        cache.invalidateBounded({
          key: "protected:key",
          actor: { id: "user-1", roles: ["USER"] },
        }),
      ).toThrow("requires ADMIN or MAINTAINER role");

      const dummySnapshot: InvalidationSnapshot<string> = {
        snapshotId: "snap-1",
        timestamp: new Date().toISOString(),
        entries: [],
      };

      expect(() =>
        cache.rollbackInvalidation(dummySnapshot, {
          id: "user-1",
          roles: ["USER"],
        }),
      ).toThrow("requires ADMIN or MAINTAINER role");
    });
  });
});

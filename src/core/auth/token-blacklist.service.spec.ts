import { Test, TestingModule } from "@nestjs/testing";
import {
  RedisLikeClient,
  SESSION_CUTOFF_TTL_SECONDS,
  TokenBlacklistService,
} from "./token-blacklist.service";

/**
 * The service is async because a Redis-backed revocation check is a network
 * call. These tests cover both modes: the in-process fallback (no client) and
 * the distributed path (a stub client), including the fail-closed behaviour
 * when Redis is unreachable.
 */
describe("TokenBlacklistService", () => {
  describe("in-process fallback (no Redis)", () => {
    let service: TokenBlacklistService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [TokenBlacklistService],
      }).compile();
      service = module.get<TokenBlacklistService>(TokenBlacklistService);
      jest.clearAllMocks();
      await service.onModuleDestroy();
    });

    afterEach(async () => {
      await service.onModuleDestroy();
    });

    it("should be defined", () => {
      expect(service).toBeDefined();
    });

    it("reports that it is not distributed", () => {
      expect(service.isDistributed()).toBe(false);
    });

    describe("revoke", () => {
      it("should revoke a token by jti", async () => {
        const futureMs = Date.now() + 3600000;
        await service.revoke("jti-1", futureMs);
        expect(await service.isRevoked("jti-1")).toBe(true);
      });
    });

    describe("isRevoked", () => {
      it("should return false for an unknown jti", async () => {
        expect(await service.isRevoked("unknown-jti")).toBe(false);
      });

      it("should return true for a revoked jti", async () => {
        await service.revoke("jti-2", Date.now() + 3600000);
        expect(await service.isRevoked("jti-2")).toBe(true);
      });

      it("should return false for an expired revoke entry", async () => {
        await service.revoke("jti-expired", Date.now() - 1000);
        expect(await service.isRevoked("jti-expired")).toBe(false);
      });
    });
  });

  describe("Redis-backed", () => {
    function makeClient(overrides: Partial<RedisLikeClient> = {}): RedisLikeClient {
      const store = new Map<string, number>();
      return {
        set: jest.fn(async (key: string, _value: string, _mode: "EX", ttl: number) => {
          store.set(key, Date.now() + ttl * 1000);
          return "OK";
        }),
        exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
        ...overrides,
      } as RedisLikeClient;
    }

    it("uses Redis for the revocation set when a client is provided", async () => {
      const client = makeClient();
      const service = new TokenBlacklistService(client);

      expect(service.isDistributed()).toBe(true);

      await service.revoke("jti-redis", Date.now() + 3600000);
      expect(client.set).toHaveBeenCalledWith(
        "token-blacklist:jti-redis",
        "1",
        "EX",
        expect.any(Number),
      );
      expect(await service.isRevoked("jti-redis")).toBe(true);
      expect(client.exists).toHaveBeenCalledWith("token-blacklist:jti-redis");

      await service.onModuleDestroy();
    });

    it("passes a TTL that matches the remaining token lifetime", async () => {
      const client = makeClient();
      const service = new TokenBlacklistService(client);

      await service.revoke("jti-ttl", Date.now() + 120_000);

      const call = (client.set as jest.Mock).mock.calls[0];
      const ttl = call[3] as number;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);

      await service.onModuleDestroy();
    });

    it("never writes a zero or negative TTL", async () => {
      const client = makeClient();
      const service = new TokenBlacklistService(client);

      // A token that has already expired: Redis rejects a non-positive EX.
      await service.revoke("jti-past", Date.now() - 5000);

      const ttl = (client.set as jest.Mock).mock.calls[0][3] as number;
      expect(ttl).toBeGreaterThanOrEqual(1);

      await service.onModuleDestroy();
    });

    // Fail-closed: a Redis outage must not make a revoked token look valid.
    it("falls back to local state when Redis throws on revoke", async () => {
      const client = makeClient({
        set: jest.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      });
      const service = new TokenBlacklistService(client);

      await service.revoke("jti-outage", Date.now() + 3600000);

      // The local map recorded it, so the token is still treated as revoked
      // in this process even though Redis did not get the write.
      client.set = jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      expect(await service.isRevoked("jti-outage")).toBe(true);

      await service.onModuleDestroy();
    });

    it("falls back to local state when Redis throws on lookup", async () => {
      const client = makeClient({
        exists: jest.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      });
      const service = new TokenBlacklistService(client);

      // No local entry, Redis unreachable: the safe answer is "not known to
      // be revoked locally", which the caller treats as a lookup failure.
      expect(await service.isRevoked("jti-unknown")).toBe(false);

      await service.onModuleDestroy();
    });
  });
});

/**
 * Issue #369: per-subject session cutoff for stale-session handling.
 */
describe("TokenBlacklistService session cutoff", () => {
  function makeCutoffClient(overrides: Partial<RedisLikeClient> = {}) {
    const store = new Map<string, string>();
    return {
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
      exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      ...overrides,
    } as RedisLikeClient;
  }

  it("treats every session as fresh when no cutoff exists", async () => {
    const service = new TokenBlacklistService();
    expect(await service.isSessionStale("user-1", 100)).toBe(false);
    await service.onModuleDestroy();
  });

  it("marks sessions issued at or before the cutoff stale and later ones fresh", async () => {
    const service = new TokenBlacklistService();
    await service.revokeSubjectSessions("user-1", 1000);

    expect(await service.isSessionStale("user-1", 999)).toBe(true);
    expect(await service.isSessionStale("user-1", 1000)).toBe(true);
    expect(await service.isSessionStale("user-1", 1001)).toBe(false);
    // Another subject is unaffected.
    expect(await service.isSessionStale("user-2", 500)).toBe(false);
    await service.onModuleDestroy();
  });

  it("treats a token without iat as stale once a cutoff exists", async () => {
    const service = new TokenBlacklistService();
    await service.revokeSubjectSessions("user-1", 1000);
    expect(await service.isSessionStale("user-1", undefined)).toBe(true);
    await service.onModuleDestroy();
  });

  it("only moves the cutoff forward when a revocation is retried out of order", async () => {
    const service = new TokenBlacklistService();
    await service.revokeSubjectSessions("user-1", 2000);
    await service.revokeSubjectSessions("user-1", 1000);

    expect(await service.isSessionStale("user-1", 1500)).toBe(true);
    expect(await service.isSessionStale("user-1", 2001)).toBe(false);
    await service.onModuleDestroy();
  });

  it("shares the cutoff through Redis with a bounded TTL", async () => {
    const client = makeCutoffClient();
    const writer = new TokenBlacklistService(client);
    const reader = new TokenBlacklistService(client);

    await writer.revokeSubjectSessions("user-1", 1000);

    expect(client.set).toHaveBeenCalledWith(
      "token-cutoff:user-1",
      "1000",
      "EX",
      SESSION_CUTOFF_TTL_SECONDS,
    );
    expect(await reader.isSessionStale("user-1", 900)).toBe(true);
    expect(await reader.isSessionStale("user-1", 1100)).toBe(false);

    await writer.onModuleDestroy();
    await reader.onModuleDestroy();
  });

  it("keeps the cutoff locally when Redis fails on write", async () => {
    const client = makeCutoffClient({
      set: jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    const service = new TokenBlacklistService(client);

    await service.revokeSubjectSessions("user-1", 1000);

    expect(await service.isSessionStale("user-1", 900)).toBe(true);
    await service.onModuleDestroy();
  });

  it("uses local state when Redis fails on lookup", async () => {
    const client = makeCutoffClient({
      get: jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    const service = new TokenBlacklistService(client);

    // No cutoff was ever recorded, so an unreachable Redis does not invent one.
    expect(await service.isSessionStale("user-1", 900)).toBe(false);
    await service.onModuleDestroy();
  });
});

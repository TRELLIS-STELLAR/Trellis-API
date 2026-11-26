import { ForbiddenException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Role } from "../common/guard/roles.enum";
import { RefreshTokenRotationService } from "../core/auth/refresh-token-rotation.service";
import {
  InMemoryRevocationHub,
  RevocationBus,
  RevocationEvent,
  TokenFamilyInvalidations,
  isValidEvent,
} from "./revocation-bus";

const admin = { id: "admin-1", roles: [Role.ADMIN] };
const service = { id: "svc-1", roles: [Role.SERVICE_ACTOR] };
const user = { id: "u-1", roles: [Role.USER] };

interface Node {
  bus: RevocationBus;
  invalidations: TokenFamilyInvalidations;
}

/** Build one replica sharing a broadcast hub. */
function makeNode(
  name: string,
  hub: InMemoryRevocationHub,
  options: {
    now?: () => number;
    ttlMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Node {
  const invalidations = new TokenFamilyInvalidations({
    now: options.now,
    ttlMs: options.ttlMs,
  });
  const bus = new RevocationBus({
    node: name,
    transport: hub,
    invalidations,
    retryDelayMs: 10,
    sleep: options.sleep ?? (async () => undefined),
    now: options.now,
  });
  return { bus, invalidations };
}

describe("RevocationBus token family invalidation (#526)", () => {
  let hub: InMemoryRevocationHub;
  let a: Node;
  let b: Node;

  beforeEach(() => {
    hub = new InMemoryRevocationHub();
    a = makeNode("replica-a", hub);
    b = makeNode("replica-b", hub);
  });

  afterEach(() => {
    a.bus.close();
    b.bus.close();
  });

  describe("normal path", () => {
    it("invalidates the family on every replica from one revocation", async () => {
      const result = await a.bus.revokeFamily(admin, "fam-1", "reuse detected");

      expect(result).toMatchObject({
        localInvalidated: true,
        broadcast: true,
        attempts: 1,
      });
      expect(a.invalidations.isInvalidated("fam-1")).toBe(true);
      expect(b.invalidations.isInvalidated("fam-1")).toBe(true);
      expect(b.invalidations.get("fam-1")).toMatchObject({
        reason: "reuse detected",
        eventId: result.eventId,
      });
    });

    it("leaves unrelated families valid", async () => {
      await a.bus.revokeFamily(admin, "fam-1", "logout");
      expect(b.invalidations.isInvalidated("fam-2")).toBe(false);
    });

    it("lets a SERVICE_ACTOR initiate a revocation", async () => {
      const result = await a.bus.revokeFamily(
        service,
        "fam-svc",
        "refresh reuse",
      );
      expect(result.broadcast).toBe(true);
      expect(b.invalidations.isInvalidated("fam-svc")).toBe(true);
    });
  });

  describe("failure and retry paths", () => {
    it("retries a transient publish failure with backoff, then delivers", async () => {
      const sleeps: number[] = [];
      const hubWithFaults = new InMemoryRevocationHub();
      const node = makeNode("replica-c", hubWithFaults, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      const peer = makeNode("replica-d", hubWithFaults);
      hubWithFaults.failNextPublishes = 2;

      const result = await node.bus.revokeFamily(admin, "fam-r", "retry me");

      expect(result).toMatchObject({ broadcast: true, attempts: 3 });
      expect(sleeps).toEqual([10, 20]);
      expect(peer.invalidations.isInvalidated("fam-r")).toBe(true);
      expect(node.bus.pendingBroadcasts()).toBe(0);
      node.bus.close();
      peer.bus.close();
    });

    it("applies locally even when every publish fails, and parks the event in the outbox", async () => {
      hub.failNextPublishes = 99;

      const result = await a.bus.revokeFamily(admin, "fam-x", "partition");

      expect(result).toMatchObject({
        localInvalidated: true,
        broadcast: false,
        attempts: 3,
      });
      expect(a.invalidations.isInvalidated("fam-x")).toBe(true);
      // The other replica has not heard about it yet: the documented partition window.
      expect(b.invalidations.isInvalidated("fam-x")).toBe(false);
      expect(a.bus.pendingBroadcasts()).toBe(1);
    });

    it("flushOutbox delivers a parked event once the transport recovers", async () => {
      hub.failNextPublishes = 99;
      await a.bus.revokeFamily(admin, "fam-y", "partition");
      hub.failNextPublishes = 0;

      const delivered = await a.bus.flushOutbox();

      expect(delivered).toBe(1);
      expect(b.invalidations.isInvalidated("fam-y")).toBe(true);
      expect(a.bus.pendingBroadcasts()).toBe(0);
    });

    it("keeps a failed event in the outbox when a flush also fails", async () => {
      hub.failNextPublishes = 99;
      await a.bus.revokeFamily(admin, "fam-z", "partition");

      const delivered = await a.bus.flushOutbox();

      expect(delivered).toBe(0);
      expect(a.bus.pendingBroadcasts()).toBe(1);
    });
  });

  describe("idempotency", () => {
    it("ignores a redelivered event id, so retries cannot re-apply a revocation", () => {
      const event: RevocationEvent = {
        id: randomUUID(),
        kind: "token-family",
        target: "fam-dup",
        reason: "first",
        issuedAt: Date.now(),
        origin: "replica-z",
      };

      expect(b.bus.receive(event)).toBe(true);
      expect(b.bus.receive({ ...event, reason: "tampered later" })).toBe(false);
      // The original audit record is kept, not overwritten by the duplicate.
      expect(b.invalidations.get("fam-dup")?.reason).toBe("first");
    });

    it("the origin does not double-apply its own event after publishing it", async () => {
      const result = await a.bus.revokeFamily(admin, "fam-self", "self");
      expect(a.invalidations.get("fam-self")?.eventId).toBe(result.eventId);
      expect(
        a.bus.receive({
          id: result.eventId,
          kind: "token-family",
          target: "fam-self",
          reason: "replay",
          issuedAt: Date.now(),
          origin: "replica-a",
        }),
      ).toBe(false);
    });

    it("drops a malformed event without invalidating anything", () => {
      expect(
        a.bus.receive({
          id: "",
          kind: "token-family",
          target: "x",
          reason: "r",
          issuedAt: 1,
          origin: "o",
        } as RevocationEvent),
      ).toBe(false);
      expect(
        a.bus.receive({
          id: "e",
          kind: "unknown",
          target: "x",
          reason: "r",
          issuedAt: 1,
          origin: "o",
        } as unknown as RevocationEvent),
      ).toBe(false);
      expect(a.invalidations.isInvalidated("x")).toBe(false);
      expect(isValidEvent(null)).toBe(false);
    });
  });

  describe("authorization path", () => {
    it("refuses a USER before any local or broadcast change", async () => {
      const publish = jest.spyOn(hub, "publish");

      await expect(
        a.bus.revokeFamily(user, "fam-u", "nope"),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(a.invalidations.isInvalidated("fam-u")).toBe(false);
      expect(b.invalidations.isInvalidated("fam-u")).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    it("rejects an empty or padded family id before publishing", async () => {
      const publish = jest.spyOn(hub, "publish");
      await expect(a.bus.revokeFamily(admin, "", "r")).rejects.toThrow(
        /family id/,
      );
      await expect(a.bus.revokeFamily(admin, " fam ", "r")).rejects.toThrow(
        /family id/,
      );
      expect(publish).not.toHaveBeenCalled();
    });

    it("rejects an empty or oversized reason", async () => {
      await expect(a.bus.revokeFamily(admin, "fam", "")).rejects.toThrow(
        /reason/,
      );
      await expect(
        a.bus.revokeFamily(admin, "fam", "x".repeat(201)),
      ).rejects.toThrow(/reason/);
    });
  });

  describe("expiry", () => {
    it("forgets an invalidation once its TTL has passed", () => {
      let clock = 1_000;
      const invalidations = new TokenFamilyInvalidations({
        ttlMs: 500,
        now: () => clock,
      });
      invalidations.invalidate({
        familyId: "fam-ttl",
        reason: "r",
        invalidatedAt: clock,
        eventId: "e1",
      });

      expect(invalidations.isInvalidated("fam-ttl")).toBe(true);
      clock += 501;
      expect(invalidations.isInvalidated("fam-ttl")).toBe(false);
    });
  });
});

describe("refresh-token rotation honours broadcast invalidations (#526)", () => {
  type Row = {
    id: string;
    token: string;
    familyId: string;
    userId: string;
    revoked: boolean;
    expiresAt: Date;
    revokedAt?: Date;
    replacedByToken?: string;
  };

  function fakeRepository(seed: Row[]) {
    const rows = new Map(seed.map((r) => [r.token, { ...r }]));
    return {
      rows,
      repo: {
        findOne: async ({ where }: { where: { token: string } }) =>
          rows.get(where.token) ?? null,
        create: (data: Partial<Row>) => ({ id: randomUUID(), ...data }),
        save: async (value: Row | Row[]) => {
          for (const row of Array.isArray(value) ? value : [value]) {
            rows.set(row.token, { ...row });
          }
          return value;
        },
        find: async ({
          where,
        }: {
          where: { familyId: string; revoked: boolean };
        }) =>
          [...rows.values()].filter(
            (r) => r.familyId === where.familyId && r.revoked === where.revoked,
          ),
      },
    };
  }

  const future = () => new Date(Date.now() + 60 * 60 * 1000);
  const row = (token: string, familyId: string): Row => ({
    id: `id-${token}`,
    token,
    familyId,
    userId: "u-1",
    revoked: false,
    expiresAt: future(),
  });

  it("refuses a token whose family was invalidated elsewhere, and revokes it locally", async () => {
    const invalidations = new TokenFamilyInvalidations();
    invalidations.invalidate({
      familyId: "fam-broadcast",
      reason: "logout everywhere",
      invalidatedAt: Date.now(),
      eventId: "e",
    });
    const { repo, rows } = fakeRepository([row("t-1", "fam-broadcast")]);
    const service = new RefreshTokenRotationService(
      repo as never,
      undefined,
      invalidations,
    );

    const outcome = await service.rotate("t-1");

    expect(outcome.kind).toBe("reused");
    expect(rows.get("t-1")?.revoked).toBe(true);
  });

  it("still rotates a token whose family was not invalidated", async () => {
    const invalidations = new TokenFamilyInvalidations();
    invalidations.invalidate({
      familyId: "some-other-family",
      reason: "r",
      invalidatedAt: Date.now(),
      eventId: "e",
    });
    const { repo } = fakeRepository([row("t-2", "fam-ok")]);
    const service = new RefreshTokenRotationService(
      repo as never,
      undefined,
      invalidations,
    );

    const outcome = await service.rotate("t-2");
    expect(outcome.kind).toBe("rotated");
  });

  it("keeps existing behaviour when no bus is wired", async () => {
    const { repo } = fakeRepository([row("t-3", "fam-plain")]);
    const service = new RefreshTokenRotationService(repo as never);
    const outcome = await service.rotate("t-3");
    expect(outcome.kind).toBe("rotated");
  });
});

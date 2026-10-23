import { NotFoundException } from "@nestjs/common";
import { TamperEvidentLedger } from "../domain-event-schema";
import {
  arraySource,
  EventReplayEngine,
  hashState,
  InMemoryCheckpointStore,
  InMemoryProjectionStore,
  ProjectionDefinition,
  ReplayAbortedError,
  ReplayInProgressError,
  StoredEvent,
} from "./event-replay";
import {
  DEFAULT_UPCASTERS,
  EventUpcasterRegistry,
  UpcastError,
} from "./event-upcaster";
import {
  userDirectoryProjection,
  UserDirectoryState,
} from "./projections/user-directory.projection";
import { ProjectionReplayService } from "./projection-replay.service";
import { ProjectionReplayController } from "./projection-replay.controller";
import { ROLES_KEY } from "../../guard/roles.decorator";
import { Role } from "../../guard/roles.enum";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { JwtAuthGuard } from "../../../core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "../../../core/auth/guards/admin-two-factor.guard";
import { RolesGuard } from "../../guard/roles.guard";

/** Versioned event replay for rebuilding projections (#278). */

let seq = 0;
function userCreated(
  userId: string,
  options: {
    version?: "1.0" | "2.0";
    kycTier?: string;
    sequence?: number;
  } = {},
): StoredEvent {
  const version = options.version ?? "2.0";
  const sequence = options.sequence ?? ++seq;
  return {
    sequence,
    eventId: `evt-${sequence}`,
    eventName: "user.created",
    schemaVersion: version,
    timestamp: new Date(2026, 0, 1, 0, 0, sequence).toISOString(),
    producer: "core-user",
    payload: {
      userId,
      email: `${userId}@example.com`,
      role: "USER",
      ...(version === "2.0" ? { kycTier: options.kycTier ?? "basic" } : {}),
    },
  };
}

function other(sequence: number): StoredEvent {
  return {
    sequence,
    eventId: `evt-${sequence}`,
    eventName: "payment.completed",
    schemaVersion: "1.0",
    timestamp: new Date().toISOString(),
    producer: "payments",
    payload: { transactionId: "tx", amount: 1, currency: "XLM" },
  };
}

function engine() {
  const upcasters = new EventUpcasterRegistry();
  DEFAULT_UPCASTERS.forEach((u) => upcasters.register(u));
  const checkpoints = new InMemoryCheckpointStore();
  const store = new InMemoryProjectionStore();
  return {
    engine: new EventReplayEngine(checkpoints, store, upcasters),
    checkpoints,
    store,
    upcasters,
  };
}

beforeEach(() => {
  seq = 0;
});

describe("EventUpcasterRegistry", () => {
  it("upcasts user.created v1.0 to v2.0 and validates against the v2.0 schema", () => {
    const { upcasters } = engine();
    const v1 = userCreated("u1", { version: "1.0" });
    const { event, path } = upcasters.upcast(v1, "2.0");
    expect(path).toEqual(["1.0", "2.0"]);
    expect(event.schemaVersion).toBe("2.0");
    expect(event.payload).toMatchObject({
      userId: "u1",
      kycTier: "unverified",
    });
    // The stored event is untouched.
    expect(v1.schemaVersion).toBe("1.0");
    expect((v1.payload as any).kycTier).toBeUndefined();
  });

  it("refuses missing paths, duplicate steps and cycles", () => {
    const upcasters = new EventUpcasterRegistry();
    expect(() =>
      upcasters.upcast(userCreated("u1", { version: "1.0" }), "2.0"),
    ).toThrow(UpcastError);

    upcasters.register({
      eventName: "x",
      fromVersion: "1.0",
      toVersion: "2.0",
      upcast: (p) => p,
    });
    expect(() =>
      upcasters.register({
        eventName: "x",
        fromVersion: "1.0",
        toVersion: "3.0",
        upcast: (p) => p,
      }),
    ).toThrow(/Duplicate/);
    upcasters.register({
      eventName: "x",
      fromVersion: "2.0",
      toVersion: "1.0",
      upcast: (p) => p,
    });
    expect(() =>
      upcasters.upcast(
        { ...other(1), eventName: "x", schemaVersion: "1.0" },
        "9.0",
      ),
    ).toThrow(/cycle/);
  });

  it("rejects an upcaster that produces an invalid target payload", () => {
    const upcasters = new EventUpcasterRegistry().register({
      eventName: "user.created",
      fromVersion: "1.0",
      toVersion: "2.0",
      upcast: (p) => p, // forgets kycTier
    });
    expect(() =>
      upcasters.upcast(userCreated("u1", { version: "1.0" }), "2.0"),
    ).toThrow(/kycTier/);
  });
});

describe("EventReplayEngine", () => {
  it("rebuilds a projection across schema versions and publishes it", async () => {
    const { engine: replay, store } = engine();
    const events = [
      userCreated("u1", { version: "1.0" }),
      other(2),
      userCreated("u2", { sequence: 3, kycTier: "full" }),
    ];

    const report = await replay.rebuild(
      userDirectoryProjection,
      arraySource(events),
    );

    expect(report).toMatchObject({
      outcome: "published",
      version: 1,
      eventsRead: 3,
      applied: 2,
      ignored: 1,
      upcasts: { "user.created 1.0->2.0": 1 },
      poisonEvents: [],
      lastSequence: 3,
    });
    const active = await store.getActive("user-directory");
    expect(active?.state).toEqual({
      users: {
        u1: { role: "USER", kycTier: "unverified" },
        u2: { role: "USER", kycTier: "full" },
      },
      countsByTier: { unverified: 1, full: 1 },
    });
    expect(JSON.stringify(active?.state)).not.toContain("@example.com");
    expect(active?.stateHash).toBe(report.stateHash);
  });

  it("is deterministic: the same stream yields the same state hash", async () => {
    const events = [
      userCreated("u1"),
      userCreated("u2"),
      userCreated("u3", { version: "1.0" }),
    ];
    const first = await engine().engine.rebuild(
      userDirectoryProjection,
      arraySource(events),
    );
    const second = await engine().engine.rebuild(
      userDirectoryProjection,
      arraySource(events),
    );
    expect(first.stateHash).toBe(second.stateHash);
    // Key order does not affect the hash.
    expect(hashState({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashState({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("dry-run reports without publishing or checkpointing", async () => {
    const { engine: replay, store, checkpoints } = engine();
    const report = await replay.rebuild(
      userDirectoryProjection,
      arraySource([userCreated("u1")]),
      {
        dryRun: true,
        checkpointEvery: 1,
      },
    );
    expect(report.outcome).toBe("dry-run");
    expect(await store.getActive("user-directory")).toBeNull();
    expect(checkpoints.checkpoints.size).toBe(0);
  });

  it("halts on a poison event without publishing, keeping the prior checkpoint", async () => {
    const { engine: replay, store, checkpoints } = engine();
    const first = userCreated("u1");
    const bad = { ...userCreated("u2"), payload: { userId: "u2" } }; // missing required fields
    const events = [first, bad, userCreated("u3")];

    const report = await replay.rebuild(
      userDirectoryProjection,
      arraySource(events),
      { checkpointEvery: 1 },
    );

    expect(report.outcome).toBe("halted");
    expect(report.poisonEvents).toEqual([
      expect.objectContaining({
        sequence: 2,
        eventName: "user.created",
        reason: expect.stringMatching(/email/),
      }),
    ]);
    expect(await store.getActive("user-directory")).toBeNull();
    expect((await checkpoints.load("user-directory", 1))?.sequence).toBe(1);
  });

  it("skips and records poison events when asked to", async () => {
    const { engine: replay, store } = engine();
    const first = userCreated("u1");
    const unknownVersion = { ...userCreated("u2"), schemaVersion: "7.0" };
    const events = [first, unknownVersion, userCreated("u3")];

    const report = await replay.rebuild(
      userDirectoryProjection,
      arraySource(events),
      { onPoisonEvent: "skip" },
    );

    expect(report.outcome).toBe("published");
    expect(report.applied).toBe(2);
    expect(report.poisonEvents.map((p) => p.sequence)).toEqual([2]);
    const state = (await store.getActive("user-directory"))!
      .state as UserDirectoryState;
    expect(Object.keys(state.users).sort()).toEqual(["u1", "u3"]);
  });

  it("resumes from the last checkpoint after a crash", async () => {
    const { engine: replay, checkpoints, store } = engine();
    const events = [
      userCreated("u1"),
      userCreated("u2"),
      userCreated("u3"),
      userCreated("u4"),
    ];

    // First run crashes while reading event 3 (e.g. the source connection drops).
    const crashing = function* () {
      yield events[0];
      yield events[1];
      throw new Error("source connection reset");
    };
    await expect(
      replay.rebuild(userDirectoryProjection, crashing, { checkpointEvery: 1 }),
    ).rejects.toThrow(/connection reset/);
    expect((await checkpoints.load("user-directory", 1))?.sequence).toBe(2);

    const reads: number[] = [];
    const resumed = await replay.rebuild(userDirectoryProjection, (after) => {
      reads.push(after);
      return arraySource(events)(after);
    });

    expect(reads).toEqual([2]);
    expect(resumed).toMatchObject({
      outcome: "published",
      resumedFromSequence: 2,
      applied: 2,
      lastSequence: 4,
    });
    const state = (await store.getActive("user-directory"))!
      .state as UserDirectoryState;
    expect(Object.keys(state.users).sort()).toEqual(["u1", "u2", "u3", "u4"]);
    // Checkpoints are cleared once the version is published.
    expect(await checkpoints.load("user-directory", 1)).toBeNull();
  });

  it("tolerates redelivered events but aborts on a sequence regression", async () => {
    const { engine: replay } = engine();
    const a = userCreated("u1");
    const b = userCreated("u2");
    const dup = await replay.rebuild(
      userDirectoryProjection,
      arraySource([a, b, b]),
    );
    expect(dup).toMatchObject({ duplicates: 1, applied: 2 });

    const c = userCreated("u3");
    await expect(
      engine().engine.rebuild(userDirectoryProjection, arraySource([a, c, b])),
    ).rejects.toBeInstanceOf(ReplayAbortedError);
  });

  it("retries a transient apply failure with a clean state each attempt", async () => {
    const { engine: replay, store } = engine();
    let failures = 1;
    const flaky: ProjectionDefinition<{ ids: string[] }> = {
      name: "flaky",
      version: 1,
      handles: { "user.created": "2.0" },
      initialState: () => ({ ids: [] }),
      apply(state, event) {
        state.ids.push((event.payload as any).userId); // mutates before throwing
        if (failures-- > 0) throw new Error("transient");
        return state;
      },
    };
    const report = await replay.rebuild(
      flaky,
      arraySource([userCreated("u1")]),
    );
    expect(report.outcome).toBe("published");
    expect((await store.getActive("flaky"))!.state).toEqual({ ids: ["u1"] });
  });

  it("verifies TamperEvidentLedger chains and rejects tampered exports", async () => {
    const ledger = new TamperEvidentLedger();
    ledger.append({
      eventName: "user.created",
      schemaVersion: "1.0",
      producer: "core",
      payload: { userId: "u1", email: "a@b.c", role: "USER" },
    });
    ledger.append({
      eventName: "user.created",
      schemaVersion: "2.0",
      producer: "core",
      payload: { userId: "u2", email: "d@e.f", role: "USER", kycTier: "full" },
    });
    const entries = ledger.export().entries as unknown as StoredEvent[];

    const ok = await engine().engine.rebuild(
      userDirectoryProjection,
      arraySource(entries),
    );
    expect(ok).toMatchObject({ outcome: "published", applied: 2 });

    const tampered = entries.map((e) => ({ ...e, payload: { ...e.payload } }));
    (tampered[1].payload as any).role = "ADMIN";
    await expect(
      engine().engine.rebuild(userDirectoryProjection, arraySource(tampered)),
    ).rejects.toThrow(/hash mismatch/);
  });

  it("publishes versions blue/green and rolls back to the previous one", async () => {
    const { engine: replay, store } = engine();
    await replay.rebuild(
      userDirectoryProjection,
      arraySource([userCreated("u1")]),
    );
    const v2 = { ...userDirectoryProjection, version: 2 };
    await replay.rebuild(
      v2,
      arraySource([
        userCreated("u1", { sequence: 1 }),
        userCreated("u2", { sequence: 2 }),
      ]),
    );
    expect((await store.getActive("user-directory"))!.version).toBe(2);

    const restored = await replay.rollback("user-directory");
    expect(restored!.version).toBe(1);
    expect((await store.getActive("user-directory"))!.version).toBe(1);
    expect(await replay.rollback("user-directory")).toBeNull();
  });

  it("refuses concurrent rebuilds of the same projection", async () => {
    const { engine: replay } = engine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = async function* () {
      await gate;
      yield userCreated("u1");
    };
    const first = replay.rebuild(userDirectoryProjection, slow);
    await expect(
      replay.rebuild(userDirectoryProjection, arraySource([])),
    ).rejects.toBeInstanceOf(ReplayInProgressError);
    release();
    await expect(first).resolves.toMatchObject({ outcome: "published" });
    expect(replay.isRunning("user-directory")).toBe(false);
  });
});

describe("ProjectionReplayService and controller", () => {
  it("lists registered projections with staleness, rebuilds and rolls back", async () => {
    const service = new ProjectionReplayService();
    service.register(
      userDirectoryProjection,
      arraySource([userCreated("u1", { version: "1.0" })]),
    );
    expect(() =>
      service.register(userDirectoryProjection, arraySource([])),
    ).toThrow(/already registered/);

    expect(await service.list()).toEqual([
      expect.objectContaining({
        name: "user-directory",
        version: 1,
        activeVersion: null,
        stale: true,
      }),
    ]);
    await service.rebuild("user-directory");
    expect((await service.status("user-directory")).stale).toBe(false);
    expect(() => service.rebuild("nope")).toThrow(NotFoundException);
  });

  it("is restricted to ADMIN with JWT, role and 2FA guards", () => {
    expect(Reflect.getMetadata(ROLES_KEY, ProjectionReplayController)).toEqual([
      Role.ADMIN,
    ]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ProjectionReplayController),
    ).toEqual([JwtAuthGuard, RolesGuard, AdminTwoFactorGuard]);
  });

  it("maps a concurrent rebuild to 409 and a missing rollback target to 409", async () => {
    const service = new ProjectionReplayService();
    service.register(userDirectoryProjection, arraySource([]));
    const controller = new ProjectionReplayController(service);

    jest
      .spyOn(service, "rebuild")
      .mockRejectedValueOnce(new ReplayInProgressError("user-directory"));
    await expect(
      controller.rebuild({ name: "user-directory" }, {}),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      controller.rollback({ name: "user-directory" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

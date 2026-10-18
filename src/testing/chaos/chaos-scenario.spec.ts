/**
 * Self-tests for the chaos scenario orchestrator.
 *
 * These tests prove that the orchestrator primitives behave correctly in
 * isolation before any production code is wired to them. A bug here would make
 * every downstream chaos test meaningless.
 *
 * Issue: #207
 */

import {
  ChaosScenario,
  ProcessKillError,
  ProcessKillPoint,
  SimulatedRestart,
  StaleReadInjector,
} from "./chaos-scenario";
import {
  FaultController,
  FaultyRepository,
  ManualClock,
} from "../fault-injection/fault-injection";

// ---------------------------------------------------------------------------
// SimulatedRestart
// ---------------------------------------------------------------------------

describe("SimulatedRestart", () => {
  it("starts with zero restarts and an empty ephemeral state", () => {
    const sim = new SimulatedRestart();

    expect(sim.restartCount).toBe(0);
    expect(sim.ephemeralState.size).toBe(0);
  });

  it("increments restartCount on each restart", () => {
    const sim = new SimulatedRestart();
    sim.restart();
    sim.restart();

    expect(sim.restartCount).toBe(2);
  });

  it("clears ephemeral state on restart but leaves external state intact", () => {
    const sim = new SimulatedRestart();
    const durable: string[] = [];

    sim.set("in-flight-job", { id: "job-1" });
    durable.push("row-1"); // external durable state (e.g. a DB row)

    sim.restart();

    expect(sim.has("in-flight-job")).toBe(false);
    expect(durable).toHaveLength(1); // durable state is never touched
  });

  it("runs the onRestart callback after clearing state", () => {
    const sim = new SimulatedRestart();
    const events: string[] = [];

    sim.set("key", "value");
    sim.restart(() => {
      // state should already be cleared when callback runs
      events.push(sim.has("key") ? "still-there" : "cleared");
    });

    expect(events).toEqual(["cleared"]);
  });

  it("get returns undefined for a key that survived a restart", () => {
    const sim = new SimulatedRestart();
    sim.set("counter", 5);
    sim.restart();

    expect(sim.get("counter")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// StaleReadInjector
// ---------------------------------------------------------------------------

describe("StaleReadInjector", () => {
  function makeRepo<T extends { id?: string; status?: string }>(
    rows: T[] = [],
  ) {
    const ctrl = new FaultController("db");
    const repo = new FaultyRepository<T>(ctrl);
    for (const row of rows) repo.rows.push(row);
    return { repo, ctrl };
  }

  it("returns the live row when no stale snapshot is armed", async () => {
    const { repo } = makeRepo([{ id: "1", status: "active" }]);
    const injector = new StaleReadInjector(repo);

    const row = await injector.findOne({ where: { id: "1" } as any });

    expect(row?.status).toBe("active");
  });

  it("returns the stale snapshot on the configured call number", async () => {
    const { repo } = makeRepo([{ id: "1", status: "active" }]);
    const injector = new StaleReadInjector(repo);

    injector.armStaleRead({
      snapshot: { id: "1", status: "pending" } as any,
      onCall: 1,
    });

    const stale = await injector.findOne({ where: { id: "1" } as any });
    const live = await injector.findOne({ where: { id: "1" } as any });

    expect(stale?.status).toBe("pending");
    expect(live?.status).toBe("active");
  });

  it("fires the stale read only on the exact call number", async () => {
    const { repo } = makeRepo([{ id: "1", status: "done" }]);
    const injector = new StaleReadInjector(repo);

    injector.armStaleRead({
      snapshot: { id: "1", status: "pending" } as any,
      onCall: 2,
    });

    const first = await injector.findOne({ where: { id: "1" } as any });
    const second = await injector.findOne({ where: { id: "1" } as any });
    const third = await injector.findOne({ where: { id: "1" } as any });

    expect(first?.status).toBe("done");  // live
    expect(second?.status).toBe("pending"); // stale injection
    expect(third?.status).toBe("done");  // live again
  });

  it("reports unconsumed stale reads so a test cannot silently pass on a dead script", async () => {
    const { repo } = makeRepo([{ id: "1" }]);
    const injector = new StaleReadInjector(repo);

    injector.armStaleRead({ snapshot: { id: "1", status: "old" } as any, onCall: 5 });

    // Only one call: the onCall:5 injection never fires
    await injector.findOne({ where: { id: "1" } as any });

    expect(injector.unconsumedStaleReads()).toHaveLength(1);
  });

  it("tracks totalReads across all calls", async () => {
    const { repo } = makeRepo([{ id: "1" }]);
    const injector = new StaleReadInjector(repo);

    await injector.findOne({ where: { id: "1" } as any });
    await injector.findOne({ where: { id: "1" } as any });
    await injector.findOne({ where: { id: "1" } as any });

    expect(injector.totalReads).toBe(3);
  });

  it("delegates save and create to the underlying repository", async () => {
    const { repo } = makeRepo<{ id?: string; value: number }>();
    const injector = new StaleReadInjector(repo);

    const row = injector.create({ value: 42 });
    await injector.save(row);

    expect(injector.rows).toHaveLength(1);
    expect(injector.rows[0].value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// ProcessKillPoint
// ---------------------------------------------------------------------------

describe("ProcessKillPoint", () => {
  it("passes through when no checkpoint is armed", () => {
    const kill = new ProcessKillPoint();

    expect(() => kill.checkpoint("after-db-write")).not.toThrow();
  });

  it("throws ProcessKillError at the armed checkpoint", () => {
    const kill = new ProcessKillPoint();
    kill.armKill("after-db-write");

    expect(() => kill.checkpoint("after-db-write")).toThrow(ProcessKillError);
    // After firing once, the checkpoint is disarmed
    expect(() => kill.checkpoint("after-db-write")).not.toThrow();
  });

  it("fires only once per arming", () => {
    const kill = new ProcessKillPoint();
    kill.armKill("checkpoint");

    expect(() => kill.checkpoint("checkpoint")).toThrow(ProcessKillError);
    expect(() => kill.checkpoint("checkpoint")).not.toThrow();
  });

  it("records the checkpoint name in fired[]", () => {
    const kill = new ProcessKillPoint();
    kill.armKill("step-1");
    kill.armKill("step-2");

    try { kill.checkpoint("step-1"); } catch { /* expected */ }
    try { kill.checkpoint("step-2"); } catch { /* expected */ }

    expect(kill.fired).toEqual(["step-1", "step-2"]);
    expect(kill.hasFired("step-1")).toBe(true);
    expect(kill.hasFired("step-3")).toBe(false);
  });

  it("does not fire a different checkpoint from the one armed", () => {
    const kill = new ProcessKillPoint();
    kill.armKill("step-A");

    expect(() => kill.checkpoint("step-B")).not.toThrow();
    // step-A is still armed
    expect(() => kill.checkpoint("step-A")).toThrow(ProcessKillError);
  });

  it("disarmAll prevents all pending checkpoints from firing", () => {
    const kill = new ProcessKillPoint();
    kill.armKill("a");
    kill.armKill("b");
    kill.disarmAll();

    expect(() => kill.checkpoint("a")).not.toThrow();
    expect(() => kill.checkpoint("b")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ChaosScenario façade
// ---------------------------------------------------------------------------

describe("ChaosScenario", () => {
  it("lazily creates a fault controller for each named collaborator", () => {
    const scenario = new ChaosScenario();

    const dbCtrl = scenario.controller("db");
    const httpCtrl = scenario.controller("http");

    expect(dbCtrl).toBeInstanceOf(FaultController);
    expect(httpCtrl).toBeInstanceOf(FaultController);
    expect(dbCtrl).not.toBe(httpCtrl);
    // Same name returns the same instance
    expect(scenario.controller("db")).toBe(dbCtrl);
  });

  it("creates a repository wired to its named controller", async () => {
    const scenario = new ChaosScenario();
    scenario.controller("notifications").queueConstraintViolation();

    const repo = scenario.repository<{ id?: string; body: string }>(
      "notifications",
    );
    const row = repo.create({ body: "hello" });

    await expect(repo.save(row)).rejects.toThrow(/constraint was violated/);
  });

  it("assertClean passes when no faults are scripted and no duplicates exist", () => {
    const scenario = new ChaosScenario();
    scenario.ledger.record("email", "msg-1");

    expect(() => scenario.assertClean()).not.toThrow();
  });

  it("assertClean fails when a scripted fault was never consumed", async () => {
    const scenario = new ChaosScenario();
    scenario.controller("db").queueTimeout();
    // Never call anything on the repository — fault is dead

    expect(() => scenario.assertClean()).toThrow(
      /unconsumed fault/,
    );
  });

  it("assertClean fails when a side effect is duplicated", () => {
    const scenario = new ChaosScenario();
    scenario.ledger.record("payment", "inv-1");
    scenario.ledger.record("payment", "inv-1");

    expect(() => scenario.assertClean()).toThrow(
      /duplicated an irreversible side effect/,
    );
  });

  it("clock advances resolve sleeps without real wall-clock time", async () => {
    const scenario = new ChaosScenario();
    let resolved = false;

    const waiting = scenario.clock.sleep(5_000).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    await scenario.clock.advance(5_000);
    await waiting;

    expect(resolved).toBe(true);
  });

  it("restart clears ephemeral state and increments the counter", () => {
    const scenario = new ChaosScenario();
    scenario.restart.set("job-id", "j-1");

    scenario.restart.restart();

    expect(scenario.restart.has("job-id")).toBe(false);
    expect(scenario.restart.restartCount).toBe(1);
  });
});

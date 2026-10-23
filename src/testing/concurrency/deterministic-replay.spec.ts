import { ConflictException } from "@nestjs/common";
import { OptimisticConcurrencyService } from "../../common/concurrency/optimistic-concurrency.service";
import { Permission, Role, hasPermission } from "../../common/guard/roles.enum";
import {
  ReplayActor,
  ReplayResult,
  ReplayScenario,
  exploreInterleavings,
  replaySchedule,
  runSeeded,
  seededRandom,
} from "./deterministic-replay";

type Outcome = "applied" | "duplicate" | "denied" | "gave-up";

interface Ledger {
  balance: number;
  version: number;
  appliedKeys: Set<string>;
  outcomes: Record<string, Outcome>;
  amounts: Record<string, number>;
}

const optimistic = new OptimisticConcurrencyService();

/** Reads, then writes with a version check; retries a stale write. */
function versionedWriter(
  ledger: Ledger,
  name: string,
  amount: number,
  key: string,
  roles: Role[],
  maxRetries = 5,
): ReplayActor {
  let phase: "read" | "write" = "read";
  let snapshot = { balance: 0, version: 0 };
  let retries = 0;
  ledger.amounts[name] = amount;

  return {
    name,
    step() {
      if (phase === "read") {
        if (!hasPermission(roles, Permission.PAYMENT_CREATE)) {
          ledger.outcomes[name] = "denied";
          return true;
        }
        snapshot = { balance: ledger.balance, version: ledger.version };
        phase = "write";
        return false;
      }
      // The write step is one atomic unit, like a conditional UPDATE.
      if (ledger.appliedKeys.has(key)) {
        ledger.outcomes[name] = "duplicate";
        return true;
      }
      try {
        optimistic.assertCurrent({ version: ledger.version }, snapshot.version);
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        if (retries >= maxRetries) {
          ledger.outcomes[name] = "gave-up";
          return true;
        }
        retries += 1;
        phase = "read";
        return false;
      }
      ledger.balance = snapshot.balance + amount;
      ledger.version = optimistic.nextVersion(snapshot.version);
      ledger.appliedKeys.add(key);
      ledger.outcomes[name] = "applied";
      return true;
    },
  };
}

/** Same read-then-write but with no version check: loses updates. */
function naiveWriter(ledger: Ledger, name: string, amount: number): ReplayActor {
  let phase: "read" | "write" = "read";
  let seen = 0;
  ledger.amounts[name] = amount;
  return {
    name,
    step() {
      if (phase === "read") {
        seen = ledger.balance;
        phase = "write";
        return false;
      }
      ledger.balance = seen + amount;
      ledger.outcomes[name] = "applied";
      return true;
    },
  };
}

function scenario(
  build: (ledger: Ledger) => ReplayActor[],
): () => ReplayScenario<Ledger> {
  return () => {
    const state: Ledger = {
      balance: 0,
      version: 0,
      appliedKeys: new Set(),
      outcomes: {},
      amounts: {},
    };
    return { state, actors: build(state) };
  };
}

function appliedTotal(ledger: Ledger): number {
  return Object.entries(ledger.outcomes)
    .filter(([, outcome]) => outcome === "applied")
    .reduce((sum, [name]) => sum + ledger.amounts[name], 0);
}

describe("Deterministic replay for concurrent writes and retries (#262)", () => {
  const twoWriters = scenario((ledger) => [
    versionedWriter(ledger, "a", 10, "k-a", [Role.USER]),
    versionedWriter(ledger, "b", 5, "k-b", [Role.USER]),
  ]);

  it("replays the exact same trace to the exact same state", async () => {
    const first = await replaySchedule(twoWriters, [0, 1, 0, 1]);
    const again = await replaySchedule(twoWriters, first.trace);
    expect(again.trace).toEqual(first.trace);
    expect(again.state.balance).toBe(first.state.balance);
    expect(first.done).toEqual([true, true]);
  });

  it("a stale write is retried: interleaved readers both end up applied", async () => {
    // Both read version 0; a writes first, so b conflicts and re-reads.
    const result = await replaySchedule(twoWriters, [0, 1, 0, 1]);
    expect(result.state.balance).toBe(15);
    expect(result.state.version).toBe(2);
    expect(result.trace).toEqual([0, 1, 0, 1, 1, 1]);
  });

  it("keeps every write across ALL interleavings of two contending writers", async () => {
    let seen = 0;
    const summary = await exploreInterleavings(twoWriters, ({ state }) => {
      seen += 1;
      expect(state.balance).toBe(15);
      expect(state.version).toBe(2);
      expect(appliedTotal(state)).toBe(15);
    });
    expect(summary.truncated).toBe(false);
    expect(summary.schedules).toBe(seen);
    expect(seen).toBeGreaterThan(6);
  });

  it("applies a retried idempotency key exactly once across ALL interleavings", async () => {
    const withReplay = scenario((ledger) => [
      versionedWriter(ledger, "orig", 10, "key-1", [Role.USER]),
      versionedWriter(ledger, "retry", 10, "key-1", [Role.USER]),
      versionedWriter(ledger, "other", 5, "key-2", [Role.USER]),
    ]);

    const summary = await exploreInterleavings(withReplay, ({ state }) => {
      expect(state.balance).toBe(15);
      expect(state.version).toBe(2);
      expect([state.outcomes.orig, state.outcomes.retry].sort()).toEqual([
        "applied",
        "duplicate",
      ]);
    });
    expect(summary.truncated).toBe(false);
  });

  it("never lets an unauthorized actor write in any interleaving", async () => {
    const withIntruder = scenario((ledger) => [
      versionedWriter(ledger, "a", 10, "k-a", [Role.USER]),
      versionedWriter(ledger, "intruder", 100, "k-x", []),
      versionedWriter(ledger, "b", 5, "k-b", [Role.USER]),
    ]);

    await exploreInterleavings(withIntruder, ({ state }) => {
      expect(state.outcomes.intruder).toBe("denied");
      expect(state.appliedKeys.has("k-x")).toBe(false);
      expect(state.balance).toBe(15);
    });
  });

  it("gives up cleanly when retries are exhausted without corrupting the ledger", async () => {
    const impatient = scenario((ledger) => [
      versionedWriter(ledger, "a", 1, "k-a", [Role.USER], 0),
      versionedWriter(ledger, "b", 2, "k-b", [Role.USER], 0),
      versionedWriter(ledger, "c", 4, "k-c", [Role.USER], 0),
    ]);

    let sawGiveUp = false;
    await exploreInterleavings(impatient, ({ state }) => {
      expect(state.balance).toBe(appliedTotal(state));
      expect(state.version).toBe(
        Object.values(state.outcomes).filter((o) => o === "applied").length,
      );
      if (Object.values(state.outcomes).includes("gave-up")) sawGiveUp = true;
    });
    expect(sawGiveUp).toBe(true);
  });

  it("finds and reproduces the lost update of an unversioned writer", async () => {
    const naive = scenario((ledger) => [
      naiveWriter(ledger, "a", 10),
      naiveWriter(ledger, "b", 5),
    ]);

    const failing: ReplayResult<Ledger>[] = [];
    await exploreInterleavings(naive, (result) => {
      if (result.state.balance !== 15) failing.push(result);
    });

    expect(failing.length).toBeGreaterThan(0);
    const replayed = await replaySchedule(naive, failing[0].trace);
    expect(replayed.state.balance).toBe(failing[0].state.balance);
    expect(replayed.state.balance).not.toBe(15);
  });

  it("seeded runs are reproducible and replayable from their trace", async () => {
    const withReplay = scenario((ledger) => [
      versionedWriter(ledger, "orig", 10, "key-1", [Role.USER]),
      versionedWriter(ledger, "retry", 10, "key-1", [Role.USER]),
      versionedWriter(ledger, "other", 5, "key-2", [Role.USER]),
    ]);

    const traces = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const run = await runSeeded(withReplay, seed);
      const repeat = await runSeeded(withReplay, seed);
      expect(repeat.trace).toEqual(run.trace);

      const replayed = await replaySchedule(withReplay, run.trace);
      expect(replayed.trace).toEqual(run.trace);
      expect(replayed.state.balance).toBe(run.state.balance);

      expect(run.state.balance).toBe(15);
      traces.add(run.trace.join(","));
    }
    expect(traces.size).toBeGreaterThan(1);
  });

  it("seededRandom is stable for a given seed", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("reports truncation when the schedule budget is hit", async () => {
    const summary = await exploreInterleavings(twoWriters, () => undefined, {
      maxSchedules: 3,
    });
    expect(summary).toEqual({ schedules: 3, truncated: true });
  });

  it("fails loudly instead of hanging when an actor never finishes", async () => {
    const stuck = () => ({
      state: {},
      actors: [{ name: "spin", step: () => false }],
    });
    await expect(replaySchedule(stuck, [], 25)).rejects.toThrow(/exceeded 25 steps/);
    await expect(runSeeded(stuck, 1, 25)).rejects.toThrow(/exceeded 25 steps/);
  });

  it("rejects schedules that reference unknown actors", async () => {
    await expect(replaySchedule(twoWriters, [7])).rejects.toThrow(RangeError);
  });
});

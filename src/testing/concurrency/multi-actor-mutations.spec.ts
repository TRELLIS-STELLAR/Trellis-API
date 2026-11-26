/**
 * Deterministic replay tests for multi-actor mutations (#issue-1).
 *
 * Extends the deterministic replay framework to cover multi-actor mutation
 * scenarios including normal operations, failure paths, retry logic, and
 * authorization checks. Each scenario exercises concurrent mutations with
 * controlled interleavings to validate correctness guarantees.
 */

import { ConflictException, ForbiddenException } from "@nestjs/common";
import { OptimisticConcurrencyService } from "../../common/concurrency/optimistic-concurrency.service";
import { Permission, Role, hasPermission } from "../../common/guard/roles.enum";
import {
  ReplayActor,
  ReplayScenario,
  exploreInterleavings,
  replaySchedule,
  runSeeded,
} from "./deterministic-replay";

/** Outcome of a mutation attempt */
type MutationOutcome =
  | "success"
  | "conflict"
  | "unauthorized"
  | "retry-exhausted"
  | "validation-failed"
  | "rolled-back";

/** Shared state representing a multi-actor system */
interface MultiActorState {
  /** Primary balance or value being mutated */
  balance: number;
  /** Optimistic concurrency version */
  version: number;
  /** Applied operation IDs for idempotency */
  appliedOperations: Set<string>;
  /** Mutation outcomes by actor */
  outcomes: Record<string, MutationOutcome>;
  /** Amounts applied by each actor */
  amounts: Record<string, number>;
  /** Failure injection flags */
  failureFlags: Set<string>;
  /** Authorization violations */
  authViolations: string[];
  /** Rollback history */
  rollbackHistory: Array<{ actor: string; reason: string }>;
}

const optimistic = new OptimisticConcurrencyService();

/**
 * Creates a mutation actor with full retry and authorization logic.
 */
function createMutationActor(
  state: MultiActorState,
  name: string,
  amount: number,
  operationId: string,
  roles: Role[],
  options: {
    maxRetries?: number;
    shouldFail?: boolean;
    rollbackOnConflict?: boolean;
  } = {},
): ReplayActor {
  const { maxRetries = 3, shouldFail = false, rollbackOnConflict = false } = options;
  let phase: "auth-check" | "read" | "validate" | "write" | "rollback" = "auth-check";
  let snapshot = { balance: 0, version: 0 };
  let retries = 0;

  state.amounts[name] = amount;

  return {
    name,
    step() {
      // Phase 1: Authorization check
      if (phase === "auth-check") {
        if (!hasPermission(roles, Permission.PAYMENT_CREATE)) {
          state.outcomes[name] = "unauthorized";
          state.authViolations.push(name);
          return true;
        }
        phase = "read";
        return false;
      }

      // Phase 2: Read current state
      if (phase === "read") {
        snapshot = { balance: state.balance, version: state.version };
        phase = "validate";
        return false;
      }

      // Phase 3: Validation
      if (phase === "validate") {
        // Check for duplicate operation
        if (state.appliedOperations.has(operationId)) {
          state.outcomes[name] = "success";
          return true;
        }

        // Simulate validation failure
        if (shouldFail || state.failureFlags.has(name)) {
          state.outcomes[name] = "validation-failed";
          return true;
        }

        phase = "write";
        return false;
      }

      // Phase 4: Write with version check
      if (phase === "write") {
        try {
          optimistic.assertCurrent({ version: state.version }, snapshot.version);
        } catch (error) {
          expect(error).toBeInstanceOf(ConflictException);

          if (rollbackOnConflict) {
            state.rollbackHistory.push({
              actor: name,
              reason: "version-conflict",
            });
            phase = "rollback";
            return false;
          }

          if (retries >= maxRetries) {
            state.outcomes[name] = "retry-exhausted";
            return true;
          }

          retries += 1;
          phase = "read";
          return false;
        }

        // Apply the mutation
        state.balance = snapshot.balance + amount;
        state.version = optimistic.nextVersion(snapshot.version);
        state.appliedOperations.add(operationId);
        state.outcomes[name] = "success";
        return true;
      }

      // Phase 5: Rollback
      if (phase === "rollback") {
        state.outcomes[name] = "rolled-back";
        return true;
      }

      return true;
    },
  };
}

/**
 * Factory for creating test scenarios
 */
function createScenario(
  build: (state: MultiActorState) => ReplayActor[],
): () => ReplayScenario<MultiActorState> {
  return () => {
    const state: MultiActorState = {
      balance: 0,
      version: 0,
      appliedOperations: new Set(),
      outcomes: {},
      amounts: {},
      failureFlags: new Set(),
      authViolations: [],
      rollbackHistory: [],
    };
    return { state, actors: build(state) };
  };
}

/**
 * Calculate total successfully applied
 */
function successfulTotal(state: MultiActorState): number {
  return Object.entries(state.outcomes)
    .filter(([, outcome]) => outcome === "success")
    .reduce((sum, [name]) => sum + state.amounts[name], 0);
}

describe("Multi-actor mutation deterministic replay tests", () => {
  describe("Normal path: concurrent mutations", () => {
    it("applies all mutations correctly across all interleavings", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "actor-a", 100, "op-1", [Role.USER]),
        createMutationActor(state, "actor-b", 50, "op-2", [Role.USER]),
        createMutationActor(state, "actor-c", 25, "op-3", [Role.USER]),
      ]);

      let schedulesChecked = 0;
      const summary = await exploreInterleavings(scenario, ({ state }) => {
        schedulesChecked += 1;
        expect(state.balance).toBe(175);
        expect(successfulTotal(state)).toBe(175);
        expect(state.version).toBe(3);
        expect(Object.values(state.outcomes).every((o) => o === "success")).toBe(true);
      });

      expect(summary.truncated).toBe(false);
      expect(schedulesChecked).toBeGreaterThan(0);
    });

    it("maintains balance consistency with four concurrent actors", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "actor-1", 10, "op-1", [Role.USER]),
        createMutationActor(state, "actor-2", 20, "op-2", [Role.USER]),
        createMutationActor(state, "actor-3", 30, "op-3", [Role.USER]),
        createMutationActor(state, "actor-4", 40, "op-4", [Role.USER]),
      ]);

      await exploreInterleavings(
        scenario,
        ({ state }) => {
          expect(state.balance).toBe(100);
          expect(successfulTotal(state)).toBe(100);
          expect(state.appliedOperations.size).toBe(4);
        },
        { maxSchedules: 1000 },
      );
    });

    it("reproduces specific interleaving from trace", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "actor-a", 100, "op-1", [Role.USER]),
        createMutationActor(state, "actor-b", 50, "op-2", [Role.USER]),
      ]);

      const first = await replaySchedule(scenario, []);
      const replayed = await replaySchedule(scenario, first.trace);

      expect(replayed.trace).toEqual(first.trace);
      expect(replayed.state.balance).toBe(first.state.balance);
      expect(replayed.state.version).toBe(first.state.version);
    });
  });

  describe("Failure path: validation and rejection", () => {
    it("rejects mutations that fail validation", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "valid", 100, "op-1", [Role.USER]),
        createMutationActor(state, "invalid", 50, "op-2", [Role.USER], {
          shouldFail: true,
        }),
        createMutationActor(state, "valid-2", 25, "op-3", [Role.USER]),
      ]);

      await exploreInterleavings(scenario, ({ state }) => {
        expect(state.balance).toBe(125);
        expect(state.outcomes.invalid).toBe("validation-failed");
        expect(state.outcomes.valid).toBe("success");
        expect(state.outcomes["valid-2"]).toBe("success");
      });
    });

    it("handles multiple validation failures gracefully", async () => {
      const scenario = createScenario((state) => {
        state.failureFlags.add("fail-1");
        state.failureFlags.add("fail-2");
        return [
          createMutationActor(state, "fail-1", 100, "op-1", [Role.USER]),
          createMutationActor(state, "success", 50, "op-2", [Role.USER]),
          createMutationActor(state, "fail-2", 25, "op-3", [Role.USER]),
        ];
      });

      await exploreInterleavings(scenario, ({ state }) => {
        expect(state.balance).toBe(50);
        expect(state.outcomes["fail-1"]).toBe("validation-failed");
        expect(state.outcomes["fail-2"]).toBe("validation-failed");
        expect(state.outcomes.success).toBe("success");
      });
    });

    it("prevents state corruption on partial failures", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "actor-a", 100, "op-1", [Role.USER]),
        createMutationActor(state, "actor-fail", 999, "op-2", [Role.USER], {
          shouldFail: true,
        }),
        createMutationActor(state, "actor-b", 50, "op-3", [Role.USER]),
      ]);

      await exploreInterleavings(scenario, ({ state }) => {
        // Balance should only reflect successful operations
        expect(state.balance).toBe(successfulTotal(state));
        expect(state.balance).toBe(150);
        expect(state.appliedOperations.has("op-2")).toBe(false);
      });
    });
  });

  describe("Retry path: conflict resolution", () => {
    it("retries on version conflict until success", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "fast", 100, "op-1", [Role.USER]),
        createMutationActor(state, "slow", 50, "op-2", [Role.USER], {
          maxRetries: 5,
        }),
      ]);

      await exploreInterleavings(scenario, ({ state }) => {
        expect(state.balance).toBe(150);
        expect(state.outcomes.fast).toBe("success");
        expect(state.outcomes.slow).toBe("success");
      });
    });

    it("exhausts retries and fails gracefully", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "a", 10, "op-1", [Role.USER], { maxRetries: 0 }),
        createMutationActor(state, "b", 20, "op-2", [Role.USER], { maxRetries: 0 }),
        createMutationActor(state, "c", 30, "op-3", [Role.USER], { maxRetries: 0 }),
      ]);

      let sawExhaustion = false;
      await exploreInterleavings(scenario, ({ state }) => {
        // Balance should match successful operations only
        expect(state.balance).toBe(successfulTotal(state));
        expect(state.version).toBe(
          Object.values(state.outcomes).filter((o) => o === "success").length,
        );

        const exhausted = Object.values(state.outcomes).filter(
          (o) => o === "retry-exhausted",
        );
        if (exhausted.length > 0) sawExhaustion = true;
      });

      expect(sawExhaustion).toBe(true);
    });

    it("handles mixed retry limits correctly", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "patient", 100, "op-1", [Role.USER], {
          maxRetries: 10,
        }),
        createMutationActor(state, "impatient", 50, "op-2", [Role.USER], {
          maxRetries: 1,
        }),
        createMutationActor(state, "normal", 25, "op-3", [Role.USER], {
          maxRetries: 3,
        }),
      ]);

      await exploreInterleavings(
        scenario,
        ({ state }) => {
          // Verify no state corruption regardless of retry outcomes
          expect(state.balance).toBe(successfulTotal(state));
          expect(state.balance).toBeLessThanOrEqual(175);
        },
        { maxSchedules: 500 },
      );
    });
  });

  describe("Authorization path: permission enforcement", () => {
    it("blocks unauthorized actors in all interleavings", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "authorized", 100, "op-1", [Role.USER]),
        createMutationActor(state, "unauthorized", 999, "op-2", []),
        createMutationActor(state, "authorized-2", 50, "op-3", [Role.ADMIN]),
      ]);

      await exploreInterleavings(scenario, ({ state }) => {
        expect(state.balance).toBe(150);
        expect(state.outcomes.unauthorized).toBe("unauthorized");
        expect(state.authViolations).toContain("unauthorized");
        expect(state.appliedOperations.has("op-2")).toBe(false);
      });
    });

    it("enforces role-based access across multiple unauthorized actors", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "intruder-1", 100, "op-1", []),
        createMutationActor(state, "valid-user", 50, "op-2", [Role.USER]),
        createMutationActor(state, "intruder-2", 75, "op-3", [Role.GUEST]),
      ]);

      await exploreInterleavings(scenario, ({ state }) => {
        expect(state.balance).toBe(50);
        expect(state.outcomes["intruder-1"]).toBe("unauthorized");
        expect(state.outcomes["intruder-2"]).toBe("unauthorized");
        expect(state.outcomes["valid-user"]).toBe("success");
        expect(state.authViolations).toHaveLength(2);
      });
    });

    it("validates admin-only operations", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "user", 100, "op-1", [Role.USER]),
        createMutationActor(state, "admin", 50, "op-2", [Role.ADMIN]),
        createMutationActor(state, "operator", 25, "op-3", [Role.OPERATOR]),
      ]);

      await exploreInterleavings(scenario, ({ state }) => {
        // All have PAYMENT_CREATE permission
        expect(state.balance).toBe(175);
        expect(Object.values(state.outcomes).every((o) => o === "success")).toBe(true);
      });
    });
  });

  describe("Rollback and recovery", () => {
    it("executes rollback on conflict when configured", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "winner", 100, "op-1", [Role.USER]),
        createMutationActor(state, "rollback-candidate", 50, "op-2", [Role.USER], {
          rollbackOnConflict: true,
          maxRetries: 0,
        }),
      ]);

      let sawRollback = false;
      await exploreInterleavings(scenario, ({ state }) => {
        if (state.outcomes["rollback-candidate"] === "rolled-back") {
          sawRollback = true;
          expect(state.rollbackHistory).toContainEqual({
            actor: "rollback-candidate",
            reason: "version-conflict",
          });
        }
        expect(state.balance).toBe(successfulTotal(state));
      });

      expect(sawRollback).toBe(true);
    });

    it("maintains rollback history correctly", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "a", 10, "op-1", [Role.USER]),
        createMutationActor(state, "b", 20, "op-2", [Role.USER], {
          rollbackOnConflict: true,
        }),
        createMutationActor(state, "c", 30, "op-3", [Role.USER], {
          rollbackOnConflict: true,
        }),
      ]);

      await exploreInterleavings(
        scenario,
        ({ state }) => {
          // Verify rollback history integrity
          state.rollbackHistory.forEach((entry) => {
            expect(entry.reason).toBe("version-conflict");
            expect(state.outcomes[entry.actor]).toBe("rolled-back");
          });
        },
        { maxSchedules: 200 },
      );
    });
  });

  describe("Edge cases and idempotency", () => {
    it("applies duplicate operation IDs only once", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "original", 100, "duplicate-id", [Role.USER]),
        createMutationActor(state, "retry-1", 100, "duplicate-id", [Role.USER]),
        createMutationActor(state, "retry-2", 100, "duplicate-id", [Role.USER]),
        createMutationActor(state, "other", 50, "unique-id", [Role.USER]),
      ]);

      await exploreInterleavings(scenario, ({ state }) => {
        expect(state.balance).toBe(150);
        expect(state.appliedOperations.has("duplicate-id")).toBe(true);
        expect(state.appliedOperations.size).toBe(2);
      });
    });

    it("handles zero-amount mutations correctly", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "zero", 0, "op-1", [Role.USER]),
        createMutationActor(state, "normal", 100, "op-2", [Role.USER]),
      ]);

      await exploreInterleavings(scenario, ({ state }) => {
        expect(state.balance).toBe(100);
        expect(state.outcomes.zero).toBe("success");
        expect(state.appliedOperations.size).toBe(2);
      });
    });

    it("handles negative amounts (debits) correctly", async () => {
      const scenario = createScenario((state) => {
        state.balance = 1000; // Start with a balance
        return [
          createMutationActor(state, "debit-a", -100, "op-1", [Role.USER]),
          createMutationActor(state, "debit-b", -50, "op-2", [Role.USER]),
          createMutationActor(state, "credit", 25, "op-3", [Role.USER]),
        ];
      });

      await exploreInterleavings(scenario, ({ state }) => {
        expect(state.balance).toBe(875);
        expect(successfulTotal(state)).toBe(-125);
      });
    });
  });

  describe("Seeded runs and reproducibility", () => {
    it("produces consistent results from same seed", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "a", 100, "op-1", [Role.USER]),
        createMutationActor(state, "b", 50, "op-2", [Role.USER]),
        createMutationActor(state, "c", 25, "op-3", [Role.USER]),
      ]);

      const run1 = await runSeeded(scenario, 42);
      const run2 = await runSeeded(scenario, 42);

      expect(run1.trace).toEqual(run2.trace);
      expect(run1.state.balance).toBe(run2.state.balance);
      expect(run1.state.version).toBe(run2.state.version);
    });

    it("generates diverse interleavings from different seeds", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "a", 100, "op-1", [Role.USER]),
        createMutationActor(state, "b", 50, "op-2", [Role.USER]),
      ]);

      const traces = new Set<string>();
      for (let seed = 1; seed <= 20; seed += 1) {
        const run = await runSeeded(scenario, seed);
        traces.add(run.trace.join(","));
        expect(run.state.balance).toBe(150);
      }

      expect(traces.size).toBeGreaterThan(1);
    });
  });

  describe("Complex multi-actor scenarios", () => {
    it("handles five concurrent actors with mixed outcomes", async () => {
      const scenario = createScenario((state) => [
        createMutationActor(state, "success-1", 100, "op-1", [Role.USER]),
        createMutationActor(state, "unauthorized", 999, "op-2", []),
        createMutationActor(state, "success-2", 50, "op-3", [Role.ADMIN]),
        createMutationActor(state, "fail", 888, "op-4", [Role.USER], {
          shouldFail: true,
        }),
        createMutationActor(state, "success-3", 25, "op-5", [Role.OPERATOR]),
      ]);

      await exploreInterleavings(
        scenario,
        ({ state }) => {
          expect(state.balance).toBe(175);
          expect(state.outcomes.unauthorized).toBe("unauthorized");
          expect(state.outcomes.fail).toBe("validation-failed");
          expect(state.outcomes["success-1"]).toBe("success");
          expect(state.outcomes["success-2"]).toBe("success");
          expect(state.outcomes["success-3"]).toBe("success");
        },
        { maxSchedules: 1000 },
      );
    });

    it("validates state consistency across large mutation sets", async () => {
      const scenario = createScenario((state) => {
        const actors: ReplayActor[] = [];
        for (let i = 0; i < 6; i++) {
          actors.push(
            createMutationActor(state, `actor-${i}`, (i + 1) * 10, `op-${i}`, [
              Role.USER,
            ]),
          );
        }
        return actors;
      });

      await exploreInterleavings(
        scenario,
        ({ state }) => {
          expect(state.balance).toBe(210); // 10+20+30+40+50+60
          expect(state.appliedOperations.size).toBe(6);
          expect(Object.values(state.outcomes).every((o) => o === "success")).toBe(
            true,
          );
        },
        { maxSchedules: 500 },
      );
    });
  });
});

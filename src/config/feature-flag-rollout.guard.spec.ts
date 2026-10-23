import { ConfigService } from "@nestjs/config";
import {
  FeatureFlag,
  FeatureFlagsService,
} from "./feature-flags.service";
import {
  FeatureFlagRolloutGuard,
  GuardedRolloutAbortedError,
  RolloutRecoveryError,
} from "./feature-flag-rollout.guard";

describe("FeatureFlagRolloutGuard", () => {
  const flag = FeatureFlag.RECONCILIATION_HORIZON_POLLING;
  let flags: FeatureFlagsService;
  let guard: FeatureFlagRolloutGuard;

  beforeEach(() => {
    flags = new FeatureFlagsService({ get: jest.fn().mockReturnValue(false) } as unknown as ConfigService);
    guard = new FeatureFlagRolloutGuard();
  });

  it("returns a healthy scoped rollout and restores the configured flag afterward", async () => {
    const result = await guard.run({
      scopeId: "horizon-poll-canary",
      flag,
      execute: async () => {
        expect(flags.isEnabled(flag)).toBe(true);
        return 4;
      },
      verify: async (count) => {
        expect(flags.isEnabled(flag)).toBe(true);
        return { healthy: count === 4, details: "four records observed" };
      },
      rollback: jest.fn(),
      verifyRollback: jest.fn(),
    });

    expect(result).toEqual({
      status: "healthy",
      scopeId: "horizon-poll-canary",
      value: 4,
      health: { healthy: true, details: "four records observed" },
    });
    expect(flags.isEnabled(flag)).toBe(false);
  });

  it("rolls back an unhealthy rollout with the flag disabled and verifies recovery", async () => {
    const rollback = jest.fn(async () => {
      expect(flags.isEnabled(flag)).toBe(false);
    });
    const verifyRollback = jest.fn(async () => {
      expect(flags.isEnabled(flag)).toBe(false);
      return true;
    });

    await expect(
      guard.run({
        scopeId: "horizon-poll-canary",
        flag,
        execute: async () => "partial-result",
        verify: async () => ({ healthy: false, details: "lag exceeded threshold" }),
        rollback,
        verifyRollback,
      }),
    ).rejects.toMatchObject({
      name: GuardedRolloutAbortedError.name,
      rolledBack: true,
      scopeId: "horizon-poll-canary",
    });

    expect(rollback).toHaveBeenCalledWith(
      "partial-result",
      expect.objectContaining({ message: expect.stringContaining("lag exceeded threshold") }),
    );
    expect(verifyRollback).toHaveBeenCalledTimes(1);
    expect(flags.isEnabled(flag)).toBe(false);
  });

  it("reports recovery failure when compensation cannot be verified", async () => {
    await expect(
      guard.run({
        scopeId: "horizon-poll-canary",
        flag,
        execute: async () => "partial-result",
        verify: async () => ({ healthy: false }),
        rollback: async () => undefined,
        verifyRollback: async () => false,
      }),
    ).rejects.toMatchObject({
      name: RolloutRecoveryError.name,
      rolledBack: false,
      scopeId: "horizon-poll-canary",
    });
  });

  it("retries a transient rollback verification failure before escalating", async () => {
    const verifyRollback = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("read replica unavailable"))
      .mockResolvedValueOnce(true);

    await expect(
      guard.run({
        scopeId: "horizon-poll-canary",
        flag,
        execute: async () => "partial-result",
        verify: async () => ({ healthy: false }),
        rollback: jest.fn(),
        verifyRollback,
        rollbackVerificationAttempts: 3,
        rollbackVerificationBackoffMs: 0,
      }),
    ).rejects.toMatchObject({
      name: GuardedRolloutAbortedError.name,
      rolledBack: true,
    });

    expect(verifyRollback).toHaveBeenCalledTimes(3);
  });

  it("rejects unsafe rollback verification retry limits before executing", async () => {
    const execute = jest.fn(async () => "result");

    await expect(
      guard.run({
        scopeId: "horizon-poll-canary",
        flag,
        execute,
        verify: async () => ({ healthy: true }),
        rollback: jest.fn(),
        verifyRollback: async () => true,
        rollbackVerificationAttempts: 6,
      }),
    ).rejects.toThrow(RangeError);

    expect(execute).not.toHaveBeenCalled();
  });

  it("runs compensation when rollout execution throws before returning a result", async () => {
    const rolloutFailure = new Error("write failed after partial work");
    const rollback = jest.fn(async (value: string | undefined, cause: unknown) => {
      expect(value).toBeUndefined();
      expect(cause).toBe(rolloutFailure);
    });

    await expect(
      guard.run({
        scopeId: "horizon-poll-canary",
        flag,
        execute: async () => {
          throw rolloutFailure;
        },
        verify: async () => ({ healthy: true }),
        rollback,
        verifyRollback: async () => true,
      }),
    ).rejects.toMatchObject({ name: GuardedRolloutAbortedError.name, rolledBack: true });

    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("preserves the completed result when health verification throws", async () => {
    const verificationFailure = new Error("metrics backend unavailable");
    const rollback = jest.fn();

    await expect(
      guard.run({
        scopeId: "horizon-poll-canary",
        flag,
        execute: async () => "completed-write",
        verify: async () => {
          throw verificationFailure;
        },
        rollback,
        verifyRollback: async () => true,
      }),
    ).rejects.toMatchObject({ name: GuardedRolloutAbortedError.name, rolledBack: true });

    expect(rollback).toHaveBeenCalledWith("completed-write", verificationFailure);
  });
});

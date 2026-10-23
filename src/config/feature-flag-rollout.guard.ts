import { Injectable, Logger } from "@nestjs/common";
import { FeatureFlag, FeatureFlagsService } from "./feature-flags.service";

export interface RolloutHealth {
  healthy: boolean;
  details?: string;
}

export interface GuardedRolloutOptions<T> {
  /** Human-readable, bounded identifier such as `reconciliation-v2-canary`. */
  scopeId: string;
  flag: FeatureFlag;
  /** Executes the change while the flag is enabled only in this async scope. */
  execute: () => Promise<T>;
  /** Checks observable behavior after the change; throw to report an unhealthy rollout. */
  verify: (value: T) => Promise<RolloutHealth>;
  /** Idempotently compensates any effects of execute, including partial effects. */
  rollback: (value: T | undefined, cause: unknown) => Promise<void>;
  /** Confirms the pre-rollout invariant after compensation has completed. */
  verifyRollback: () => Promise<boolean>;
  /** Maximum number of checks for the restored invariant, including the first. */
  rollbackVerificationAttempts?: number;
  /** Base delay between retry checks; each delay is multiplied by its attempt number. */
  rollbackVerificationBackoffMs?: number;
}

export interface GuardedRolloutResult<T> {
  status: "healthy";
  scopeId: string;
  value: T;
  health: RolloutHealth;
}

export class GuardedRolloutAbortedError extends Error {
  readonly rolledBack = true;

  constructor(
    public readonly scopeId: string,
    public readonly rolloutCause: unknown,
  ) {
    super(`Feature-flag rollout '${scopeId}' failed verification and was rolled back.`);
    this.name = "GuardedRolloutAbortedError";
  }
}

export class RolloutRecoveryError extends Error {
  readonly rolledBack = false;

  constructor(
    public readonly scopeId: string,
    public readonly rolloutCause: unknown,
    public readonly recoveryCause: unknown,
  ) {
    super(
      `Feature-flag rollout '${scopeId}' failed and rollback could not be verified; manual recovery is required.`,
    );
    this.name = "RolloutRecoveryError";
  }
}

/**
 * Runs a canary change in an async-local feature-flag scope, checks health,
 * and compensates and verifies the pre-rollout invariant on any failure.
 */
@Injectable()
export class FeatureFlagRolloutGuard {
  private readonly logger = new Logger(FeatureFlagRolloutGuard.name);

  async run<T>(options: GuardedRolloutOptions<T>): Promise<GuardedRolloutResult<T>> {
    const scopeId = options.scopeId.trim();
    if (!scopeId) throw new TypeError("scopeId must be a non-empty rollout identifier");
    const rollbackVerificationAttempts =
      options.rollbackVerificationAttempts ?? 3;
    const rollbackVerificationBackoffMs =
      options.rollbackVerificationBackoffMs ?? 100;
    if (
      !Number.isInteger(rollbackVerificationAttempts) ||
      rollbackVerificationAttempts < 1 ||
      rollbackVerificationAttempts > 5
    ) {
      throw new RangeError(
        "rollbackVerificationAttempts must be an integer between 1 and 5",
      );
    }
    if (
      !Number.isFinite(rollbackVerificationBackoffMs) ||
      rollbackVerificationBackoffMs < 0 ||
      rollbackVerificationBackoffMs > 10_000
    ) {
      throw new RangeError(
        "rollbackVerificationBackoffMs must be between 0 and 10000",
      );
    }

    let value: T | undefined;
    let cause: unknown;
    let health: RolloutHealth;

    try {
      const rollout = await FeatureFlagsService.withRolloutOverrides(
        new Map([[options.flag, true]]),
        async () => {
          const result = await options.execute();
          // Preserve the result before verification so a thrown health check
          // can still compensate effects produced by the completed operation.
          value = result;
          return { value: result, health: await options.verify(result) };
        },
      );
      value = rollout.value;
      health = rollout.health;
      if (!health || health.healthy !== true) {
        cause = new Error(
          health?.details
            ? `Rollout health check failed: ${health.details}`
            : "Rollout health check returned unhealthy.",
        );
      } else {
        this.logger.log(`Feature-flag rollout '${scopeId}' passed verification.`);
        return { status: "healthy", scopeId, value: rollout.value, health };
      }
    } catch (error) {
      cause = error;
    }

    this.logger.warn(`Feature-flag rollout '${scopeId}' failed; starting scoped rollback.`);
    try {
      await FeatureFlagsService.withRolloutOverrides(
        new Map([[options.flag, false]]),
        async () => {
          await options.rollback(value, cause);
          let lastVerificationError: unknown;
          for (
            let attempt = 1;
            attempt <= rollbackVerificationAttempts;
            attempt += 1
          ) {
            try {
              if (await options.verifyRollback()) return;
              lastVerificationError = new Error(
                `Rollback check ${attempt}/${rollbackVerificationAttempts} did not verify the pre-rollout invariant.`,
              );
            } catch (error) {
              lastVerificationError = error;
            }

            if (attempt < rollbackVerificationAttempts) {
              await new Promise((resolve) =>
                setTimeout(resolve, rollbackVerificationBackoffMs * attempt),
              );
            }
          }
          throw lastVerificationError;
        },
      );
      this.logger.warn(`Feature-flag rollout '${scopeId}' was rolled back and verified.`);
      throw new GuardedRolloutAbortedError(scopeId, cause);
    } catch (recoveryError) {
      if (recoveryError instanceof GuardedRolloutAbortedError) throw recoveryError;
      this.logger.error(
        `Feature-flag rollout '${scopeId}' rollback failed or could not be verified; manual recovery is required.`,
      );
      throw new RolloutRecoveryError(scopeId, cause, recoveryError);
    }
  }
}

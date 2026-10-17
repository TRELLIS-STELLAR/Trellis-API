import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AsyncLocalStorage } from "node:async_hooks";

export enum FeatureFlag {
  RECONCILIATION_HORIZON_POLLING = "RECONCILIATION_HORIZON_POLLING",
}

@Injectable()
export class FeatureFlagsService {
  /**
   * Rollout overrides are scoped to the current async execution chain. They do
   * not mutate process configuration or leak into concurrent requests/jobs.
   */
  private static readonly rolloutOverrides = new AsyncLocalStorage<
    ReadonlyMap<FeatureFlag, boolean>
  >();

  constructor(private readonly config: ConfigService) {}

  isEnabled(flag: FeatureFlag): boolean {
    const override = FeatureFlagsService.rolloutOverrides.getStore()?.get(flag);
    if (override !== undefined) return override;

    const value = this.config.get<string | boolean>(flag);
    return value === true || (typeof value === "string" && value.toLowerCase() === "true");
  }

  /** Run work with async-local flag overrides; the configured value is restored automatically. */
  static withRolloutOverrides<T>(
    overrides: ReadonlyMap<FeatureFlag, boolean>,
    work: () => T,
  ): T {
    const inherited = FeatureFlagsService.rolloutOverrides.getStore();
    const scoped = new Map(inherited ?? []);
    for (const [flag, enabled] of overrides) scoped.set(flag, enabled);
    return FeatureFlagsService.rolloutOverrides.run(scoped, work);
  }
}

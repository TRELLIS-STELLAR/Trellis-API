import { ConfigService } from "@nestjs/config";
import { FeatureFlag, FeatureFlagsService } from "./feature-flags.service";

describe("FeatureFlagsService", () => {
  it("fails closed when configuration is missing", () => {
    const service = new FeatureFlagsService({ get: jest.fn() } as unknown as ConfigService);
    expect(service.isEnabled(FeatureFlag.RECONCILIATION_HORIZON_POLLING)).toBe(false);
  });

  it("accepts an explicit true value", () => {
    const config = { get: jest.fn().mockReturnValue("true") } as unknown as ConfigService;
    const service = new FeatureFlagsService(config);
    expect(service.isEnabled(FeatureFlag.RECONCILIATION_HORIZON_POLLING)).toBe(true);
  });

  it("uses async-local rollout overrides without changing the configured value", async () => {
    const config = { get: jest.fn().mockReturnValue(false) } as unknown as ConfigService;
    const service = new FeatureFlagsService(config);
    const flag = FeatureFlag.RECONCILIATION_HORIZON_POLLING;

    await FeatureFlagsService.withRolloutOverrides(new Map([[flag, true]]), async () => {
      expect(service.isEnabled(flag)).toBe(true);
      await Promise.resolve();
      expect(service.isEnabled(flag)).toBe(true);
    });

    expect(service.isEnabled(flag)).toBe(false);
  });

  it("keeps a rollout override isolated from concurrent async work", async () => {
    const config = { get: jest.fn().mockReturnValue(false) } as unknown as ConfigService;
    const service = new FeatureFlagsService(config);
    const flag = FeatureFlag.RECONCILIATION_HORIZON_POLLING;
    let releaseScopedWork!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseScopedWork = resolve;
    });

    const scoped = FeatureFlagsService.withRolloutOverrides(
      new Map([[flag, true]]),
      async () => {
        await waiting;
        return service.isEnabled(flag);
      },
    );

    expect(service.isEnabled(flag)).toBe(false);
    releaseScopedWork();
    await expect(scoped).resolves.toBe(true);
    expect(service.isEnabled(flag)).toBe(false);
  });
});

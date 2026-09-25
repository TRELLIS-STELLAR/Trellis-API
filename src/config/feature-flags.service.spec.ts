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
});
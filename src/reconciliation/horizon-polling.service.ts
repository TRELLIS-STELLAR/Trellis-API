import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ReconciliationService } from "./reconciliation.service";
import { FeatureFlag, FeatureFlagsService } from "../config/feature-flags.service";

@Injectable()
export class HorizonPollingService {
  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Interval(60_000)
  poll() {
    if (!this.featureFlags.isEnabled(FeatureFlag.RECONCILIATION_HORIZON_POLLING)) {
      return { skipped: true, reason: "feature_disabled", ingested: 0 };
    }
    return this.reconciliationService.pollHorizon();
  }
}

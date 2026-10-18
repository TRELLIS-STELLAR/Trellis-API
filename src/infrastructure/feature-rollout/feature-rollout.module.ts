import { Module, Global } from "@nestjs/common";
import { FeatureRolloutService } from "./feature-rollout.service";
import { FeatureRolloutGuard } from "./feature-rollout.guard";

@Global()
@Module({
  providers: [FeatureRolloutService, FeatureRolloutGuard],
  exports: [FeatureRolloutService, FeatureRolloutGuard],
})
export class FeatureRolloutModule {}

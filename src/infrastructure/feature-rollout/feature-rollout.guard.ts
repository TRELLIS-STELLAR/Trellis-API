import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { FeatureRolloutService } from "./feature-rollout.service";

export const FEATURE_KEY_METADATA = "feature_rollout_key";
export const RequireFeature = (featureKey: string) =>
  SetMetadata(FEATURE_KEY_METADATA, featureKey);

@Injectable()
export class FeatureRolloutGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rolloutService: FeatureRolloutService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const featureKey = this.reflector.getAllAndOverride<string>(
      FEATURE_KEY_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (!featureKey) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    const evaluation = this.rolloutService.isEnabled(featureKey, {
      userId: user?.id ?? user?.sub,
      role: user?.role,
    });

    if (!evaluation.enabled) {
      if (evaluation.reason === "emergency_disabled") {
        throw new ServiceUnavailableException(
          `Feature '${featureKey}' is temporarily disabled under emergency maintenance. Please try again later.`,
        );
      }
      throw new ServiceUnavailableException(
        `Feature '${featureKey}' is not active for this account.`,
      );
    }

    return true;
  }
}

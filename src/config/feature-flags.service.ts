import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export enum FeatureFlag {
  RECONCILIATION_HORIZON_POLLING = "RECONCILIATION_HORIZON_POLLING",
}

@Injectable()
export class FeatureFlagsService {
  constructor(private readonly config: ConfigService) {}

  isEnabled(flag: FeatureFlag): boolean {
    const value = this.config.get<string | boolean>(flag);
    return value === true || (typeof value === "string" && value.toLowerCase() === "true");
  }
}
import { SetMetadata } from "@nestjs/common";
import { DegradedCapability } from "./degraded-mode.types";

export const REQUIRES_CAPABILITY_KEY = "degradedMode:capability";

/** Marks a route as unavailable while `capability` is disabled by the degraded mode. */
export const RequiresCapability = (capability: DegradedCapability) =>
  SetMetadata(REQUIRES_CAPABILITY_KEY, capability);

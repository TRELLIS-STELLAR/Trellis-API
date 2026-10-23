import { DegradedCapability } from "./degraded-mode.types";

/** Raised when a capability is disabled by the current degraded mode. */
export class DegradedModeCapabilityBlockedError extends Error {
  constructor(
    public readonly capability: DegradedCapability,
    public readonly reason: string,
  ) {
    super(`Capability '${capability}' is unavailable in the current degraded mode: ${reason}`);
    this.name = "DegradedModeCapabilityBlockedError";
  }
}

/** Raised when a non-admin tries to change the manual degraded mode. */
export class DegradedModeAuthorizationError extends Error {
  constructor(message = "Only ADMIN may change the degraded mode") {
    super(message);
    this.name = "DegradedModeAuthorizationError";
  }
}

import { SetMetadata } from "@nestjs/common";
import { SensitiveAction } from "../../../infrastructure/audit/sensitive-actions/sensitive-action.enum";

export const REQUIRE_CAPABILITY_METADATA_KEY = "trellis:require_capability";

export interface RequireCapabilityMetadata {
  /** Sensitive action required to execute the route handler. */
  action: SensitiveAction | string;
  /** Target resource type expected in the capability scope. */
  resourceType?: string;
  /** Route param name holding the target `resourceId` (e.g. `"id"` or `"portfolioId"`). */
  resourceIdParam?: string;
  /** Request body property holding the target `resourceId`. */
  resourceIdBodyField?: string;
  /** Request header holding the target `resourceId`. */
  resourceIdHeader?: string;
  /** Request body fields to pass as `operationParams` for constraint checks. */
  constraintBodyFields?: string[];
  /** Whether verifying the token on this route consumes a single-use token (default: true). */
  consume?: boolean;
}

/**
 * Decorator that declares a route requires a signed, unexpired capability token
 * scoped to the specified sensitive action and resource.
 */
export const RequireCapability = (metadata: RequireCapabilityMetadata) =>
  SetMetadata(REQUIRE_CAPABILITY_METADATA_KEY, metadata);

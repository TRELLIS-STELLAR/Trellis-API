import { SetMetadata } from "@nestjs/common";
import { SupportAccessScope } from "../impersonation.types";

export const REQUIRE_SUPPORT_SCOPE_KEY = "requireSupportScope";

/**
 * Decorator to enforce specific support access scopes during an impersonated session.
 * If the current request is an impersonation session, the impersonator must have been
 * granted at least one of the specified scopes (or `SupportAccessScope.FULL`).
 */
export const RequireSupportScope = (...scopes: SupportAccessScope[]) =>
  SetMetadata(REQUIRE_SUPPORT_SCOPE_KEY, scopes);

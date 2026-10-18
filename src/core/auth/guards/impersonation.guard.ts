import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ALLOW_IMPERSONATION_KEY } from "../decorators/allow-impersonation.decorator";
import { REQUIRE_SUPPORT_SCOPE_KEY } from "../decorators/require-support-scope.decorator";
import { SupportAccessScope } from "../impersonation.types";

@Injectable()
export class ImpersonationGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const user = request?.user;

    // If no user or not impersonating, it's fine.
    if (!user || !user.impersonatorId) {
      return true;
    }

    // 1. Automatic time-bound expiration check
    if (user.expiresAt) {
      const expiryMs = new Date(user.expiresAt).getTime();
      if (!isNaN(expiryMs) && Date.now() >= expiryMs) {
        throw new ForbiddenException(
          "Support access session has expired.",
        );
      }
    }

    const activeScopes: string[] = user.supportScopes || [
      SupportAccessScope.READ_ONLY,
    ];

    // 2. Set user-safe audit notice header on the response
    if (response && typeof response.setHeader === "function") {
      response.setHeader(
        "X-Support-Session",
        `active; scopes=${activeScopes.join(",")}; expires=${user.expiresAt || "1h"}`,
      );
    }

    // 3. Scoped access enforcement if the route declares required support scopes
    const requiredScopes = this.reflector.getAllAndOverride<SupportAccessScope[]>(
      REQUIRE_SUPPORT_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredScopes && requiredScopes.length > 0) {
      const hasFullScope = activeScopes.includes(SupportAccessScope.FULL);
      const hasRequiredScope = activeScopes.some((s) =>
        requiredScopes.includes(s as SupportAccessScope),
      );

      if (!hasFullScope && !hasRequiredScope) {
        throw new ForbiddenException(
          `Insufficient support scope for this endpoint. Required: ${requiredScopes.join(", ")}; granted: ${activeScopes.join(", ")}`,
        );
      }
    }

    // 4. Check route allow-impersonation exemption
    const isImpersonationAllowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_IMPERSONATION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isImpersonationAllowed) {
      return true;
    }

    // 5. Block dangerous mutation methods during impersonation sessions
    const dangerousMethods = ["POST", "PUT", "PATCH", "DELETE"];
    const method = request.method ? request.method.toUpperCase() : "";
    if (dangerousMethods.includes(method)) {
      throw new ForbiddenException(
        "Mutations are disabled during impersonation sessions.",
      );
    }

    return true;
  }
}

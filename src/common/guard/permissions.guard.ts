import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSIONS_KEY } from "./permissions.decorator";
import { Permission, Role, hasAllPermissions, normalizeRole } from "./roles.enum";

type AuthenticatedRequest = {
  user?: {
    id?: string;
    address?: string;
    role?: string;
    roles?: string[];
    permissions?: string[];
  };
};

/**
 * PermissionsGuard enforces fine-grained permission checks across API boundaries.
 *
 * Rules:
 *  1. If no @RequirePermissions or @Permissions is present, access is granted.
 *  2. The request MUST have an authenticated user.
 *  3. The user's role (or explicit user.permissions) must grant ALL required permissions.
 *  4. Admin role automatically grants all permissions.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions =
      this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);

    // No permission restriction — allow
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException("No authenticated user found on request");
    }

    // Coerce roles
    const rawRoles: string[] = user.roles ?? (user.role ? [user.role] : []);
    const userRoles: Role[] = rawRoles.map((r) => normalizeRole(r));

    if (userRoles.includes(Role.ADMIN)) {
      return true;
    }

    // Check if user has all required permissions via role
    const grantedViaRoles = hasAllPermissions(userRoles, requiredPermissions);
    if (grantedViaRoles) {
      return true;
    }

    // Check explicit user permissions claim if present
    const explicitPerms = user.permissions ?? [];
    const missing = requiredPermissions.filter(
      (perm) =>
        !explicitPerms.includes(perm) && !hasAllPermissions(userRoles, [perm]),
    );

    if (missing.length > 0) {
      this.logger.warn(
        `Permission check failed: user=${user.id ?? user.address} roles=[${userRoles.join(
          ",",
        )}] missing=[${missing.join(",")}]`,
      );
      throw new ForbiddenException(
        `Insufficient permissions. Missing: [${missing.join(", ")}]`,
      );
    }

    return true;
  }
}

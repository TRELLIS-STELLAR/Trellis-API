import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ALLOW_IMPERSONATION_KEY } from "../decorators/allow-impersonation.decorator";

@Injectable()
export class ImpersonationGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isImpersonationAllowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_IMPERSONATION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isImpersonationAllowed) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    
    // If no user or not impersonating, it's fine.
    if (!user || !user.impersonatorId) {
      return true;
    }

    // Block dangerous methods
    const dangerousMethods = ["POST", "PUT", "PATCH", "DELETE"];
    if (dangerousMethods.includes(request.method.toUpperCase())) {
      throw new ForbiddenException(
        "Mutations are disabled during impersonation sessions.",
      );
    }

    return true;
  }
}

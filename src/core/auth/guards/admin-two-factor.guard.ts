import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EnhancedAuthService } from "../enhanced-auth.service";
import { User } from "src/core/user/entities/user.entity";

interface AuthenticatedPrincipal {
  id?: string;
  sub?: string;
  address?: string;
  role?: string;
  twoFactorVerified?: boolean;
}

/**
 * AdminTwoFactorGuard — enforces mandatory two-factor authentication for admin
 * accounts on admin endpoints.
 *
 * Must run AFTER {@link JwtAuthGuard} so `request.user` is populated.
 *
 * Rules (admins only — non-admin principals pass straight through):
 *  1. The admin MUST have 2FA enabled on their account. If not, access is
 *     refused with guidance to enable it (this is what makes 2FA mandatory for
 *     admins — they cannot reach admin endpoints until they enable it).
 *  2. The current session token MUST be 2FA-verified (`twoFactorVerified`), i.e.
 *     the admin completed the 2FA challenge during this login.
 */
@Injectable()
export class AdminTwoFactorGuard implements CanActivate {
  private readonly logger = new Logger(AdminTwoFactorGuard.name);

  constructor(
    private readonly enhancedAuthService: EnhancedAuthService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedPrincipal }>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException("No authenticated user found on request");
    }

    // Only admin principals are subject to mandatory 2FA enforcement here.
    if (!this.isAdmin(user.role)) {
      return true;
    }

    const userId = await this.resolveUserId(user);
    if (!userId) {
      throw new ForbiddenException("Unable to resolve admin account identity");
    }

    const enabled = await this.enhancedAuthService.isTwoFactorEnabled(userId);
    if (!enabled) {
      this.logger.warn(`Admin ${userId} blocked: 2FA not enabled`);
      throw new ForbiddenException(
        "Admin accounts must enable two-factor authentication before accessing admin endpoints.",
      );
    }

    if (!user.twoFactorVerified) {
      this.logger.warn(`Admin ${userId} blocked: session not 2FA-verified`);
      throw new ForbiddenException(
        "Two-factor verification required to access admin endpoints.",
      );
    }

    return true;
  }

  private isAdmin(role?: string): boolean {
    return (role ?? "").toLowerCase() === "admin";
  }

  /**
   * Traditional principals carry the user id directly; wallet principals only
   * carry an address, so resolve it to the owning user id.
   */
  private async resolveUserId(
    user: AuthenticatedPrincipal,
  ): Promise<string | null> {
    if (user.id || user.sub) {
      return user.id ?? user.sub ?? null;
    }

    if (user.address) {
      const owner = await this.userRepository.findOne({
        where: { walletAddress: user.address.toLowerCase() },
      });
      return owner?.id ?? null;
    }

    return null;
  }
}

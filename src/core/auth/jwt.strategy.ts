import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { ExtractJwt, Strategy } from "passport-jwt";
import { AuthPayload } from "./wallet-auth.service";
import { TokenBlacklistService } from "./token-blacklist.service";
import { normalizeRole } from "src/common/guard/roles.enum";

interface JwtPayload {
  sub?: string; // User ID for traditional auth
  address?: string; // Wallet address for wallet auth
  email?: string;
  username?: string;
  role?: string;
  tier?: string;
  jti?: string; // JWT ID for replay attack prevention
  twoFactorVerified?: boolean; // whether 2FA was completed for this session
  impersonatorId?: string; // ID of the admin impersonating this user
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private tokenBlacklist: TokenBlacklistService,
  ) {
    const secret =
      configService.get<string>("JWT_SECRET") ||
      process.env.JWT_SECRET ||
      "your_jwt_secret_key_here";

    if (!secret) {
      throw new Error("JWT_SECRET must be defined in environment variables");
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      algorithms: ["HS256"], // Explicitly specify allowed algorithms
    });
  }

  async validate(payload: JwtPayload) {
    // Validate payload structure - support both wallet and traditional auth
    if (!payload) {
      throw new UnauthorizedException("Invalid token payload");
    }

    // Check jti claim for replay attack prevention
    if (payload.jti && this.tokenBlacklist.isRevoked(payload.jti)) {
      throw new UnauthorizedException("Token has been revoked");
    }

    // Check if it's a traditional auth payload (has sub) or wallet auth payload (has address)
    const isTraditionalAuth = !!payload.sub;
    const isWalletAuth = !!payload.address;

    if (!isTraditionalAuth && !isWalletAuth) {
      throw new UnauthorizedException(
        "Invalid token payload - missing user identifier",
      );
    }

    // Coerce the (possibly legacy lowercase or missing) role claim into the
    // canonical UPPERCASE Role so downstream guards compare consistently.
    // Missing/unknown claims map to Role.USER (least privilege).
    const role = normalizeRole(payload.role);

    // Return user object compatible with both auth types
    if (isTraditionalAuth) {
      return {
        id: payload.sub,
        sub: payload.sub,
        email: payload.email,
        username: payload.username,
        role,
        roles: [role],
        tier: payload.tier,
        jti: payload.jti,
        twoFactorVerified: payload.twoFactorVerified ?? false,
        impersonatorId: payload.impersonatorId,
        exp: payload.exp,
        type: "traditional",
      };
    } else {
      return {
        address: payload.address,
        email: payload.email,
        role,
        tier: payload.tier,
        roles: [role],
        jti: payload.jti,
        twoFactorVerified: payload.twoFactorVerified ?? false,
        impersonatorId: payload.impersonatorId,
        exp: payload.exp,
        type: "wallet",
      };
    }
  }
}

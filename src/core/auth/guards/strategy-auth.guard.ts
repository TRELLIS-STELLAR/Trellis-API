import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { StrategyRegistry } from "src/core/auth/strategies/strategy.registry";
import { AuthPayload } from "src/core/auth/strategies/interfaces/auth-strategy.interface";
import { ALLOWED_STRATEGIES_KEY } from "src/core/auth/decorators/allowed-strategies.decorator";
import { IS_PUBLIC_KEY } from "src/common/decorators/public.decorator";
import { PERMISSIONS_KEY } from "src/common/guard/permissions.decorator";
import { ApiKeyStrategy } from "src/core/auth/strategies/api-key/api-key.strategy";

/**
 * Authentication guard that supports multiple strategies
 * Validates JWT tokens and checks strategy permissions
 */
@Injectable()
export class StrategyAuthGuard implements CanActivate {
  private readonly logger = new Logger(StrategyAuthGuard.name);

  constructor(
    private readonly strategyRegistry: StrategyRegistry,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    const apiKey = request.headers?.["x-api-key"];
    if (!token && !apiKey) {
      throw new UnauthorizedException("Access token is required");
    }

    try {
      // Try to validate token with any enabled strategy
      let payload: AuthPayload | null;
      if (apiKey) {
        if (typeof apiKey !== "string")
          throw new UnauthorizedException("Invalid API key header");
        const strategy = this.strategyRegistry.get("api-key") as ApiKeyStrategy;
        if (!strategy?.isEnabled)
          throw new UnauthorizedException("API key authentication is disabled");
        const result = await strategy.authenticate({ apiKey });
        payload = await strategy.validateToken(result.token);
      } else {
        payload = await this.validateTokenWithStrategies(token);
        // Other strategies share the JWT secret. Always recheck key state for API key JWTs.
        if (payload?.type === "api-key") {
          const strategy = this.strategyRegistry.get("api-key");
          payload = strategy ? await strategy.validateToken(token) : null;
        }
      }

      if (!payload) {
        throw new UnauthorizedException("Invalid or expired token");
      }

      // Check if the strategy is allowed for this route
      const allowedStrategies = this.reflector.getAllAndOverride<string[]>(
        ALLOWED_STRATEGIES_KEY,
        [context.getHandler(), context.getClass()],
      );

      if (allowedStrategies && !allowedStrategies.includes(payload.type)) {
        throw new UnauthorizedException(
          `Authentication strategy '${payload.type}' is not allowed for this resource`,
        );
      }

      if (payload.type === "api-key") {
        const required = this.reflector.getAllAndOverride<string[]>(
          PERMISSIONS_KEY,
          [context.getHandler(), context.getClass()],
        );
        const scopes = payload.permissions ?? [];
        const methodScope = ["GET", "HEAD", "OPTIONS"].includes(request.method)
          ? "read"
          : "write";
        const permitted = required?.length
          ? required.every((permission) => scopes.includes(permission))
          : scopes.includes(methodScope);
        if (!permitted)
          throw new ForbiddenException("API key has insufficient scopes");
      }

      // Attach user to request
      request.user = this.transformPayloadToUser(payload);
      request.authType = payload.type;

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      this.logger.warn("Authentication failed", error);
      throw new UnauthorizedException("Authentication failed");
    }
  }

  /**
   * Extract JWT token from Authorization header
   */
  private extractTokenFromHeader(request: {
    headers?: { authorization?: string };
  }): string | undefined {
    const authHeader = request.headers?.authorization;
    if (!authHeader) {
      return undefined;
    }

    const [type, token] = authHeader.split(" ");
    return type === "Bearer" ? token : undefined;
  }

  /**
   * Try to validate token with all enabled strategies
   */
  private async validateTokenWithStrategies(
    token: string,
  ): Promise<AuthPayload | null> {
    const strategies = this.strategyRegistry.getAll();

    for (const strategy of strategies) {
      try {
        const payload = await strategy.validateToken(token);
        if (payload) {
          return payload;
        }
      } catch (error) {
        // Continue to next strategy
        continue;
      }
    }

    return null;
  }

  /**
   * Transform JWT payload to user object
   */
  private transformPayloadToUser(payload: AuthPayload): {
    id?: string;
    address?: string;
    email?: string;
    username?: string;
    role: string;
    tier?: string;
    roles: string[];
    type: string;
    permissions?: string[];
  } {
    return {
      id: payload.sub,
      address: payload.address,
      email: payload.email,
      username: payload.username,
      role: payload.role,
      tier: payload.tier,
      roles: payload.roles || [payload.role],
      type: payload.type,
      // Key scopes only restrict access; they must not become grants in PermissionsGuard.
      permissions: payload.type === "api-key" ? undefined : payload.permissions,
    };
  }
}

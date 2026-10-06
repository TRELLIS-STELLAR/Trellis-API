import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  AuthStrategy,
  AuthResult,
  AuthPayload,
  ApiKeyCredentials,
} from "src/core/auth/strategies/interfaces/auth-strategy.interface";
import { User } from "src/core/user/entities/user.entity";
import { ApiKeysService, hashApiKey } from "src/core/auth/api-keys.service";
import {
  RateLimitTier,
  resolveRateLimitTierFromRole,
} from "src/config/quota.config";

/**
 * API Key metadata
 */
interface ApiKeyMetadata {
  id?: string;
  userId: string;
  name: string;
  permissions: string[];
  tier: RateLimitTier;
  createdAt: Date;
  expiresAt?: Date;
  lastUsedAt?: Date;
}

/**
 * API Key authentication strategy
 * For service-to-service and programmatic access
 */
@Injectable()
export class ApiKeyStrategy implements AuthStrategy {
  readonly name = "api-key";
  private readonly logger = new Logger(ApiKeyStrategy.name);
  private readonly apiKeys = new Map<string, ApiKeyMetadata>();

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly persistedKeys: ApiKeysService,
  ) {
    this.loadSystemApiKeys();
  }

  /**
   * Load system-level API keys from configuration
   */
  private loadSystemApiKeys(): void {
    const systemApiKeys = this.configService.get<string>("SYSTEM_API_KEYS");
    if (systemApiKeys) {
      try {
        const keys: Array<{
          key: string;
          userId: string;
          name: string;
          permissions: string[];
          tier?: RateLimitTier;
        }> = JSON.parse(systemApiKeys);
        keys.forEach(({ key, userId, name, permissions, tier }) => {
          this.apiKeys.set(hashApiKey(key), {
            userId,
            name,
            permissions,
            tier: tier ?? "enterprise",
            createdAt: new Date(),
          });
        });
        this.logger.warn(
          `Loaded ${keys.length} deprecated SYSTEM_API_KEYS; migrate to user-managed API keys`,
        );
      } catch (error) {
        this.logger.error("Failed to parse SYSTEM_API_KEYS", error);
      }
    }
  }

  /**
   * Check if API key strategy is enabled
   */
  get isEnabled(): boolean {
    return this.configService.get<boolean>("AUTH_API_KEY_ENABLED", true);
  }

  /**
   * Authenticate using API key
   * @param credentials - API key credentials
   * @returns Authentication result with JWT token
   */
  async authenticate(credentials: unknown): Promise<AuthResult> {
    const { apiKey, apiSecret } = credentials as ApiKeyCredentials;

    if (!apiKey) {
      throw new BadRequestException("API key is required");
    }

    // Validate API key
    const keyMetadata = await this.validateApiKey(apiKey, apiSecret);
    if (!keyMetadata) {
      throw new UnauthorizedException("Invalid API key");
    }

    // Get user
    const user = await this.userRepository.findOne({
      where: { id: keyMetadata.userId },
    });

    if (!user) {
      throw new UnauthorizedException("User not found for API key");
    }

    // Update last used timestamp
    keyMetadata.lastUsedAt = new Date();

    // Generate JWT token with limited lifetime
    const payload: AuthPayload = {
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role || "service",
      tier:
        keyMetadata.tier || resolveRateLimitTierFromRole(user.role, "api-key"),
      iat: Math.floor(Date.now() / 1000),
      type: "api-key",
      apiKeyId: keyMetadata.id,
      systemKeyHash: keyMetadata.id ? undefined : hashApiKey(apiKey),
      permissions: keyMetadata.permissions,
    };

    const token = this.jwtService.sign(payload, {
      expiresIn: "1h", // Short-lived tokens for API keys
    });

    this.logger.log(
      `API key authenticated: ${keyMetadata.name} for user ${user.id}`,
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role || "service",
        tier:
          keyMetadata.tier ||
          resolveRateLimitTierFromRole(user.role, "api-key"),
        type: "api-key",
      },
    };
  }

  /**
   * Validate API key and optional secret
   */
  private async validateApiKey(
    apiKey: string,
    apiSecret?: string,
  ): Promise<ApiKeyMetadata | null> {
    // Check in-memory keys
    const metadata = this.apiKeys.get(hashApiKey(apiKey));
    if (metadata) {
      // Check expiration
      if (metadata.expiresAt && metadata.expiresAt < new Date()) {
        return null;
      }
      return metadata;
    }

    const stored = await this.persistedKeys.validate(apiKey);
    return stored
      ? {
          id: stored.id,
          userId: stored.userId,
          name: stored.name,
          permissions: stored.permissions,
          createdAt: stored.createdAt,
          expiresAt: stored.expiresAt,
          lastUsedAt: stored.lastUsedAt,
          tier: undefined,
        }
      : null;
  }

  /**
   * Validate a JWT token
   * @param token - The JWT token to validate
   * @returns The decoded payload or null if invalid
   */
  async validateToken(token: string): Promise<AuthPayload | null> {
    try {
      const payload = this.jwtService.verify(token) as AuthPayload;
      if (payload.type !== "api-key") return null;
      if (payload.apiKeyId) {
        const key = await this.persistedKeys.validateTokenKey(
          payload.apiKeyId,
          payload.sub,
        );
        payload.permissions = key.permissions;
      } else {
        const key = this.apiKeys.get(payload.systemKeyHash);
        if (!key || key.userId !== payload.sub) return null;
        payload.permissions = key.permissions;
      }
      return payload;
    } catch (error) {
      this.logger.warn("Token validation failed", error);
      return null;
    }
  }
}

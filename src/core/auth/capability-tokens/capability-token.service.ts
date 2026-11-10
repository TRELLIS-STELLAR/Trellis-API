import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { TokenBlacklistService } from "../token-blacklist.service";
import {
  CAPABILITY_TOKEN_PREFIX,
  CapabilityConstraintValue,
  CapabilityScope,
  CapabilityTokenClaims,
  CapabilityTokenErrorCode,
  CapabilityTokenHeader,
  CapabilityTokenServiceOptions,
  CapabilityTokenVerificationResult,
  DEFAULT_CAPABILITY_ISSUER,
  DEFAULT_CAPABILITY_TTL_SECONDS,
  IssueCapabilityTokenInput,
  IssuedCapabilityToken,
  MAX_CAPABILITY_TTL_SECONDS,
  MIN_CAPABILITY_TTL_SECONDS,
  VerifyCapabilityTokenContext,
} from "./capability-token.types";

interface ConsumptionRecord {
  count: number;
  maxUses: number;
  expiresAtMs: number;
  idempotencyKeys: Set<string>;
}

interface RevocationRecord {
  reason?: string;
  revokedAtMs: number;
  expiresAtMs: number;
}

@Injectable()
export class CapabilityTokenService {
  private readonly logger = new Logger(CapabilityTokenService.name);
  private readonly keys = new Map<string, string>();
  private activeKeyId: string;
  private readonly clockSkewSeconds: number;
  private readonly issuer: string;

  private readonly consumptions = new Map<string, ConsumptionRecord>();
  private readonly revocations = new Map<string, RevocationRecord>();
  private readonly subjectCutoffs = new Map<string, number>();

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly tokenBlacklistService?: TokenBlacklistService,
    @Optional() options?: CapabilityTokenServiceOptions,
  ) {
    this.clockSkewSeconds = Math.max(0, options?.clockSkewSeconds ?? 0);
    this.issuer = options?.issuer ?? DEFAULT_CAPABILITY_ISSUER;

    const configuredActiveKeyId =
      options?.activeKeyId ??
      this.configService?.get<string>("CAPABILITY_TOKEN_KEY_ID") ??
      "cap-key-v1";

    const configuredSecret =
      this.configService?.get<string>("CAPABILITY_TOKEN_SECRET") ??
      this.configService?.get<string>("JWT_SECRET") ??
      process.env.CAPABILITY_TOKEN_SECRET ??
      process.env.JWT_SECRET ??
      "trellis-default-capability-secret-change-in-prod";

    if (options?.keys && Object.keys(options.keys).length > 0) {
      for (const [kid, secret] of Object.entries(options.keys)) {
        if (secret && secret.trim().length > 0) {
          this.keys.set(kid, secret);
        }
      }
    }

    if (!this.keys.has(configuredActiveKeyId)) {
      this.keys.set(configuredActiveKeyId, configuredSecret);
    }

    this.activeKeyId = configuredActiveKeyId;
  }

  /**
   * Register or rotate a signing key in the capability token keyring.
   * Retaining previous keys in the ring allows in-flight tokens to verify
   * cleanly during secret rotation.
   */
  rotateKey(newKeyId: string, newSecret: string, makeActive = true): void {
    if (!newKeyId?.trim() || !newSecret?.trim()) {
      throw new BadRequestException("Key ID and secret must be non-empty");
    }
    this.keys.set(newKeyId.trim(), newSecret);
    if (makeActive) {
      this.activeKeyId = newKeyId.trim();
    }
  }

  /**
   * Issue a signed, short-lived capability token scoped to a specific sensitive action.
   */
  issueToken(input: IssueCapabilityTokenInput): IssuedCapabilityToken {
    const subject = input.subject?.trim();
    if (!subject) {
      throw new BadRequestException("Capability token requires a non-empty subject");
    }

    const action = input.scope?.action?.trim();
    if (!action) {
      throw new BadRequestException("Capability token requires a non-empty scope.action");
    }

    const ttlSeconds = input.ttlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS;
    if (
      !Number.isFinite(ttlSeconds) ||
      ttlSeconds < MIN_CAPABILITY_TTL_SECONDS ||
      ttlSeconds > MAX_CAPABILITY_TTL_SECONDS
    ) {
      throw new BadRequestException(
        `Capability token TTL must be between ${MIN_CAPABILITY_TTL_SECONDS} and ${MAX_CAPABILITY_TTL_SECONDS} seconds`,
      );
    }

    const singleUse = input.singleUse ?? true;
    const maxUses = singleUse ? 1 : Math.max(1, Math.floor(input.maxUses ?? 1));
    if (singleUse && input.maxUses !== undefined && input.maxUses !== 1) {
      throw new BadRequestException("Single-use capability tokens cannot specify maxUses !== 1");
    }

    const keyId = input.keyId ?? this.activeKeyId;
    const secret = this.keys.get(keyId);
    if (!secret) {
      throw new BadRequestException(`Unknown capability signing key ID: ${keyId}`);
    }

    const nowMs = input.nowMs ?? Date.now();
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + Math.floor(ttlSeconds);

    if (input.notBeforeSeconds !== undefined && input.notBeforeSeconds > exp) {
      throw new BadRequestException("Capability token notBeforeSeconds cannot exceed expiration");
    }

    const jti = `cap_${randomBytes(16).toString("hex")}`;
    const normalizedScope: CapabilityScope = {
      action,
      ...(input.scope.resourceType ? { resourceType: input.scope.resourceType.trim() } : {}),
      ...(input.scope.resourceId ? { resourceId: input.scope.resourceId.trim() } : {}),
      ...(input.scope.constraints ? { constraints: { ...input.scope.constraints } } : {}),
    };

    const header: CapabilityTokenHeader = {
      alg: "HS256",
      typ: "CAP+JWT",
      kid: keyId,
    };

    const claims: CapabilityTokenClaims = {
      version: "v1",
      jti,
      sub: subject,
      iss: this.issuer,
      iat,
      ...(input.notBeforeSeconds !== undefined ? { nbf: Math.floor(input.notBeforeSeconds) } : {}),
      exp,
      singleUse,
      maxUses,
      scope: normalizedScope,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      ...(input.correlationId?.trim() ? { correlationId: input.correlationId.trim() } : {}),
    };

    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedClaims = this.base64UrlEncode(JSON.stringify(claims));
    const signingInput = `${CAPABILITY_TOKEN_PREFIX}.${encodedHeader}.${encodedClaims}`;
    const signature = this.sign(signingInput, secret);
    const token = `${signingInput}.${signature}`;

    return {
      token,
      jti,
      keyId,
      claims,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /**
   * Verify a capability token against the required execution context and optionally consume it.
   * Never throws; returns a structured `CapabilityTokenVerificationResult`.
   */
  async verify(
    token: string | undefined | null,
    context: VerifyCapabilityTokenContext,
  ): Promise<CapabilityTokenVerificationResult> {
    if (!token || typeof token !== "string" || !token.trim()) {
      return this.fail("MISSING_TOKEN", "Capability token is required");
    }

    const parts = token.trim().split(".");
    if (parts.length !== 4 || parts[0] !== CAPABILITY_TOKEN_PREFIX) {
      return this.fail("MALFORMED_TOKEN", "Capability token format is invalid");
    }

    const [, encodedHeader, encodedClaims, providedSignature] = parts;
    if (!encodedHeader || !encodedClaims || !providedSignature) {
      return this.fail("MALFORMED_TOKEN", "Capability token segments are incomplete");
    }

    let header: CapabilityTokenHeader;
    let claims: CapabilityTokenClaims;
    try {
      header = JSON.parse(this.base64UrlDecode(encodedHeader)) as CapabilityTokenHeader;
      claims = JSON.parse(this.base64UrlDecode(encodedClaims)) as CapabilityTokenClaims;
    } catch {
      return this.fail("MALFORMED_TOKEN", "Capability token payload could not be decoded");
    }

    if (
      !header ||
      header.alg !== "HS256" ||
      header.typ !== "CAP+JWT" ||
      typeof header.kid !== "string" ||
      !header.kid
    ) {
      return this.fail("MALFORMED_TOKEN", "Capability token header is invalid");
    }

    if (!claims || claims.version !== "v1" || !claims.jti || !claims.sub || !claims.scope?.action) {
      return this.fail("UNSUPPORTED_VERSION", "Capability token claims version or structure is unsupported");
    }

    const secret = this.keys.get(header.kid);
    if (!secret) {
      return this.fail("UNKNOWN_KEY_ID", `Signing key "${header.kid}" is not recognized`);
    }

    const signingInput = `${CAPABILITY_TOKEN_PREFIX}.${encodedHeader}.${encodedClaims}`;
    const expectedSignature = this.sign(signingInput, secret);
    if (!this.safeSignatureEquals(providedSignature, expectedSignature)) {
      return this.fail("INVALID_SIGNATURE", "Capability token signature verification failed");
    }

    const nowMs = context.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    this.sweepExpiredState(nowMs);

    if (claims.nbf !== undefined && nowSeconds + this.clockSkewSeconds < claims.nbf) {
      return this.fail("TOKEN_NOT_YET_VALID", "Capability token is not yet valid", claims, header.kid);
    }

    if (nowSeconds - this.clockSkewSeconds >= claims.exp) {
      return this.fail("TOKEN_EXPIRED", "Capability token has expired", claims, header.kid);
    }

    if (await this.isTokenRevoked(claims.jti, nowMs)) {
      return this.fail("TOKEN_REVOKED", "Capability token has been revoked", claims, header.kid);
    }

    if (await this.isSubjectRevoked(claims.sub, claims.iat)) {
      return this.fail(
        "SUBJECT_REVOKED",
        "Capability tokens for this subject have been revoked",
        claims,
        header.kid,
      );
    }

    if (context.expectedSubject && claims.sub !== context.expectedSubject) {
      return this.fail(
        "SUBJECT_MISMATCH",
        `Capability token subject "${claims.sub}" does not match actor "${context.expectedSubject}"`,
        claims,
        header.kid,
      );
    }

    if (!this.matchesAction(claims.scope.action, context.requiredAction)) {
      return this.fail(
        "SCOPE_ACTION_MISMATCH",
        `Capability token action "${claims.scope.action}" does not authorize "${context.requiredAction}"`,
        claims,
        header.kid,
      );
    }

    if (!this.matchesResource(claims.scope, context.resourceType, context.resourceId)) {
      return this.fail(
        "SCOPE_RESOURCE_MISMATCH",
        "Capability token resource scope does not match the target resource",
        claims,
        header.kid,
      );
    }

    const constraintError = this.validateConstraints(
      claims.scope.constraints,
      context.operationParams,
    );
    if (constraintError) {
      return this.fail("CONSTRAINT_VIOLATION", constraintError, claims, header.kid);
    }

    const shouldConsume = context.consume ?? true;
    const maxUses = claims.singleUse ? 1 : Math.max(1, claims.maxUses ?? 1);
    const existing = this.consumptions.get(claims.jti);
    const idempotencyKey = context.idempotencyKey?.trim();

    if (existing && idempotencyKey && existing.idempotencyKeys.has(idempotencyKey)) {
      return {
        valid: true,
        claims,
        keyId: header.kid,
        consumed: false,
        idempotentReplay: true,
        remainingUses: Math.max(0, existing.maxUses - existing.count),
      };
    }

    if (existing && existing.count >= maxUses) {
      return this.fail(
        "TOKEN_ALREADY_CONSUMED",
        `Capability token "${claims.jti}" has already been consumed`,
        claims,
        header.kid,
      );
    }

    if (shouldConsume) {
      const record: ConsumptionRecord = existing ?? {
        count: 0,
        maxUses,
        expiresAtMs: claims.exp * 1000,
        idempotencyKeys: new Set<string>(),
      };
      record.count += 1;
      if (idempotencyKey) {
        record.idempotencyKeys.add(idempotencyKey);
      }
      this.consumptions.set(claims.jti, record);

      return {
        valid: true,
        claims,
        keyId: header.kid,
        consumed: true,
        idempotentReplay: false,
        remainingUses: Math.max(0, record.maxUses - record.count),
      };
    }

    return {
      valid: true,
      claims,
      keyId: header.kid,
      consumed: false,
      idempotentReplay: false,
      remainingUses: Math.max(0, maxUses - (existing?.count ?? 0)),
    };
  }

  /**
   * Verify a capability token or throw the appropriate Nest HTTP exception.
   */
  async verifyOrThrow(
    token: string | undefined | null,
    context: VerifyCapabilityTokenContext,
  ): Promise<CapabilityTokenVerificationResult> {
    const result = await this.verify(token, context);
    if (result.valid) {
      return result;
    }

    switch (result.errorCode) {
      case "MISSING_TOKEN":
      case "MALFORMED_TOKEN":
      case "UNSUPPORTED_VERSION":
      case "UNKNOWN_KEY_ID":
      case "INVALID_SIGNATURE":
      case "TOKEN_EXPIRED":
      case "TOKEN_NOT_YET_VALID":
      case "TOKEN_REVOKED":
      case "SUBJECT_REVOKED":
        throw new UnauthorizedException({
          errorCode: result.errorCode,
          message: result.message,
        });
      case "TOKEN_ALREADY_CONSUMED":
        throw new ConflictException({
          errorCode: result.errorCode,
          message: result.message,
        });
      case "SUBJECT_MISMATCH":
      case "SCOPE_ACTION_MISMATCH":
      case "SCOPE_RESOURCE_MISMATCH":
      case "CONSTRAINT_VIOLATION":
      default:
        throw new ForbiddenException({
          errorCode: result.errorCode,
          message: result.message,
        });
    }
  }

  /**
   * Execute a sensitive operation guarded by a capability token, automatically
   * rolling back token consumption if the operation throws before completing so
   * the caller can safely retry before the token expires.
   */
  async executeWithCapability<T>(
    token: string,
    context: VerifyCapabilityTokenContext,
    operation: (claims: CapabilityTokenClaims, verification: CapabilityTokenVerificationResult) => Promise<T>,
  ): Promise<T> {
    const verification = await this.verifyOrThrow(token, {
      ...context,
      consume: context.consume ?? true,
    });

    try {
      return await operation(verification.claims!, verification);
    } catch (error) {
      if (verification.consumed && verification.claims?.jti) {
        this.releaseConsumption(verification.claims.jti, context.idempotencyKey);
      }
      throw error;
    }
  }

  /**
   * Roll back a single consumption of `jti` when a downstream operation fails
   * prior to committing side effects, enabling safe retry within the token TTL.
   */
  releaseConsumption(jti: string, idempotencyKey?: string): boolean {
    const record = this.consumptions.get(jti);
    if (!record || record.count <= 0) {
      return false;
    }

    record.count -= 1;
    if (idempotencyKey?.trim()) {
      record.idempotencyKeys.delete(idempotencyKey.trim());
    }

    if (record.count === 0 && record.idempotencyKeys.size === 0) {
      this.consumptions.delete(jti);
    }

    this.logger.debug(`Released capability token consumption for jti=${jti}`);
    return true;
  }

  /**
   * Explicitly revoke a capability token by its `jti` until `expiresAtMs`.
   */
  async revokeToken(
    jti: string,
    expiresAtMs: number = Date.now() + MAX_CAPABILITY_TTL_SECONDS * 1000,
    reason?: string,
  ): Promise<void> {
    if (!jti?.trim()) {
      throw new BadRequestException("Token jti is required for revocation");
    }
    const normalizedJti = jti.trim();
    this.revocations.set(normalizedJti, {
      reason,
      revokedAtMs: Date.now(),
      expiresAtMs,
    });

    if (this.tokenBlacklistService) {
      await this.tokenBlacklistService.revoke(normalizedJti, expiresAtMs);
    }
  }

  /**
   * Revoke all capability tokens issued to `subject` at or before `cutoffSeconds`.
   */
  async revokeSubjectCapabilities(
    subject: string,
    cutoffSeconds: number = Math.floor(Date.now() / 1000),
  ): Promise<void> {
    if (!subject?.trim()) {
      throw new BadRequestException("Subject is required for capability revocation");
    }
    const normalizedSubject = subject.trim();
    const current = this.subjectCutoffs.get(normalizedSubject) ?? 0;
    const nextCutoff = Math.max(current, Math.floor(cutoffSeconds));
    this.subjectCutoffs.set(normalizedSubject, nextCutoff);

    if (this.tokenBlacklistService) {
      await this.tokenBlacklistService.revokeSubjectSessions(normalizedSubject, nextCutoff);
    }
  }

  private async isTokenRevoked(jti: string, nowMs: number): Promise<boolean> {
    const local = this.revocations.get(jti);
    if (local) {
      if (nowMs >= local.expiresAtMs) {
        this.revocations.delete(jti);
      } else {
        return true;
      }
    }

    if (this.tokenBlacklistService) {
      return this.tokenBlacklistService.isRevoked(jti);
    }

    return false;
  }

  private async isSubjectRevoked(subject: string, issuedAtSeconds: number): Promise<boolean> {
    const cutoff = this.subjectCutoffs.get(subject);
    if (cutoff !== undefined && issuedAtSeconds <= cutoff) {
      return true;
    }

    if (this.tokenBlacklistService) {
      return this.tokenBlacklistService.isSessionStale(subject, issuedAtSeconds);
    }

    return false;
  }

  private matchesAction(grantedAction: string, requiredAction: string): boolean {
    if (!grantedAction || !requiredAction) return false;
    if (grantedAction === requiredAction) return true;
    if (grantedAction.endsWith(".*")) {
      const prefix = grantedAction.slice(0, -1); // keep trailing dot
      return requiredAction.startsWith(prefix);
    }
    return false;
  }

  private matchesResource(
    scope: CapabilityScope,
    requiredType?: string,
    requiredId?: string,
  ): boolean {
    if (scope.resourceType) {
      if (!requiredType || scope.resourceType !== requiredType) {
        return false;
      }
    } else if (requiredType && scope.resourceId) {
      return false;
    }

    if (scope.resourceId && scope.resourceId !== "*") {
      if (!requiredId || scope.resourceId !== requiredId) {
        return false;
      }
    }

    return true;
  }

  private validateConstraints(
    constraints?: Record<string, CapabilityConstraintValue>,
    operationParams?: Record<string, CapabilityConstraintValue>,
  ): string | null {
    if (!constraints || Object.keys(constraints).length === 0) {
      return null;
    }

    const params = operationParams ?? {};

    for (const [key, limitOrExpected] of Object.entries(constraints)) {
      if (key.startsWith("max") && key.length > 3 && typeof limitOrExpected === "number") {
        const paramName = key.charAt(3).toLowerCase() + key.slice(4);
        const actual = params[paramName] ?? params[key];
        if (actual === undefined || typeof actual !== "number" || Number.isNaN(actual)) {
          return `Missing or non-numeric operation parameter "${paramName}" required by constraint "${key}"`;
        }
        if (actual > limitOrExpected) {
          return `Operation parameter "${paramName}" (${actual}) exceeds capability constraint "${key}" (${limitOrExpected})`;
        }
        continue;
      }

      if (key.startsWith("min") && key.length > 3 && typeof limitOrExpected === "number") {
        const paramName = key.charAt(3).toLowerCase() + key.slice(4);
        const actual = params[paramName] ?? params[key];
        if (actual === undefined || typeof actual !== "number" || Number.isNaN(actual)) {
          return `Missing or non-numeric operation parameter "${paramName}" required by constraint "${key}"`;
        }
        if (actual < limitOrExpected) {
          return `Operation parameter "${paramName}" (${actual}) is below capability constraint "${key}" (${limitOrExpected})`;
        }
        continue;
      }

      const actual = params[key];
      if (actual === undefined) {
        return `Missing required operation parameter "${key}" for capability constraint`;
      }
      if (actual !== limitOrExpected) {
        return `Operation parameter "${key}" ("${String(actual)}") does not match capability constraint ("${String(limitOrExpected)}")`;
      }
    }

    return null;
  }

  private sign(signingInput: string, secret: string): string {
    return createHmac("sha256", secret).update(signingInput).digest("base64url");
  }

  private safeSignatureEquals(provided: string, expected: string): boolean {
    const providedBuf = Buffer.from(provided, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (providedBuf.length !== expectedBuf.length) {
      return false;
    }
    return timingSafeEqual(providedBuf, expectedBuf);
  }

  private base64UrlEncode(input: string): string {
    return Buffer.from(input, "utf8").toString("base64url");
  }

  private base64UrlDecode(input: string): string {
    return Buffer.from(input, "base64url").toString("utf8");
  }

  private sweepExpiredState(nowMs: number): void {
    for (const [jti, record] of this.consumptions.entries()) {
      if (nowMs >= record.expiresAtMs) {
        this.consumptions.delete(jti);
      }
    }
    for (const [jti, record] of this.revocations.entries()) {
      if (nowMs >= record.expiresAtMs) {
        this.revocations.delete(jti);
      }
    }
  }

  private fail(
    errorCode: CapabilityTokenErrorCode,
    message: string,
    claims?: CapabilityTokenClaims,
    keyId?: string,
  ): CapabilityTokenVerificationResult {
    return {
      valid: false,
      errorCode,
      message,
      ...(claims ? { claims } : {}),
      ...(keyId ? { keyId } : {}),
    };
  }
}

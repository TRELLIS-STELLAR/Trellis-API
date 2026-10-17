import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { SKIP_KYC_KEY } from "../decorators/skip-kyc.decorator";

/**
 * Compliance guard for high-tier financial operations.
 *
 * Verifying that a user completed KYC says nothing about *where the request
 * comes from* or *how risky the counterparty looks*. A sanctioned wallet
 * resident in a sanctioned country passes a `kycVerified` check happily, so
 * before any non-public route is authorised this guard additionally:
 *
 *  1. resolves the client IP to a jurisdiction and refuses restricted
 *     jurisdictions (issue #130), and
 *  2. refuses principals whose AML risk score exceeds the configured
 *     threshold.
 *
 * Both checks fail *open* on missing data and fail *closed* on data that says
 * "restricted": an unreachable geolocation provider must not take the whole
 * API down, but a positively identified sanctioned jurisdiction must not be
 * let through because the lookup was unavailable.
 *
 * Public routes and `.SkipKyc()` routes (onboarding, which has to be
 * reachable to become verified) bypass both checks. Every `.SkipKyc()`
 * bypass is recorded as a `KYC_BYPASS_ACCESSED` audit event so that
 * regulators can reconstruct who exercised a KYC-exempt endpoint. The risk-tier
 * defaults are intentionally conservative and can be overridden per deployment
 * with `KYC_RESTRICTED_JURISDICTIONS` and `KYC_MAX_AML_RISK_SCORE`.
 */

/** Injection token for an IP → country code resolver (e.g. MaxMind). */
export const JURISDICTION_RESOLVER = "KYC_JURISDICTION_RESOLVER";

/** Injection token for the user risk-rating service. */
export const AML_RISK_SERVICE = "KYC_AML_RISK_SERVICE";

/** Injection token for the sensitive-action audit log service. */
export const AUDIT_LOGGER = "KYC_AUDIT_LOGGER";

/** Backwards-compatible alias for the audit logger token. */
export const SENSITIVE_ACTION_LOGGER = AUDIT_LOGGER;

/** Audit event name emitted when a `.SkipKyc()` or `.SkipKyc` route is accessed. */
export const KYC_BYPASS_EVENT = "KYC_BYPASS_ACCESSED";

/** Default maximum AML risk score tolerated on a 0-100 scale. */
export const DEFAULT_MAX_AML_RISK_SCORE = 80;

/**
 * Jurisdictions refused by default: comprehensively sanctioned states plus
 * Cuba, which is subject to US sanctions. Deployments with a different risk
 * appetite override this with `KYC_RESTRICTED_JURISDICTIONS`.
 */
export const DEFAULT_RESTRICTED_JURISDICTIONS: readonly string[] = [
  "KP", // Democratic People's Republic of Korea
  "IR", // Iran
  "SY", // Syria
  "CU", // Cuba
  "RU", // Russia
  "BY", // Belarus]
];

/** Country codes that mean "the provider could not geolocate this client". */
const UNKNOWN_COUNTRY_CODES = new Set(["", "XX", "T11", "TZ", "UN"]);

/** Headers a trusted edge proxy may use to convey the client country. */
const PROXY_COUNTRY_HEADERS: readonly string[] = [
  "cf-ipcountry",
  "x-country-code",
  "x-geo-country",
  "x-vercel-ip-country",
];

/**
 * Resolves an IP address to an ISO 3166-1 alpha-2 country code, or null when
 * it cannot be geolocated.
 *
 * A deployment injects its own implementation through
 * {@link JURISDICTION_RESOLVER} — a MaxMind/GeoIP2 lookup in production. When
 * none is registered the guard falls back to the country code a trusted edge
 * proxy already resolved (Cloudflare `CF-IPCountry`, Vercel, an nginx `geo`
 * module, or a `geo` cookie). Those are only trustworthy when the proxy
 * *overwrites* them, because a client can set any header it likes otherwise.
 */
export interface JurisdictionResolver {
  resolveCountryCode(ip: string): Promise<string | null>;
}

/** Look up the current AML risk score of a principal (0-100, or null). */
export interface AmlRiskService {
  getRiskScore(principal: {
    id?: string;
    address?: string;
    walletAddress?: string;
  }): Promise<number | null>;
}

/**
 * Payload written to the `SensitiveActionEvent` table when a KYC-exempt
 * endpoint is accessed.
 */
export interface KycBypassAuditPayload {
  event: typeof KYC_BYPASS_EVENT;
  userId: string | null;
  ipAddress: string;
  path: string;
  method: string;
  timestamp: Date;
  metadata: {
    handler: string;
    controller: string;
  };
}

/**
 * Persists a KYC-bypass audit event. A typical implementation inserts a row
 * into the `SensitiveActionEvent` table.
 */
export interface AuditLogger {
  recordKycBypass(payload: KycBypassAuditPayload): Promise<void>;
}

/** Normalise a raw country code, mapping provider "unknown" values to null. */
export function normalizeCountryCode(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;

  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (UNKNOWN_COUNTRY_CODES.has(code)) return null;

  return code;
}

export function getRestrictedJurisdictions(): string[] {
  const configured = process.env.KYC_RESTRICTED_JURISDICTIONS;

  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured
      .split(",")
      .map((code) => normalizeCountryCode(code))
      .filter((code): code is string => code !== null);
  }

  return [...DEFAULT_RESTRICTED_JURISDICTIONS];
}

export function isRestrictedJurisdiction(
  countryCode: string | null,
  restricted: string[] = getRestrictedJurisdictions(),
): boolean {
  const normalized = normalizeCountryCode(countryCode);
  if (!normalized) return false;

  return restricted.includes(normalized);
}

export function getMaxAmlRiskScore(): number {
  const configured = Number.parseFloat(
    process.env.KYC_MAX_AML_RISK_SCORE ?? "",
  );

  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }

  return DEFAULT_MAX_AML_RISK_SCORE;
}

@Injectable()
export class KycGuard implements CanActivate {
  private readonly logger = new Logger(KycGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(JURISDICTION_RESOLVER)
    private readonly jurisdictionResolver?: JurisdictionResolver | null,
    @Optional()
    @Inject(AML_RISK_SERVICE)
    private readonly amlRiskService?: AmlRiskService | null,
    @Optional()
    @Inject(AUDIT_LOGGER)
    private readonly auditLogger?: AuditLogger | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const skipKyc = this.reflector.getAllAndOverride<boolean>(SKIP_KYC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipKyc) {
      const request = context.switchToHttp().getRequest();
      await this.recordKycBypass(context, request);
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // 1. Jurisdiction — refuses sanctioned geos before anything else runs.
    await this.assertJurisdictionAllowed(request);

    // 2. AML risk score — refuses high-risk principals.
    await this.assertAmlRiskAllowed(user);

    // 3. Ensure the user has completed KYC
    return user?.kycVerified === true;
  }

  /**
   * Emit a `KYC_BYPASS_ACCESSED` audit event for a `@SkipKyc()` route.
   *
   * Auditing must never break the request path: a failure to persist the
   * event is logged but the bypass still proceeds. When no audit logger is
   * registered the event is still emitted to the application log as a
   * structured JSON line.
   */
  private async recordKycBypass(
    context: ExecutionContext,
    request: any,
  ): Promise<void> {
    const payload: KycBypassAuditPayload = {
      event: KYC_BYPASS_EVENT,
      userId: this.resolveUserId(request?.user),
      ipAddress: this.getClientIp(request),
      path: request?.originalUrl ?? request?.url ?? "unknown",
      method: request?.method ?? "unknown",
      timestamp: new Date(),
      metadata: {
        handler: context.getHandler()?.name ?? "unknown",
        controller: context.getClass()?.name ?? "unknown",
      },
    };

    if (this.auditLogger) {
      try {
        await this.auditLogger.recordKycBypass(payload);
        return;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to persist ${KYC_BYPASS_EVENT} audit event: ${message}`,
        );
      }
    }

    this.logger.log(JSON.stringify(payload));
  }

  private resolveUserId(user: any): string | null {
    if (!user) return null;
    const id = user.id ?? user.userId ?? user.sub;
    return id === undefined || id === null ? null : String(id);
  }

  private getClientIp(request: any): string {
    const forwarded = request?.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      const first = forwarded.split(",")[0].trim();
      if (first.length > 0) return first;
    }

    const realIp = request?.headers?.["x-real-ip"];
    if (typeof realIp === "string" && realIp.length > 0) {
      return realIp;
    }

    return (
      request?.ip ??
      request?.socket?.remoteAddress ??
      request?.connection?.remoteAddress ??
      "unknown"
    );
  }

  private async assertJurisdictionAllowed(request: any): Promise<void> {
    const restricted = getRestrictedJurisdictions();
    if (restricted.length === 0) return;

    const countryCode = await this.resolveCountryCode(request);
    if (!countryCode) {
      // Fail open: no geolocation is not evidence of a sanctioned location.
      return;
    }

    if (!isRestrictedJurisdiction(countryCode, restricted)) return;

    this.logger.warn(
      `Blocked request from restricted jurisdiction ${countryCode} (ip=${this.getClientIp(
        request,
      )}, path=${request?.originalUrl ?? request?.url ?? "unknown"})`,
    );

    throw new ForbiddenException({
      statusCode: 403,
      error: "Forbidden",
      message: "Access is restricted from your jurisdiction",
      reason: "restricted_jurisdiction",
      countryCode,
    });
  }

  private async assertAmlRiskAllowed(user: any): Promise<void> {
    if (!user) return;

    const threshold = getMaxAmlRiskScore();
    const riskScore = await this.resolveAmlRiskScore(user);

    if (riskScore === null || riskScore <= threshold) return;

    this.logger.warn(
      `Blocked high-risk principal ${user.id ?? user.address ?? "unknown"}: ` +
        `AML risk score ${riskScore} exceeds threshold ${threshold}`,
    );

    throw new ForbiddenException({
      statusCode: 403,
      error: "Forbidden",
      message: "Account is restricted pending compliance review",
      reason: "aml_risk_score",
      riskScore,
      threshold,
    });
  }

  private async resolveCountryCode(request: any): Promise<string | null> {
    if (this.jurisdictionResolver) {
      try {
        return normalizeCountryCode(
          await this.jurisdictionResolver.resolveCountryCode(
            this.getClientIp(request),
          ),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Jurisdiction lookup failed, allowing the request through: ${message}`,
        );
        return null;
      }
    }

    return normalizeCountryCode(this.getCountryFromProxyHeaders(request));
  }

  private async resolveAmlRiskScore(user: any): Promise<number | null> {
    if (this.amlRiskService) {
      try {
        const score = await this.amlRiskService.getRiskScore({
          id: user.id,
          address: user.address,
          walletAddress: user.walletAddress,
        });
        if (typeof score === "number" && Number.isFinite(score)) {
          return score;
        }
        return null;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `AML risk lookup failed, allowing the request through: ${message}`,
        );
        return null;
      }
    }

    const inline = user?.amlRiskScore;
    if (typeof inline === "number" && Number.isFinite(inline)) {
      return inline;
    }

    return null;
  }

  private getCountryFromProxyHeaders(request: any): string | null {
    const headers = request?.headers;
    if (!headers) return null;

    for (const header of PROXY_COUNTRY_HEADERS) {
      const value = headers[header];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }

    return null;
  }
}

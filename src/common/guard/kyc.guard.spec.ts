import { Test, TestingModule } from "@nestjs/testing";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  AML_RISK_SERVICE,
  AUDIT_LOGGER,
  DEFAULT_MAX_AML_RISK_SCORE,
  DEFAULT_RESTRICTED_JURISDICTIONS,
  JURISDICTION_RESOLVER,
  KYC_BYPASS_EVENT,
  KycGuard,
  SENSITIVE_ACTION_LOGGER_TOKEN,
  isRestrictedJurisdiction,
  normalizeCountryCode,
} from "./kyc.guard";

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => "http",
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function mockReflector(metadata: { isPublic?: boolean; skipKyc?: boolean }) {
  return {
    getAllAndOverride: (key: string) => {
      if (key === "isPublic") return metadata.isPublic ?? false;
      if (key === "skipKyc") return metadata.skipKyc ?? false;
      return undefined;
    },
  } as unknown as Reflector;
}

async function makeGuard(
  options: {
    isPublic?: boolean;
    skipKyc?: boolean;
    jurisdictionResolver?: { resolveCountryCode: jest.Mock };
    amlRiskService?: { getRiskScore: jest.Mock };
    sensitiveActionLogger?: { recordKycBypass: jest.Mock };
  } = {},
): Promise<KycGuard> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      KycGuard,
      { provide: Reflector, useValue: mockReflector(options) },
      {
        provide: JURISDICTION_RESOLVER,
        useValue: options.jurisdictionResolver ?? null,
      },
      { provide: AML_RISK_SERVICE, useValue: options.amlRiskService ?? null },
      {
        provide: AUDIT_LOGGER,
        useValue: options.sensitiveActionLogger ?? {
          recordKycBypass: jest.fn().mockResolved(undefined),
        },
      },
    ],
  }).compile();

  return module.get<KycGuard>(KycGuard);
}

const VERIFIED_USER = { id: "u1", address: "0xabc", kycVerified: true };

describe("KycGuard", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  describe("country code helpers", () => {
    it("normalises lower case and mixed case codes", () => {
      expect(normalizeCountryCode("kp")).toBe("KP");
      expect(normalizeCountryCode(" ir ")).toBe("IR");
    });

    it("treats provider placeholder codes as unknown", () => {
      expect(normalizeCountryCode("XX")).toBeNull();
      expect(normalizeCountryCode("T1")).toBeNull();
      expect(normalizeCountryCode("")).toBeNull();
      expect(normalizeCountryCode(undefined)).toBeNull();
      expect(normalizeCountryCode("USA")).toBeNull();
    });

    it("matches the default restricted list case-insensitively", () => {
      expect(isRestrictedJurisdiction("kp")).toBe(true);
      expect(isRestrictedJurisdiction("IR")).toBe(true);
      expect(isRestrictedJurisdiction("DE")).toBe(false);
      expect(isRestrictedJurisdiction(null)).toBe(false);
    });

    it("honours an operator-supplied restricted list", () => {
      process.env.KYC_RESTRICTED_JURISDICTIONS = "de, fr";
      expect(isRestrictedJurisdiction("DE")).toBe(true);
      expect(isRestrictedJurisdiction("IR")).toBe(false);
    });
  });

  describe("existing behaviour", () => {
    it("passes non-http contexts through", async () => {
      const guard = await makeGuard();
      const context = { getType: () => "ws" } as unknown as ExecutionContext;

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it("passes public routes through", async () => {
      const guard = await makeGuard({ isPublic: true });

      await expect(guard.canActivate(makeContext({ body: {} }))).resolves.toBe(true);
    });

    it("passes @SkipKyc() routes through, even from a sanctioned geo", async () => {
      const guard = await makeGuard({ skipKyc: true });

      await expect(
        guard.canActivate(
          makeContext({
            headers: { "cf-ipcountry": "KP" },
            user: VERIFIED_USER,
          }),
        ),
      ).resolves.toBe(true);
    });

    it("allows a verified user from a permitted jurisdiction", async () => {
      const guard = await makeGuard();

      await expect(
        guard.canActivate(
          makeContext({
            headers: { "cf-ipcountry": "DE" },
            user: VERIFIED_USER,
          }),
        ),
      ).resolves.toBe(true);
    });

    it("still denies an unverified user", async () => {
      const guard = await makeGuard();

      await expect(
        guard.canActivate(
          makeContext({ headers: {}, user: { id: "u1", kycVerified: false } }),
        ),
      ).resolves.toBe(false);
    });
  });

  describe("skip-kyc audit logging", () => {
    it("emits a KYC_BYPASS_ACCESSED audit event with user and path context", async () => {
      const sensitiveActionLogger = {
        recordKycBypass: jest.fn().mockResolved(undefined),
      };
      const guard = await makeGuard({ skipKyc: true, sensitiveActionLogger });

      await expect(
        guard.canActivate(
          makeContext({
            headers: { "cf-ipcountry": "KP", "x-forwarded-for": "203.0.113.10" },
            ip: "203.0.113.10",
            originalUrl: "/payments/withdraw",
            method: "POST",
            user: VERIFIED_USER,
          }),
        ),
      ).resolves.toBe(true);

      expect(sensitiveActionLogger.recordKycBypass).toHaveBeenCalledTimes(1);
      expect(sensitiveActionLogger.recordKycBypass).toHaveBeenCalledWith(
        expect.objectContaining({
          event: KYC_BYPASS_EVENT,
          userId: "u1",
          ipAddress: "203.0.113.10",
          path: "/payments/withdraw",
          method: "POST",
          timestamp: expect.any(Date),
        }),
      );
    });

    it("emits a bypass event even when no user is attached", async () => {
      const sensitiveActionLogger = {
        recordKycBypass: jest.fn().mockResolved(undefined),
      };
      const guard = await makeGuard({ skipKyc: true, sensitiveActionLogger });

      await expect(
        guard.canActivate(
          makeContext({
            headers: {},
            ip: "198.51.100.9",
            originalUrl: "/public/health",
            method: "GET",
          }),
        ),
      ).resolves.toBe(true);

      expect(sensitiveActionLogger.recordKycBypass).toHaveBeenCalledWith(
        expect.objectContaining({
          event: KYC_BYPASS_EVENT,
          userId: null,
          ipAddress: "198.51.100.9",
          path: "/public/health",
          method: "GET",
          timestamp: expect.any(Date),
        }),
      );
    });

    it("does not emit a bypass event for non-skip-kyc routes", async () => {
      const sensitiveActionLogger = {
        recordKycBypass: jest.fn().mockResolved(undefined),
      };
      const guard = await makeGuard({ sensitiveActionLogger });

      await expect(
        guard.canActivate(makeContext({ headers: {}, user: VERIFIED_USER })),
      ).resolves.toBe(true);

      expect(sensitiveActionLogger.recordKycBypass).not.toHaveBeenCalled();
    });

    it("still allows the request when the audit logger throws", async () => {
      const sensitiveActionLogger = {
        recordKycBypass: jest.fn().mockRejected(new Error("db down")),
      };
      const guard = await makeGuard({ skipKyc: true, sensitiveActionLogger });

      await expect(
        guard.canActivate(
          makeContext({
            headers: {},
            ip: "203.0.113.10",
            originalUrl: "/onboarding",
            method: "POST",
            user: VERIFIED_USER,
          }),
        ),
      ).resolves.toBe(true);
    });
  });

  describe("jurisdiction restrictions", () => {
    it("blocks a request from a sanctioned country with 403", async () => {
      const guard = await makeGuard();

      const error = await guard
        .canActivate(
          makeContext({
            headers: { "cf-ipcountry": "KP", "x-forwarded-for": "203.0.113.10" },
            ip: "203.0.113.10",
            user: VERIFIED_USER,
          }),
        )
        .catch((e) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getStatus()).toBe(403);
      expect(error.getResponse()).toMatchObject({
        reason: "restricted_jurisdiction",
        countryCode: "KP",
      });
    });

    it("blocks every default restricted jurisdiction", async () => {
      const guard = await makeGuard();

      for (const code of DEFAULT_RESTRICTED_JURISDICTIONS) {
        await expect(
          guard.canActivate(
            makeContext({
              headers: { "cf-ipcountry": code },
              user: VERIFIED_USER,
            }),
          ),
        ).rejects.toThrow(ForbiddenException);
      }
    });

    it("accepts the country code from any trusted proxy header", async () => {
      const guard = await makeGuard();

      for (const header of [
        "cf-ipcountry",
        "x-vercel-ip-country",
        "x-geo-country",
        "x-country-code",
      ]) {
        await expect(
          guard.canActivate(
            makeContext({
              headers: { [header]: "IR" },
              user: VERIFIED_USER,
            }),
          ),
        ).rejects.toThrow(ForbiddenException);
      }
    });

    it("prefers an injected MaxMind-backed resolver over the headers", async () => {
      const jurisdictionResolver = {
        resolveCountryCode: jest.fn().mockResolved("SY"),
      };
      const guard = await makeGuard({ jurisdictionResolver });

      await expect(
        guard.canActivate(
          makeContext({
            headers: { "cf-ipcountry": "DE" },
            ip: "198.51.100.5",
            user: VERIFIED_USER,
          }),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(jurisdictionResolver.resolveCountryCode).toHaveBeenCalledWith(
        "198.51.100.5",
      );
    });

    it("resolves the client IP from the left-most x-forwarded-for entry", async () => {
      const jurisdictionResolver = {
        resolveCountryCode: jest.fn().mockResolved("BY"),
      };
      const guard = await makeGuard({ jurisdictionResolver });

      await expect(
        guard.canActivate(
          makeContext({
            headers: { "x-forwarded-for": "192.0.2.7, 10.0.0.1" },
            user: VERIFIED_USER,
          }),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(jurisdictionResolver.resolveCountryCode).toHaveBeenCalledWith(
        "192.0.2.7",
      );
    });

    it("fails open when the client cannot be geolocated", async () => {
      const jurisdictionResolver = {
        resolveCountryCode: jest.fn().mockResolved(null),
      };
      const guard = await makeGuard({ jurisdictionResolver });

      await expect(
        guard.canActivate(makeContext({ headers: {}, user: VERIFIED_USER })),
      ).resolves.toBe(true);
    });

    it("fails open when the lookup itself fails", async () => {
      const jurisdictionResolver = {
        resolveCountryCode: jest.fn().mockRejected(new Error("timeout")),
      };
      const guard = await makeGuard({ jurisdictionResolver });

      await expect(
        guard.canActivate(makeContext({ headers: {}, user: VERIFIED_USER })),
      ).resolves.toBe(true);
    });
  });

  describe("AML risk score", () => {
    it("blocks a principal above the threshold with 403", async () => {
      const guard = await makeGuard();

      const error = await guard
        .canActivate(
          makeContext({
            headers: {},
            user: { ...VERIFIED_USER, amlRiskScore: 91 },
          }),
        )
        .catch((e) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getStatus()).toBe(403);
      expect(error.getResponse()).toMatchObject({
        reason: "aml_risk_score",
        riskScore: 91,
        threshold: DEFAULT_MAX_AML_RISK_SCORE,
      });
    });

    it("allows a principal exactly at the threshold", async () => {
      const guard = await makeGuard();

      await expect(
        guard.canActivate(
          makeContext({
            headers: {},
            user: { ...VERIFIED_USER, amlRiskScore: DEFAULT_MAX_AML_RISK_SCORE },
          }),
        ),
      ).resolves.toBe(true);
    });

    it("uses the injected AML risk service when available", async () => {
      const amlRiskService = {
        getRiskScore: jest.fn().mockResolved(95),
      };
      const guard = await makeGuard({ amlRiskService });

      await expect(
        guard.canActivate(
          makeContext({ headers: {}, user: VERIFIED_USER }),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(amlRiskService.getRiskScore).toHaveBeenCalled();
    });
  });
});

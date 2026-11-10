import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { SensitiveAction } from "../../../infrastructure/audit/sensitive-actions/sensitive-action.enum";
import { TokenBlacklistService } from "../token-blacklist.service";
import { CapabilityTokenService } from "./capability-token.service";
import {
  MAX_CAPABILITY_TTL_SECONDS,
  MIN_CAPABILITY_TTL_SECONDS,
} from "./capability-token.types";

describe("CapabilityTokenService (issue #273)", () => {
  const baseNowMs = 1_700_000_000_000;

  function createService(opts?: {
    blacklist?: TokenBlacklistService;
    clockSkewSeconds?: number;
  }) {
    return new CapabilityTokenService(undefined, opts?.blacklist, {
      activeKeyId: "cap-key-2026-01",
      keys: {
        "cap-key-2026-01": "test-hmac-secret-primary-key-01",
        "cap-key-2025-12": "test-hmac-secret-legacy-key-00",
      },
      clockSkewSeconds: opts?.clockSkewSeconds ?? 0,
    });
  }

  describe("normal issuance and verification", () => {
    it("issues, verifies, and consumes a single-use capability token", async () => {
      const service = createService();
      const issued = service.issueToken({
        subject: "user-123",
        scope: {
          action: SensitiveAction.WITHDRAWAL_APPROVED,
          resourceType: "withdrawal",
          resourceId: "wd-99",
          constraints: {
            maxAmount: 5000,
            asset: "USDC",
          },
        },
        ttlSeconds: 120,
        reason: "Step-up MFA confirmed for withdrawal",
        correlationId: "corr-abc",
        nowMs: baseNowMs,
      });

      expect(issued.token.startsWith("cap_v1.")).toBe(true);
      expect(issued.claims.sub).toBe("user-123");
      expect(issued.claims.singleUse).toBe(true);
      expect(issued.claims.maxUses).toBe(1);

      const verification = await service.verify(issued.token, {
        expectedSubject: "user-123",
        requiredAction: SensitiveAction.WITHDRAWAL_APPROVED,
        resourceType: "withdrawal",
        resourceId: "wd-99",
        operationParams: {
          amount: 2500,
          asset: "USDC",
        },
        nowMs: baseNowMs + 30_000,
      });

      expect(verification.valid).toBe(true);
      expect(verification.consumed).toBe(true);
      expect(verification.remainingUses).toBe(0);
      expect(verification.claims?.jti).toBe(issued.jti);
    });

    it("supports wildcard action prefix and wildcard resourceId when explicitly granted", async () => {
      const service = createService();
      const issued = service.issueToken({
        subject: "maintainer-1",
        scope: {
          action: "treasury.*",
          resourceType: "withdrawal",
          resourceId: "*",
        },
        singleUse: false,
        maxUses: 2,
        nowMs: baseNowMs,
      });

      const first = await service.verify(issued.token, {
        expectedSubject: "maintainer-1",
        requiredAction: SensitiveAction.WITHDRAWAL_APPROVED,
        resourceType: "withdrawal",
        resourceId: "wd-1",
        nowMs: baseNowMs + 1000,
      });
      const second = await service.verify(issued.token, {
        expectedSubject: "maintainer-1",
        requiredAction: SensitiveAction.WITHDRAWAL_REJECTED,
        resourceType: "withdrawal",
        resourceId: "wd-2",
        nowMs: baseNowMs + 2000,
      });
      const third = await service.verify(issued.token, {
        expectedSubject: "maintainer-1",
        requiredAction: SensitiveAction.WITHDRAWAL_APPROVED,
        resourceType: "withdrawal",
        resourceId: "wd-3",
        nowMs: baseNowMs + 3000,
      });

      expect(first.valid).toBe(true);
      expect(first.remainingUses).toBe(1);
      expect(second.valid).toBe(true);
      expect(second.remainingUses).toBe(0);
      expect(third.valid).toBe(false);
      expect(third.errorCode).toBe("TOKEN_ALREADY_CONSUMED");
    });

    it("verifies tokens signed with a previous key during key rotation", async () => {
      const service = createService();
      const issuedBeforeRotation = service.issueToken({
        subject: "user-rotate",
        scope: { action: SensitiveAction.API_KEY_CREATED },
        nowMs: baseNowMs,
      });

      service.rotateKey("cap-key-2026-02", "test-hmac-secret-rotated-key-02", true);

      const issuedAfterRotation = service.issueToken({
        subject: "user-rotate",
        scope: { action: SensitiveAction.API_KEY_REVOKED },
        nowMs: baseNowMs,
      });

      expect(issuedBeforeRotation.keyId).toBe("cap-key-2026-01");
      expect(issuedAfterRotation.keyId).toBe("cap-key-2026-02");

      const resOld = await service.verify(issuedBeforeRotation.token, {
        expectedSubject: "user-rotate",
        requiredAction: SensitiveAction.API_KEY_CREATED,
        nowMs: baseNowMs + 5000,
      });
      const resNew = await service.verify(issuedAfterRotation.token, {
        expectedSubject: "user-rotate",
        requiredAction: SensitiveAction.API_KEY_REVOKED,
        nowMs: baseNowMs + 5000,
      });

      expect(resOld.valid).toBe(true);
      expect(resNew.valid).toBe(true);
    });
  });

  describe("expiration, not-before, and issuance validation paths", () => {
    it("rejects TTL outside allowed bounds", () => {
      const service = createService();
      expect(() =>
        service.issueToken({
          subject: "user-1",
          scope: { action: SensitiveAction.USER_DELETED },
          ttlSeconds: MIN_CAPABILITY_TTL_SECONDS - 1,
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        service.issueToken({
          subject: "user-1",
          scope: { action: SensitiveAction.USER_DELETED },
          ttlSeconds: MAX_CAPABILITY_TTL_SECONDS + 1,
        }),
      ).toThrow(BadRequestException);
    });

    it("rejects expired tokens and respects configured clock skew", async () => {
      const strictService = createService({ clockSkewSeconds: 0 });
      const skewTolerantService = createService({ clockSkewSeconds: 10 });

      const issued = strictService.issueToken({
        subject: "user-exp",
        scope: { action: SensitiveAction.PASSWORD_CHANGED },
        ttlSeconds: 60,
        nowMs: baseNowMs,
      });

      const expiredStrict = await strictService.verify(issued.token, {
        expectedSubject: "user-exp",
        requiredAction: SensitiveAction.PASSWORD_CHANGED,
        nowMs: baseNowMs + 60_000,
      });
      expect(expiredStrict.valid).toBe(false);
      expect(expiredStrict.errorCode).toBe("TOKEN_EXPIRED");

      const withinSkew = await skewTolerantService.verify(issued.token, {
        expectedSubject: "user-exp",
        requiredAction: SensitiveAction.PASSWORD_CHANGED,
        nowMs: baseNowMs + 65_000,
      });
      expect(withinSkew.valid).toBe(true);
    });

    it("rejects tokens presented before their nbf timestamp", async () => {
      const service = createService();
      const iatSeconds = Math.floor(baseNowMs / 1000);
      const issued = service.issueToken({
        subject: "user-nbf",
        scope: { action: SensitiveAction.ROLE_ASSIGNED },
        ttlSeconds: 120,
        notBeforeSeconds: iatSeconds + 30,
        nowMs: baseNowMs,
      });

      const early = await service.verify(issued.token, {
        expectedSubject: "user-nbf",
        requiredAction: SensitiveAction.ROLE_ASSIGNED,
        nowMs: baseNowMs + 10_000,
      });
      expect(early.valid).toBe(false);
      expect(early.errorCode).toBe("TOKEN_NOT_YET_VALID");

      const onTime = await service.verify(issued.token, {
        expectedSubject: "user-nbf",
        requiredAction: SensitiveAction.ROLE_ASSIGNED,
        nowMs: baseNowMs + 31_000,
      });
      expect(onTime.valid).toBe(true);
    });
  });

  describe("tampering, malformed, andauthorization failure paths", () => {
    it("rejects missing, malformed, or tampered tokens", async () => {
      const service = createService();
      const issued = service.issueToken({
        subject: "user-1",
        scope: {
          action: SensitiveAction.WITHDRAWAL_APPROVED,
          resourceType: "withdrawal",
          resourceId: "wd-1",
        },
        nowMs: baseNowMs,
      });

      const missing = await service.verify("", {
        requiredAction: SensitiveAction.WITHDRAWAL_APPROVED,
      });
      expect(missing.errorCode).toBe("MISSING_TOKEN");

      const malformed = await service.verify("not-a-valid-token", {
        requiredAction: SensitiveAction.WITHDRAWAL_APPROVED,
      });
      expect(malformed.errorCode).toBe("MALFORMED_TOKEN");

      // Tamper with claims payload to escalate resourceId
      const parts = issued.token.split(".");
      const decodedClaims = JSON.parse(
        Buffer.from(parts[2], "base64url").toString("utf8"),
      );
      decodedClaims.scope.resourceId = "wd-victim";
      const tamperedClaims = Buffer.from(
        JSON.stringify(decodedClaims),
        "utf8",
      ).toString("base64url");
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedClaims}.${parts[3]}`;

      const tamperedResult = await service.verify(tamperedToken, {
        expectedSubject: "user-1",
        requiredAction: SensitiveAction.WITHDRAWAL_APPROVED,
        resourceType: "withdrawal",
        resourceId: "wd-victim",
        nowMs: baseNowMs + 1000,
      });
      expect(tamperedResult.valid).toBe(false);
      expect(tamperedResult.errorCode).toBe("INVALID_SIGNATURE");
    });

    it("enforces subject, action, resource, and numeric/scalar constraints", async () => {
      const service = createService();
      const issued = service.issueToken({
        subject: "user-owner",
        scope: {
          action: SensitiveAction.PAYOUT_INITIATED,
          resourceType: "portfolio",
          resourceId: "pf-100",
          constraints: {
            maxAmount: 1000,
            minAmount: 50,
            destination: "GABC123",
          },
        },
        singleUse: false,
        maxUses: 5,
        nowMs: baseNowMs,
      });

      const wrongSubject = await service.verify(issued.token, {
        expectedSubject: "user-attacker",
        requiredAction: SensitiveAction.PAYOUT_INITIATED,
        resourceType: "portfolio",
        resourceId: "pf-100",
        operationParams: { amount: 500, destination: "GABC123" },
        nowMs: baseNowMs + 1000,
      });
      expect(wrongSubject.errorCode).toBe("SUBJECT_MISMATCH");

      const wrongAction = await service.verify(issued.token, {
        expectedSubject: "user-owner",
        requiredAction: SensitiveAction.USER_DELETED,
        resourceType: "portfolio",
        resourceId: "pf-100",
        operationParams: { amount: 500, destination: "GABC123" },
        nowMs: baseNowMs + 1000,
      });
      expect(wrongAction.errorCode).toBe("SCOPE_ACTION_MISMATCH");

      const wrongResource = await service.verify(issued.token, {
        expectedSubject: "user-owner",
        requiredAction: SensitiveAction.PAYOUT_INITIATED,
        resourceType: "portfolio",
        resourceId: "pf-999",
        operationParams: { amount: 500, destination: "GABC123" },
        nowMs: baseNowMs + 1000,
      });
      expect(wrongResource.errorCode).toBe("SCOPE_RESOURCE_MISMATCH");

      const exceedsMax = await service.verify(issued.token, {
        expectedSubject: "user-owner",
        requiredAction: SensitiveAction.PAYOUT_INITIATED,
        resourceType: "portfolio",
        resourceId: "pf-100",
        operationParams: { amount: 2000, destination: "GABC123" },
        nowMs: baseNowMs + 1000,
      });
      expect(exceedsMax.errorCode).toBe("CONSTRAINT_VIOLATION");

      const belowMin = await service.verify(issued.token, {
        expectedSubject: "user-owner",
        requiredAction: SensitiveAction.PAYOUT_INITIATED,
        resourceType: "portfolio",
        resourceId: "pf-100",
        operationParams: { amount: 10, destination: "GABC123" },
        nowMs: baseNowMs + 1000,
      });
      expect(belowMin.errorCode).toBe("CONSTRAINT_VIOLATION");

      const wrongDestination = await service.verify(issued.token, {
        expectedSubject: "user-owner",
        requiredAction: SensitiveAction.PAYOUT_INITIATED,
        resourceType: "portfolio",
        resourceId: "pf-100",
        operationParams: { amount: 500, destination: "GXYZ999" },
        nowMs: baseNowMs + 1000,
      });
      expect(wrongDestination.errorCode).toBe("CONSTRAINT_VIOLATION");
    });
  });

  describe("retry, rollback, and revocation behavior", () => {
    it("allows idempotent retry with matching idempotencyKey while blocking replay with a different key", async () => {
      const service = createService();
      const issued = service.issueToken({
        subject: "user-retry",
        scope: {
          action: SensitiveAction.WITHDRAWAL_APPROVED,
          resourceType: "withdrawal",
          resourceId: "wd-retry-1",
        },
        nowMs: baseNowMs,
      });

      const first = await service.verify(issued.token, {
        expectedSubject: "user-retry",
        requiredAction: SensitiveAction.WITHDRAWAL_APPROVED,
        resourceType: "withdrawal",
        resourceId: "wd-retry-1",
        idempotencyKey: "idem-req-1",
        nowMs: baseNowMs + 1000,
      });
      expect(first.valid).toBe(true);
      expect(first.consumed).toBe(true);
      expect(first.idempotentReplay).toBe(false);

      // Safe network retry carrying the same idempotencyKey
      const retrySameKey = await service.verify(issued.token, {
        expectedSubject: "user-retry",
        requiredAction: SensitiveAction.WITHDRAWAL_APPROVED,
        resourceType: "withdrawal",
        resourceId: "wd-retry-1",
        idempotencyKey: "idem-req-1",
        nowMs: baseNowMs + 2000,
      });
      expect(retrySameKey.valid).toBe(true);
      expect(retrySameKey.consumed).toBe(false);
      expect(retrySameKey.idempotentReplay).toBe(true);

      // Replay attempt with a different idempotencyKey is rejected
      const replayDifferentKey = await service.verify(issued.token, {
        expectedSubject: "user-retry",
        requiredAction: SensitiveAction.WITHDRAWAL_APPROVED,
        resourceType: "withdrawal",
        resourceId: "wd-retry-1",
        idempotencyKey: "idem-req-2",
        nowMs: baseNowMs + 3000,
      });
      expect(replayDifferentKey.valid).toBe(false);
      expect(replayDifferentKey.errorCode).toBe("TOKEN_ALREADY_CONSUMED");
    });

    it("rolls back consumption via executeWithCapability when the downstream action fails", async () => {
      const service = createService();
      const issued = service.issueToken({
        subject: "user-rollback",
        scope: {
          action: SensitiveAction.CONTRACT_UPGRADED,
          resourceType: "contract",
          resourceId: "soroban-core",
        },
        nowMs: baseNowMs,
      });

      let attempts = 0;
      await expect(
        service.executeWithCapability(
          issued.token,
          {
            expectedSubject: "user-rollback",
            requiredAction: SensitiveAction.CONTRACT_UPGRADED,
            resourceType: "contract",
            resourceId: "soroban-core",
            nowMs: baseNowMs + 1000,
          },
          async () => {
            attempts += 1;
            throw new Error("Transient RPC timeout before submission");
          },
        ),
      ).rejects.toThrow("Transient RPC timeout before submission");

      // Because consumption was rolled back on failure, the retry succeeds:
      const result = await service.executeWithCapability(
        issued.token,
        {
          expectedSubject: "user-rollback",
          requiredAction: SensitiveAction.CONTRACT_UPGRADED,
          resourceType: "contract",
          resourceId: "soroban-core",
          nowMs: baseNowMs + 2000,
        },
        async (claims) => {
          attempts += 1;
          return { upgradedBy: claims.sub, jti: claims.jti };
        },
      );

      expect(attempts).toBe(2);
      expect(result.upgradedBy).toBe("user-rollback");

      // Subsequent attempt after successful execution is rejected as consumed:
      await expect(
        service.verifyOrThrow(issued.token, {
          expectedSubject: "user-rollback",
          requiredAction: SensitiveAction.CONTRACT_UPGRADED,
          resourceType: "contract",
          resourceId: "soroban-core",
          nowMs: baseNowMs + 3000,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("honours explicit token revocation and subject-wide capability cutoffs", async () => {
      const blacklist = new TokenBlacklistService(null);
      const service = createService({ blacklist });

      const tokenA = service.issueToken({
        subject: "user-sec",
        scope: { action: SensitiveAction.USER_DATA_EXPORTED },
        nowMs: baseNowMs,
      });
      const tokenB = service.issueToken({
        subject: "user-sec",
        scope: { action: SensitiveAction.AUDIT_LOG_EXPORTED },
        nowMs: baseNowMs,
      });

      await service.revokeToken(tokenA.jti, baseNowMs + 600_000, "Operator cancelled export");

      await expect(
        service.verifyOrThrow(tokenA.token, {
          expectedSubject: "user-sec",
          requiredAction: SensitiveAction.USER_DATA_EXPORTED,
          nowMs: baseNowMs + 1000,
        }),
      ).rejects.toThrow(UnauthorizedException);

      // Revoke all capabilities for user-sec issued at or before baseNowMs / 1000
      await service.revokeSubjectCapabilities(
        "user-sec",
        Math.floor(baseNowMs / 1000),
      );

      const resB = await service.verify(tokenB.token, {
        expectedSubject: "user-sec",
        requiredAction: SensitiveAction.AUDIT_LOG_EXPORTED,
        nowMs: baseNowMs + 1000,
      });
      expect(resB.valid).toBe(false);
      expect(resB.errorCode).toBe("SUBJECT_REVOKED");

      await blacklist.onModuleDestroy();
    });

    it("maps verification errors to HTTP exceptions via verifyOrThrow", async () => {
      const service = createService();
      const issued = service.issueToken({
        subject: "user-1",
        scope: { action: SensitiveAction.ROLE_ASSIGNED },
        nowMs: baseNowMs,
      });

      await expect(
        service.verifyOrThrow(undefined, {
          requiredAction: SensitiveAction.ROLE_ASSIGNED,
        }),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        service.verifyOrThrow(issued.token, {
          expectedSubject: "user-2",
          requiredAction: SensitiveAction.ROLE_ASSIGNED,
          nowMs: baseNowMs + 1000,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

import { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  ABUSE_EVENTS,
  ABUSE_HIGH_IMPACT_METADATA_KEY,
  ABUSE_RESPONSE_HEADERS,
} from "./abuse-detection.constants";
import { AbuseDetectionController } from "./abuse-detection.controller";
import {
  AbuseManualReviewRequiredException,
  AbuseOperationBlockedException,
  AbuseStepUpRequiredException,
} from "./abuse-detection.errors";
import { AbuseDetectionGuard } from "./abuse-detection.guard";
import { evaluateAbuseRisk, maskIdentifier } from "./abuse-detection.rules";
import { AbuseDetectionService } from "./abuse-detection.service";

describe("Risk-Scored Abuse Detection (#abuse-detection)", () => {
  const fixedAsOf = "2026-10-16T10:00:00.000Z";

  let service: AbuseDetectionService;
  let controller: AbuseDetectionController;
  let emittedEvents: Array<{ event: string; payload: any }>;
  let configValues: Record<string, any>;

  beforeEach(() => {
    emittedEvents = [];
    configValues = {};

    const mockConfig = {
      get: jest.fn((key: string, defaultValue?: any) =>
        configValues[key] !== undefined ? configValues[key] : defaultValue,
      ),
    } as unknown as ConfigService;

    const mockEmitter = {
      emit: jest.fn((event: string, payload: any) => {
        emittedEvents.push({ event, payload });
        return true;
      }),
    } as unknown as EventEmitter2;

    service = new AbuseDetectionService(mockConfig, mockEmitter);
    controller = new AbuseDetectionController(service);
  });

  describe("1. Legitimate low-risk operations & trusted principal mitigation", () => {
    it("allows normal low-risk treasury withdrawal without friction", () => {
      const result = service.evaluateOperation(
        {
          kind: "treasury_withdrawal",
          amount: 500,
          historicalAverageAmount: 450,
          asset: "USDC",
          destination: "GCFX7R3VERIFIEDDEST001",
          asOf: fixedAsOf,
        },
        {
          actorId: "user-legit-1",
          accountAgeDays: 120,
          mfaEnabled: true,
          verifiedDestinations: ["GCFX7R3VERIFIEDDEST001"],
          knownDevicesOrIps: ["dfp_laptop_1"],
          deviceFingerprint: "dfp_laptop_1",
        },
      );

      expect(result.allowed).toBe(true);
      expect(result.disposition).toBe("allow");
      expect(result.riskLevel).toBe("low");
      expect(result.score).toBe(0);
      expect(result.requiredAction).toBe("none");
      expect(() => service.assertProceedable(result)).not.toThrow();
    });

    it("applies TRUSTED_PRINCIPAL_MITIGATION so an established user on a new network is not falsely blocked", () => {
      // New IP/device (+20) + high-value amount (+30) = +50 raw risk,
      // but established account with MFA, verified destination, and clean velocity receives -15 mitigation -> 35 -> or with only new IP (+20) + mild DeFi exit (+25) = 45 - 15 = 30 (< 35 allow!)
      const result = service.evaluateOperation(
        {
          kind: "defi_position_exit",
          portfolioExitFraction: 0.95, // +25 DEFI_SLIPPAGE_OR_DRAIN_PATTERN (medium)
          slippageBps: 50,
          adapterVerified: true,
          asOf: fixedAsOf,
        },
        {
          actorId: "user-trusted-defi",
          accountAgeDays: 180,
          mfaEnabled: true,
          knownDevicesOrIps: ["198.51.100.10"],
          ipAddress: "203.0.113.55", // +20 NEW_DEVICE_OR_IP_CONTEXT
        },
      );

      const signalCodes = result.signals.map((s) => s.code);
      expect(signalCodes).toContain("DEFI_SLIPPAGE_OR_DRAIN_PATTERN");
      expect(signalCodes).toContain("NEW_DEVICE_OR_IP_CONTEXT");
      expect(signalCodes).toContain("TRUSTED_PRINCIPAL_MITIGATION");
      expect(result.rawScore).toBe(30); // 25 + 20 - 15 = 30
      expect(result.score).toBe(30);
      expect(result.disposition).toBe("allow");
      expect(result.allowed).toBe(true);
    });

    it("produces deterministic assessmentId and digest for identical evaluation inputs", () => {
      const ctx = {
        operation: {
          kind: "portfolio_rebalance" as const,
          amount: 60_000,
          asset: "XLM",
          asOf: fixedAsOf,
        },
        actor: {
          actorId: "user-det-1",
        },
        windowState: {
          recentOperationCount: 0,
          recentDistinctDestinations: [],
          recentFailedAttempts: 0,
        },
        thresholds: service.resolveThresholds(),
        asOf: fixedAsOf,
      };

      const first = evaluateAbuseRisk(ctx);
      const second = evaluateAbuseRisk(ctx);

      expect(first.assessmentId).toBe(second.assessmentId);
      expect(first.operationDigest).toBe(second.operationDigest);
      expect(first.digest).toBe(second.digest);
      expect(first.signals).toEqual(second.signals);
    });
  });

  describe("2. Explainable risk signals & step-up behavior", () => {
    it("triggers step_up_required on unverified destination + credential cooling period, and allows after step-up proof", () => {
      const operation = {
        kind: "payout_initiation" as const,
        amount: 2_500,
        asset: "USDC",
        destination: "GNEWUNVERIFIEDWALLET999",
        asOf: fixedAsOf,
      };
      const baseActor = {
        actorId: "user-stepup-1",
        verifiedDestinations: ["GKNOWNWALLET111"],
        minutesSinceLastCredentialChange: 10, // +35 RECENT_AUTH_OR_CREDENTIAL_MUTATION
      };

      // First attempt without step-up verification: +25 (UNVERIFIED_DESTINATION) + 35 (RECENT_AUTH) = 60 -> step_up_required
      const initial = service.evaluateOperation(operation, baseActor);
      expect(initial.score).toBe(60);
      expect(initial.riskLevel).toBe("medium");
      expect(initial.disposition).toBe("step_up_required");
      expect(initial.allowed).toBe(false);
      expect(initial.requiredAction).toBe("provide_totp_or_challenge");
      expect(initial.signals.map((s) => s.code)).toEqual([
        "RECENT_AUTH_OR_CREDENTIAL_MUTATION",
        "UNVERIFIED_DESTINATION",
      ]);
      // Ensure destination is masked in evidence
      const destSignal = initial.signals.find(
        (s) => s.code === "UNVERIFIED_DESTINATION",
      )!;
      expect(destSignal.evidence.destinationPrefix).toBe("GNEW...999");
      expect(destSignal.explanation).toContain("verified allow-list");
      expect(destSignal.remediation).toContain("step-up");

      expect(() => service.assertProceedable(initial)).toThrow(
        AbuseStepUpRequiredException,
      );

      // Second attempt with fresh step-up verification satisfied
      const afterStepUp = service.evaluateOperation(operation, {
        ...baseActor,
        stepUpVerified: true,
        stepUpMethod: "totp",
      });
      expect(afterStepUp.score).toBe(60);
      expect(afterStepUp.disposition).toBe("allow_after_step_up");
      expect(afterStepUp.allowed).toBe(true);
      expect(afterStepUp.stepUpSatisfied).toBe(true);
      expect(afterStepUp.requiredAction).toBe("none");
      expect(() => service.assertProceedable(afterStepUp)).not.toThrow();
    });

    it("detects VELOCITY_BURST and RAPID_DESTINATION_CHURN across sliding window attempts", () => {
      const actorId = "user-burst-1";
      const baseTimeMs = Date.parse(fixedAsOf);

      // Perform 5 operations to distinct destinations within 60 seconds
      for (let i = 0; i < 5; i++) {
        service.evaluateOperation(
          {
            kind: "payout_initiation",
            amount: 100,
            destination: `GDESTINATION000${i}`,
            asOf: new Date(baseTimeMs + i * 5_000).toISOString(),
          },
          { actorId },
        );
      }

      // 6th operation within the 300s window triggers both VELOCITY_BURST (+35) and RAPID_DESTINATION_CHURN (+35) = 70 -> manual_review
      const sixth = service.evaluateOperation(
        {
          kind: "payout_initiation",
          amount: 100,
          destination: "GDESTINATION0006",
          asOf: new Date(baseTimeMs + 30_000).toISOString(),
        },
        { actorId },
      );

      const codes = sixth.signals.map((s) => s.code);
      expect(codes).toContain("VELOCITY_BURST");
      expect(codes).toContain("RAPID_DESTINATION_CHURN");
      expect(sixth.score).toBe(70);
      expect(sixth.disposition).toBe("manual_review");
      expect(sixth.reviewRequired).toBe(true);
      expect(sixth.reviewId).toMatch(/^rv:payout_initiation:/);
    });

    it("detects DEFI_SLIPPAGE_OR_DRAIN_PATTERN, REPEATED_FAILED_ATTEMPTS, and BULK_FANOUT_OR_EXPORT_SPIKE", () => {
      const actorId = "user-defi-drain";
      service.recordFailedAttempt(actorId, fixedAsOf);
      service.recordFailedAttempt(actorId, fixedAsOf);
      service.recordFailedAttempt(actorId, fixedAsOf);

      const defiResult = service.evaluateOperation(
        {
          kind: "defi_adapter_swap",
          adapterId: "untrusted-dex-v0",
          adapterVerified: false, // +45
          slippageBps: 800,
          asOf: fixedAsOf,
        },
        { actorId },
      );

      expect(defiResult.signals.map((s) => s.code)).toEqual([
        "DEFI_SLIPPAGE_OR_DRAIN_PATTERN",
        "REPEATED_FAILED_ATTEMPTS",
      ]);
      expect(defiResult.score).toBe(75); // 45 + 30
      expect(defiResult.disposition).toBe("manual_review");

      const exportResult = service.evaluateOperation(
        {
          kind: "data_export",
          recordOrRecipientCount: 1_200, // +35 BULK_FANOUT_OR_EXPORT_SPIKE
          asOf: fixedAsOf,
        },
        { actorId: "user-export-1" },
      );
      expect(exportResult.signals.map((s) => s.code)).toContain(
        "BULK_FANOUT_OR_EXPORT_SPIKE",
      );
      expect(exportResult.disposition).toBe("step_up_required");
    });
  });

  describe("3. Manual review queue & operator resolution workflow", () => {
    it("queues high-risk operation for manual review, approves with audit reason, and consumes single-use approval token on retry", () => {
      const operation = {
        kind: "treasury_withdrawal" as const,
        amount: 75_000, // +45 AMOUNT_ANOMALY_SPIKE (exceeds 50k and > 5x 5k avg)
        historicalAverageAmount: 5_000,
        asset: "USDC",
        destination: "GNEWEXTERNALVAULT888",
        asOf: fixedAsOf,
      };
      const actor = {
        actorId: "user-treasury-review",
        verifiedDestinations: ["GMAINVAULT001"], // +25 UNVERIFIED_DESTINATION -> total 70 -> manual_review
      };

      const held = service.evaluateOperation(operation, actor);
      expect(held.score).toBe(70);
      expect(held.disposition).toBe("manual_review");
      expect(held.allowed).toBe(false);
      expect(held.reviewId).toBeDefined();

      expect(() => service.assertProceedable(held)).toThrow(
        AbuseManualReviewRequiredException,
      );

      const pendingList = service.listReviews({ status: "pending" });
      expect(pendingList).toHaveLength(1);
      expect(pendingList[0].reviewId).toBe(held.reviewId);

      // Reject short reason
      expect(() =>
        service.resolveReview(
          held.reviewId!,
          "approved",
          "admin-1",
          "too short",
        ),
      ).toThrow();

      // Operator approves with valid audit reason
      const resolved = service.resolveReview(
        held.reviewId!,
        "approved",
        "admin-compliance-1",
        "Confirmed treasury rebalance with CFO over verified hardware key.",
        fixedAsOf,
      );
      expect(resolved.status).toBe("approved");
      expect(resolved.approvalToken).toMatch(/^rat_/);

      // Retrying with the single-use approval token succeeds
      const approvedRetry = service.evaluateOperation(operation, {
        ...actor,
        reviewApprovalToken: resolved.approvalToken,
      });
      expect(approvedRetry.disposition).toBe("allow_after_review");
      expect(approvedRetry.allowed).toBe(true);
      expect(() => service.assertProceedable(approvedRetry)).not.toThrow();

      // Replaying the same approval token a second time is rejected (single-use)
      const replayAttempt = service.evaluateOperation(operation, {
        ...actor,
        reviewApprovalToken: resolved.approvalToken,
      });
      expect(replayAttempt.disposition).toBe("manual_review");
      expect(replayAttempt.allowed).toBe(false);
    });
  });

  describe("4. Critical block disposition & sanctions invariant", () => {
    it("immediately blocks sanctioned/flagged counterparty regardless of step-up or trusted principal status", () => {
      const result = service.evaluateOperation(
        {
          kind: "treasury_withdrawal",
          amount: 100,
          destination: "GFLAGGEDSANCTIONEDADDR999",
          counterpartyFlagged: true,
          asOf: fixedAsOf,
        },
        {
          actorId: "user-vip-1",
          accountAgeDays: 500,
          mfaEnabled: true,
          stepUpVerified: true,
          verifiedDestinations: ["GFLAGGEDSANCTIONEDADDR999"],
        },
      );

      expect(result.disposition).toBe("block");
      expect(result.riskLevel).toBe("critical");
      expect(result.allowed).toBe(false);
      expect(result.requiredAction).toBe("contact_security");
      expect(result.signals.map((s) => s.code)).toContain(
        "SANCTIONED_OR_HIGH_RISK_COUNTERPARTY",
      );
      expect(result.signals.map((s) => s.code)).not.toContain(
        "TRUSTED_PRINCIPAL_MITIGATION",
      );

      expect(() => service.assertProceedable(result)).toThrow(
        AbuseOperationBlockedException,
      );
      expect(
        emittedEvents.some((e) => e.event === ABUSE_EVENTS.OPERATION_BLOCKED),
      ).toBe(true);
    });
  });

  describe("5. Operational modes (shadow / disabled), rollback recovery, & metrics", () => {
    it("does not block in shadow mode while recording signals and shadow metrics", () => {
      configValues.ABUSE_DETECTION_MODE = "shadow";

      const result = service.evaluateOperation(
        {
          kind: "treasury_withdrawal",
          amount: 100_000,
          historicalAverageAmount: 1_000,
          destination: "GFLAGGEDADDR000",
          counterpartyFlagged: true,
          asOf: fixedAsOf,
        },
        { actorId: "user-shadow-1" },
      );

      expect(result.mode).toBe("shadow");
      expect(result.disposition).toBe("block");
      expect(result.allowed).toBe(true);
      expect(result.summary).toContain("[SHADOW]");
      expect(() => service.assertProceedable(result)).not.toThrow();

      const metrics = service.getMetricsSnapshot();
      expect(metrics.mode).toBe("shadow");
      expect(metrics.totalAssessments).toBe(1);
      expect(metrics.shadowWouldHaveBlockedOrChallenged).toBe(1);
    });

    it("bypasses scoring cleanly when ABUSE_DETECTION_MODE=disabled and falls back safely on inverted thresholds", () => {
      configValues.ABUSE_DETECTION_MODE = "disabled";
      configValues.ABUSE_STEP_UP_SCORE_THRESHOLD = 90;
      configValues.ABUSE_MANUAL_REVIEW_SCORE_THRESHOLD = 50; // inverted!

      const thresholds = service.resolveThresholds();
      expect(thresholds.mode).toBe("disabled");
      expect(thresholds.stepUpScoreThreshold).toBe(35);
      expect(thresholds.manualReviewScoreThreshold).toBe(70);
      expect(thresholds.blockScoreThreshold).toBe(85);

      const result = service.evaluateOperation(
        {
          kind: "treasury_withdrawal",
          amount: 500_000,
          counterpartyFlagged: true,
          asOf: fixedAsOf,
        },
        { actorId: "user-disabled-mode" },
      );

      expect(result.allowed).toBe(true);
      expect(result.score).toBe(0);
      expect(result.signals).toHaveLength(0);
    });

    it("supports operator resetActorWindowState to recover falsely throttled actors", () => {
      const actorId = "user-recover-window";
      for (let i = 0; i < 6; i++) {
        service.evaluateOperation(
          { kind: "api_key_issuance", asOf: fixedAsOf },
          { actorId },
        );
      }

      expect(
        service.getBehavioralWindowState(actorId, 300, Date.parse(fixedAsOf))
          .recentOperationCount,
      ).toBe(6);

      service.resetActorWindowState(actorId);
      expect(
        service.getBehavioralWindowState(actorId, 300, Date.parse(fixedAsOf))
          .recentOperationCount,
      ).toBe(0);
    });
  });

  describe("6. AbuseDetectionGuard & AbuseDetectionController integration", () => {
    it("sets X-Abuse-* response headers and enforces step-up in AbuseDetectionGuard", async () => {
      const reflector = {
        getAllAndOverride: jest.fn().mockReturnValue({
          kind: "admin_privilege_change",
        }),
      } as unknown as Reflector;

      const guard = new AbuseDetectionGuard(reflector, service);
      const headersOut: Record<string, string> = {};
      const mockRequest: any = {
        user: { id: "admin-actor-1", role: "admin" },
        headers: {},
        body: {},
        params: {},
      };
      const mockResponse = {
        setHeader: (k: string, v: string) => {
          headersOut[k] = v;
        },
      };

      const context = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => mockRequest,
          getResponse: () => mockResponse,
        }),
      } as unknown as ExecutionContext;

      // Without step-up token, admin_privilege_change (+35) requires step-up
      await expect(guard.canActivate(context)).rejects.toThrow(
        AbuseStepUpRequiredException,
      );
      expect(headersOut[ABUSE_RESPONSE_HEADERS.DISPOSITION]).toBe(
        "step_up_required",
      );
      expect(headersOut[ABUSE_RESPONSE_HEADERS.RISK_SCORE]).toBe("35");

      // With X-TOTP-Token header, step-up is satisfied and guard returns true
      mockRequest.headers["x-totp-token"] = "123456";
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(headersOut[ABUSE_RESPONSE_HEADERS.DISPOSITION]).toBe(
        "allow_after_step_up",
      );
      expect(Reflect.get(ABUSE_HIGH_IMPACT_METADATA_KEY, {})).toBeUndefined();
    });

    it("exposes controller evaluate, assert, review resolution, and metrics endpoints", () => {
      const evalRes = controller.evaluate(
        {
          kind: "portfolio_liquidation",
          amount: 80_000,
          historicalAverageAmount: 5_000,
          portfolioExitFraction: 0.95,
          asOf: fixedAsOf,
        },
        { user: { id: "ctrl-user-1" }, headers: {} },
      );

      expect(evalRes.disposition).toBe("manual_review");
      expect(evalRes.reviewId).toBeDefined();

      const reviews = controller.listReviews({ status: "pending" });
      expect(reviews.count).toBe(1);

      const single = controller.getReview(evalRes.reviewId!);
      expect(single.reviewId).toBe(evalRes.reviewId);

      const resolved = controller.resolveReview(
        evalRes.reviewId!,
        {
          decision: "approved",
          reason: "Verified portfolio liquidation request with account owner.",
        },
        { user: { id: "admin-op-1", role: "admin" } },
      );
      expect(resolved.status).toBe("approved");

      const assertRes = controller.assertProceedable(
        {
          kind: "portfolio_liquidation",
          amount: 80_000,
          historicalAverageAmount: 5_000,
          portfolioExitFraction: 0.95,
          asOf: fixedAsOf,
          reviewApprovalToken: resolved.approvalToken,
        },
        { user: { id: "ctrl-user-1" }, headers: {} },
      );
      expect(assertRes.allowed).toBe(true);
      expect(assertRes.disposition).toBe("allow_after_review");

      expect(maskIdentifier("abc")).toBe("***");
      expect(maskIdentifier(null)).toBeNull();
    });
  });
});

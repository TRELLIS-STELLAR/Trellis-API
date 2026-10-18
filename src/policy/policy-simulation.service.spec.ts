import { BadRequestException, NotFoundException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  maskIdentifier,
  simulatePolicyChange,
} from "./policy-simulation.rules";
import {
  POLICY_SIMULATION_EVENTS,
  PolicySimulationService,
} from "./policy-simulation.service";
import { PolicyController } from "./policy.controller";
import { PolicyService } from "./policy.service";

describe("PolicySimulationService & PolicyController", () => {
  const fixedAsOf = "2026-10-17T00:00:00.000Z";

  function createService() {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const mockEventEmitter = {
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
        return true;
      },
    } as unknown as EventEmitter2;

    const policyService = new PolicyService();
    const simulationService = new PolicySimulationService(
      policyService,
      undefined,
      mockEventEmitter,
    );
    const controller = new PolicyController(simulationService);
    return { simulationService, controller, emitted };
  }

  it("previews trading policy tightening and surfaces affected trades, portfolios, side effects, and rollback constraints", async () => {
    const { simulationService, emitted } = createService();

    const preview = await simulationService.preview(
      {
        domain: "trading",
        proposedPolicy: {
          maxOrderAmount: 50_000,
          allowedAssets: ["XLM", "USDC"],
        },
        asOf: fixedAsOf,
      },
      "maintainer-01",
    );

    expect(preview.dryRun).toBe(true);
    expect(preview.readOnly).toBe(true);
    expect(preview.domain).toBe("trading");
    expect(preview.status).toBe("high_impact_review_required");
    expect(preview.reversibility).toBe("partially_reversible");
    expect(preview.requiresCommitToken).toBe(true);
    expect(preview.affectedSummary.affectedRecordCount).toBe(3);
    expect(preview.affectedSummary.affectedRecordsByType).toEqual({
      pending_trade: 1,
      portfolio: 2,
    });
    expect(
      preview.expectedSideEffects.map((s) => s.code),
    ).toEqual(
      expect.arrayContaining([
        "PENDING_TRADES_REJECTED",
        "PORTFOLIO_ALLOCATIONS_INVALIDATED",
      ]),
    );
    expect(
      preview.rollbackConstraints.map((c) => c.code),
    ).toContain("REJECTED_TRADES_REQUIRE_RESUBMISSION");
    expect(emitted[0]?.event).toBe(POLICY_SIMULATION_EVENTS.PREVIEWED);
  });

  it("marks DeFi adapter disabling and emergencyExitOnly as irreversible with on-chain unwind rollback constraints", async () => {
    const { simulationService } = createService();

    const preview = await simulationService.preview({
      domain: "defi_adapters",
      proposedPolicy: {
        enabledAdapters: ["aave"],
        minHealthFactor: 1.5,
      },
      asOf: fixedAsOf,
    });

    expect(preview.reversibility).toBe("irreversible");
    expect(preview.impactSeverity).toBe("critical");
    expect(preview.status).toBe("high_impact_review_required");
    expect(preview.requiresCommitToken).toBe(true);
    expect(
      preview.expectedSideEffects.map((s) => s.code),
    ).toEqual(
      expect.arrayContaining([
        "DEFI_EMERGENCY_UNWIND_TRIGGERED",
        "DEFI_LIQUIDATION_THRESHOLD_TIGHTENED",
      ]),
    );
    expect(
      preview.rollbackConstraints.map((c) => c.code),
    ).toContain("IRREVERSIBLE_ONCHAIN_DEFI_EXIT");
  });

  it("previews portfolio rebalancing policy changes and identifies concentration violations and rebalance waves", async () => {
    const { simulationService } = createService();

    const preview = await simulationService.preview({
      domain: "portfolio_rebalancing",
      proposedPolicy: {
        maxSingleAssetWeightPct: 45,
        driftThresholdPct: 3.0,
      },
      asOf: fixedAsOf,
    });

    expect(preview.affectedSummary.affectedRecordCount).toBeGreaterThanOrEqual(2);
    expect(
      preview.expectedSideEffects.map((s) => s.code),
    ).toEqual(
      expect.arrayContaining([
        "PORTFOLIO_ALLOCATIONS_INVALIDATED",
        "AUTO_REBALANCE_WAVE_TRIGGERED",
      ]),
    );
    expect(
      preview.rollbackConstraints.map((c) => c.code),
    ).toEqual(
      expect.arrayContaining([
        "PORTFOLIO_TARGETS_REQUIRE_VERSION_RESTORE",
        "IN_FLIGHT_QUEUE_DRAIN_REQUIRED",
      ]),
    );
  });

  it("previews auth access policy session revocation as irreversible and blocks ADMIN role lockout", async () => {
    const { simulationService } = createService();

    const revokePreview = await simulationService.preview({
      domain: "auth_access",
      proposedPolicy: {
        revokeUnverifiedSessions: true,
        requireMfaForSensitiveActions: true,
      },
      asOf: fixedAsOf,
    });

    expect(revokePreview.reversibility).toBe("irreversible");
    expect(
      revokePreview.expectedSideEffects.map((s) => s.code),
    ).toEqual(
      expect.arrayContaining([
        "ACTIVE_SESSIONS_REVOKED",
        "MFA_STEP_UP_ENFORCED",
      ]),
    );
    expect(
      revokePreview.rollbackConstraints.map((c) => c.code),
    ).toContain("IRREVERSIBLE_SESSION_REVOCATION");

    const adminLockoutPreview = await simulationService.preview({
      domain: "auth_access",
      proposedPolicy: {
        disallowedRoles: ["ADMIN"],
      },
      asOf: fixedAsOf,
    });

    expect(adminLockoutPreview.status).toBe("blocked_invalid_policy");
    expect(adminLockoutPreview.validationErrors.length).toBeGreaterThan(0);
  });

  it("previews notification routing policy overrides and digest re-windowing", async () => {
    const { simulationService } = createService();

    const preview = await simulationService.preview({
      domain: "notification_routing",
      proposedPolicy: {
        mandatorySecurityChannels: ["email", "in_app", "sms"],
        suppressMarketingChannels: true,
        digestWindowMinutes: 30,
      },
      asOf: fixedAsOf,
    });

    expect(preview.affectedSummary.affectedRecordCount).toBe(3);
    expect(
      preview.expectedSideEffects.map((s) => s.code),
    ).toEqual(
      expect.arrayContaining([
        "NOTIFICATION_PREFERENCES_OVERRIDDEN",
        "NOTIFICATION_DIGEST_REBATCHED",
      ]),
    );
  });

  it("blocks commits when snapshot is stale or when commitToken is missing/mismatched, then commits and rolls back cleanly", async () => {
    const { controller } = createService();

    // 1. Stale snapshot blocks commit
    await expect(
      controller.commit(
        {
          domain: "trading",
          proposedPolicy: { maxOrderAmount: 25_000 },
          reason: "Attempt commit with stale snapshot",
          asOf: "2026-10-17T01:00:00.000Z",
          snapshot: {
            version: "snap-stale-1",
            observedAt: "2026-10-17T00:00:00.000Z", // 3600s old > 300s limit
            users: [],
            pendingTrades: [],
          },
        },
        { user: { id: "maint-1" } },
      ),
    ).rejects.toThrow(BadRequestException);

    // 2. High-impact change without commitToken is blocked
    await expect(
      controller.commit(
        {
          domain: "defi_adapters",
          proposedPolicy: { emergencyExitOnly: true },
          reason: "Emergency unwind without preview token",
          asOf: fixedAsOf,
        },
        { user: { id: "maint-1" } },
      ),
    ).rejects.toThrow(BadRequestException);

    // 3. Preview first to obtain deterministic commitToken, then commit
    const preview = await controller.preview(
      {
        domain: "defi_adapters",
        proposedPolicy: { emergencyExitOnly: true },
        asOf: fixedAsOf,
      },
      { user: { id: "maint-1" } },
    );

    const committed = await controller.commit(
      {
        domain: "defi_adapters",
        proposedPolicy: { emergencyExitOnly: true },
        reason: "Protocol pause drill with verified commit token",
        commitToken: preview.commitToken,
        asOf: fixedAsOf,
      },
      { user: { id: "maint-1" } },
    );

    expect(committed.commit.commitId).toMatch(/^pcmt:defi_adapters:/);
    expect(controller.getActivePolicies().defi_adapters.emergencyExitOnly).toBe(
      true,
    );

    // 4. Roll back the committed policy change and verify recovery constraints
    const rolledBack = controller.rollback(
      committed.commit.commitId,
      { reason: "Drill complete; restore normal DeFi adapter policy" },
      { user: { id: "maint-1" } },
    );

    expect(rolledBack.restoredPolicy).toMatchObject({
      emergencyExitOnly: false,
    });
    expect(rolledBack.manualRecoveryRequired).toBe(true);
    expect(rolledBack.recoveryConstraints.length).toBeGreaterThan(0);
    expect(controller.getActivePolicies().defi_adapters.emergencyExitOnly).toBe(
      false,
    );

    // 5. Double rollback is rejected
    expect(() =>
      controller.rollback(committed.commit.commitId, {
        reason: "Duplicate rollback",
      }),
    ).toThrow(BadRequestException);

    // 6. Unknown commitId throws NotFoundException
    expect(() =>
      controller.rollback("pcmt:unknown:0000", { reason: "Missing commit" }),
    ).toThrow(NotFoundException);
  });

  it("masks identifiers and produces identical deterministic digests for identical inputs", () => {
    expect(maskIdentifier("GCFX7R3LONGWALLETADDRESS999")).toBe("GCFX...S999");
    expect(maskIdentifier("short")).toBe("***");

    const first = simulatePolicyChange({
      domain: "trading",
      proposedPolicy: { maxOrderAmount: 40_000 },
      asOf: fixedAsOf,
    });
    const second = simulatePolicyChange({
      domain: "trading",
      proposedPolicy: { maxOrderAmount: 40_000 },
      asOf: fixedAsOf,
    });

    expect(first.simulationId).toBe(second.simulationId);
    expect(first.commitToken).toBe(second.commitToken);
    expect(first.digest).toBe(second.digest);
  });
});

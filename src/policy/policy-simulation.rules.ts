import { createHash } from "crypto";
import type {
  AffectedPopulationSummary,
  AffectedRecordPreview,
  AuthAccessPolicy,
  DeFiAdapterPolicy,
  DomainPolicyMap,
  ExpectedSideEffect,
  NotificationRoutingPolicy,
  PolicyDomain,
  PolicyFieldDiff,
  PolicyImpactSeverity,
  PolicyReversibility,
  PolicySimulationInput,
  PolicySimulationPreviewResult,
  PolicySimulationSnapshot,
  PolicySimulationStatus,
  PortfolioRebalancingPolicy,
  RollbackConstraint,
  SnapshotCompleteness,
  TradeSide,
  TradingPolicy,
} from "./policy.types";

export const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 300;

export const DEFAULT_TRADING_POLICY: TradingPolicy = {
  enabled: true,
  maxOrderAmount: 100_000,
  allowedAssets: undefined,
  allowedSides: ["buy", "sell"],
};

export const DEFAULT_DEFI_ADAPTER_POLICY: DeFiAdapterPolicy = {
  enabledAdapters: ["aave", "compound"],
  allowedChains: ["stellar", "ethereum", "polygon"],
  maxSlippageBps: 100,
  minHealthFactor: 1.25,
  emergencyExitOnly: false,
};

export const DEFAULT_PORTFOLIO_REBALANCING_POLICY: PortfolioRebalancingPolicy = {
  autoRebalanceEnabled: true,
  minTradeSizeUsd: 10,
  maxSingleAssetWeightPct: 75,
  driftThresholdPct: 5,
};

export const DEFAULT_AUTH_ACCESS_POLICY: AuthAccessPolicy = {
  requireMfaForSensitiveActions: false,
  minKycTier: 1,
  sessionTtlMinutes: 60,
  revokeUnverifiedSessions: false,
  disallowedRoles: [],
};

export const DEFAULT_NOTIFICATION_ROUTING_POLICY: NotificationRoutingPolicy = {
  mandatorySecurityChannels: ["email", "in_app"],
  digestWindowMinutes: 15,
  suppressMarketingChannels: false,
  maxDeliveryRetries: 3,
};

export function defaultDomainPolicies(): DomainPolicyMap {
  return {
    trading: {
      ...DEFAULT_TRADING_POLICY,
      allowedSides: [...DEFAULT_TRADING_POLICY.allowedSides],
    },
    defi_adapters: {
      ...DEFAULT_DEFI_ADAPTER_POLICY,
      enabledAdapters: [...DEFAULT_DEFI_ADAPTER_POLICY.enabledAdapters],
      allowedChains: [...DEFAULT_DEFI_ADAPTER_POLICY.allowedChains],
    },
    portfolio_rebalancing: {
      ...DEFAULT_PORTFOLIO_REBALANCING_POLICY,
    },
    auth_access: {
      ...DEFAULT_AUTH_ACCESS_POLICY,
      disallowedRoles: [...DEFAULT_AUTH_ACCESS_POLICY.disallowedRoles],
    },
    notification_routing: {
      ...DEFAULT_NOTIFICATION_ROUTING_POLICY,
      mandatorySecurityChannels: [
        ...DEFAULT_NOTIFICATION_ROUTING_POLICY.mandatorySecurityChannels,
      ],
    },
  };
}

/**
 * Redacts/masks user, account, or wallet identifiers so maintainer simulation
 * previews never expose raw wallet addresses, session tokens, or unmasked PII.
 */
export function maskIdentifier(value: string | null | undefined): string {
  if (!value || typeof value !== "string") return "anonymous";
  const trimmed = value.trim();
  if (trimmed.length <= 6) return "***";
  if (trimmed.length <= 12) {
    return `${trimmed.slice(0, 3)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * Canonical JSON stringification with sorted keys for deterministic digests.
 */
export function canonicalizeValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    const entries = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalizeValue(record[k])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function computeDigest(namespace: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${namespace}:${canonicalizeValue(payload)}`)
    .digest("hex");
}

/**
 * Computes a deterministic commit confirmation token bound to the domain,
 * current policy, effective proposed policy, and snapshot version.
 */
export function computeCommitToken<D extends PolicyDomain>(
  domain: D,
  currentPolicy: DomainPolicyMap[D],
  effectiveProposedPolicy: DomainPolicyMap[D],
  snapshotVersion: string,
): string {
  const hash = computeDigest("policy-commit-token:v1", {
    domain,
    currentPolicy,
    effectiveProposedPolicy,
    snapshotVersion,
  });
  return `pctk:${domain}:${hash.slice(0, 24)}`;
}

/**
 * Default deterministic population snapshot used when a caller previews a
 * policy change without providing a custom snapshot.
 */
export function defaultSimulationSnapshot(
  asOf = "2026-10-17T00:00:00.000Z",
): PolicySimulationSnapshot {
  return {
    version: "snap-default-v1",
    observedAt: asOf,
    isSampled: false,
    totalPopulationUsers: 4,
    users: [
      {
        userId: "user-alpha-0001",
        role: "USER",
        mfaEnabled: true,
        kycTier: 2,
        activeSessionCount: 2,
        sessionAgeMinutes: 25,
        apiKeyCount: 1,
      },
      {
        userId: "user-bravo-0002",
        role: "USER",
        mfaEnabled: false,
        kycTier: 1,
        activeSessionCount: 3,
        sessionAgeMinutes: 95,
        apiKeyCount: 2,
      },
      {
        userId: "user-charlie-0003",
        role: "OPERATOR",
        mfaEnabled: false,
        kycTier: 1,
        activeSessionCount: 1,
        sessionAgeMinutes: 45,
        apiKeyCount: 1,
      },
      {
        userId: "user-delta-0004",
        role: "MAINTAINER",
        mfaEnabled: true,
        kycTier: 3,
        activeSessionCount: 1,
        sessionAgeMinutes: 15,
        apiKeyCount: 0,
      },
    ],
    pendingTrades: [
      {
        tradeId: "trd-1001",
        userId: "user-alpha-0001",
        portfolioId: "port-2001",
        asset: "XLM",
        amount: 15_000,
        side: "buy",
      },
      {
        tradeId: "trd-1002",
        userId: "user-bravo-0002",
        portfolioId: "port-2002",
        asset: "BTC",
        amount: 65_000,
        side: "buy",
      },
      {
        tradeId: "trd-1003",
        userId: "user-charlie-0003",
        portfolioId: "port-2003",
        asset: "USDC",
        amount: 120_000,
        side: "sell",
      },
    ],
    portfolios: [
      {
        portfolioId: "port-2001",
        userId: "user-alpha-0001",
        totalValueUsd: 50_000,
        targetAllocations: { XLM: 50, USDC: 50 },
        currentDriftPct: 3.5,
        pendingRebalanceTradeUsd: 25,
        autoRebalanceOptIn: true,
      },
      {
        portfolioId: "port-2002",
        userId: "user-bravo-0002",
        totalValueUsd: 120_000,
        targetAllocations: { BTC: 70, USDC: 30 },
        currentDriftPct: 6.2,
        pendingRebalanceTradeUsd: 4_500,
        autoRebalanceOptIn: true,
      },
      {
        portfolioId: "port-2003",
        userId: "user-charlie-0003",
        totalValueUsd: 25_000,
        targetAllocations: { ETH: 40, XLM: 35, USDC: 25 },
        currentDriftPct: 4.2,
        pendingRebalanceTradeUsd: 8,
        autoRebalanceOptIn: true,
      },
    ],
    defiPositions: [
      {
        positionId: "pos-3001",
        userId: "user-alpha-0001",
        adapterId: "aave",
        chain: "ethereum",
        asset: "USDC",
        suppliedUsd: 40_000,
        borrowedUsd: 20_000,
        healthFactor: 1.65,
        estimatedExitSlippageBps: 45,
      },
      {
        positionId: "pos-3002",
        userId: "user-bravo-0002",
        adapterId: "compound",
        chain: "polygon",
        asset: "ETH",
        suppliedUsd: 85_000,
        borrowedUsd: 62_000,
        healthFactor: 1.32,
        estimatedExitSlippageBps: 140,
      },
    ],
    notificationPreferences: [
      {
        preferenceId: "npref-4001",
        userId: "user-alpha-0001",
        enabledChannels: ["email", "in_app", "webhook"],
        marketingOptIn: false,
        digestFrequencyMinutes: 15,
        pendingDigestCount: 2,
      },
      {
        preferenceId: "npref-4002",
        userId: "user-bravo-0002",
        enabledChannels: ["in_app"],
        marketingOptIn: true,
        digestFrequencyMinutes: 60,
        pendingDigestCount: 5,
      },
      {
        preferenceId: "npref-4003",
        userId: "user-charlie-0003",
        enabledChannels: ["email"],
        marketingOptIn: true,
        digestFrequencyMinutes: 30,
        pendingDigestCount: 3,
      },
    ],
  };
}

/**
 * Merges a partial proposed policy with the current policy for the given domain,
 * normalizing case and array elements deterministically.
 */
export function resolveEffectivePolicies<D extends PolicyDomain>(
  domain: D,
  currentInput?: Partial<DomainPolicyMap[D]>,
  proposedInput?: Partial<DomainPolicyMap[D]>,
): {
  current: DomainPolicyMap[D];
  effectiveProposed: DomainPolicyMap[D];
} {
  const defaults = defaultDomainPolicies()[domain];
  const rawCurrent = { ...defaults, ...(currentInput ?? {}) } as Record<
    string,
    unknown
  >;
  const rawProposed = { ...rawCurrent, ...(proposedInput ?? {}) } as Record<
    string,
    unknown
  >;

  const normalizeForDomain = (
    raw: Record<string, unknown>,
  ): DomainPolicyMap[D] => {
    if (domain === "trading") {
      const p = raw as unknown as TradingPolicy;
      const allowedAssets = Array.isArray(p.allowedAssets)
        ? p.allowedAssets
            .map((a) => String(a).trim().toUpperCase())
            .filter(Boolean)
        : undefined;
      const allowedSides = Array.isArray(p.allowedSides)
        ? (p.allowedSides
            .map((s) => String(s).trim().toLowerCase())
            .filter(Boolean) as TradeSide[])
        : [];
      return {
        enabled: Boolean(p.enabled),
        maxOrderAmount: Number(p.maxOrderAmount),
        allowedAssets:
          allowedAssets && allowedAssets.length > 0 ? allowedAssets : undefined,
        allowedSides,
      } as DomainPolicyMap[D];
    }

    if (domain === "defi_adapters") {
      const p = raw as unknown as DeFiAdapterPolicy;
      return {
        enabledAdapters: Array.isArray(p.enabledAdapters)
          ? p.enabledAdapters
              .map((a) => String(a).trim().toLowerCase())
              .filter(Boolean)
          : [],
        allowedChains: Array.isArray(p.allowedChains)
          ? p.allowedChains
              .map((c) => String(c).trim().toLowerCase())
              .filter(Boolean)
          : [],
        maxSlippageBps: Number(p.maxSlippageBps),
        minHealthFactor: Number(p.minHealthFactor),
        emergencyExitOnly: Boolean(p.emergencyExitOnly),
      } as DomainPolicyMap[D];
    }

    if (domain === "portfolio_rebalancing") {
      const p = raw as unknown as PortfolioRebalancingPolicy;
      return {
        autoRebalanceEnabled: Boolean(p.autoRebalanceEnabled),
        minTradeSizeUsd: Number(p.minTradeSizeUsd),
        maxSingleAssetWeightPct: Number(p.maxSingleAssetWeightPct),
        driftThresholdPct: Number(p.driftThresholdPct),
      } as DomainPolicyMap[D];
    }

    if (domain === "auth_access") {
      const p = raw as unknown as AuthAccessPolicy;
      return {
        requireMfaForSensitiveActions: Boolean(p.requireMfaForSensitiveActions),
        minKycTier: Number(p.minKycTier),
        sessionTtlMinutes: Number(p.sessionTtlMinutes),
        revokeUnverifiedSessions: Boolean(p.revokeUnverifiedSessions),
        disallowedRoles: Array.isArray(p.disallowedRoles)
          ? p.disallowedRoles
              .map((r) => String(r).trim().toUpperCase())
              .filter(Boolean)
          : [],
      } as DomainPolicyMap[D];
    }

    const p = raw as unknown as NotificationRoutingPolicy;
    return {
      mandatorySecurityChannels: Array.isArray(p.mandatorySecurityChannels)
        ? p.mandatorySecurityChannels
            .map((c) => String(c).trim().toLowerCase())
            .filter(Boolean)
        : [],
      digestWindowMinutes: Number(p.digestWindowMinutes),
      suppressMarketingChannels: Boolean(p.suppressMarketingChannels),
      maxDeliveryRetries: Number(p.maxDeliveryRetries),
    } as DomainPolicyMap[D];
  };

  return {
    current: normalizeForDomain(rawCurrent),
    effectiveProposed: normalizeForDomain(rawProposed),
  };
}

/**
 * Validates that a proposed domain policy satisfies safety and schema invariants.
 */
export function validateProposedPolicy<D extends PolicyDomain>(
  domain: D,
  policy: DomainPolicyMap[D],
): string[] {
  const errors: string[] = [];

  if (domain === "trading") {
    const p = policy as TradingPolicy;
    if (!Number.isFinite(p.maxOrderAmount) || p.maxOrderAmount <= 0) {
      errors.push("Trading policy maxOrderAmount must be a finite number > 0.");
    }
    if (!Array.isArray(p.allowedSides) || p.allowedSides.length === 0) {
      errors.push("Trading policy allowedSides must contain at least one side ('buy' or 'sell').");
    } else if (
      p.allowedSides.some((side) => side !== "buy" && side !== "sell")
    ) {
      errors.push("Trading policy allowedSides may only contain 'buy' or 'sell'.");
    }
  } else if (domain === "defi_adapters") {
    const p = policy as DeFiAdapterPolicy;
    if (
      !Number.isFinite(p.maxSlippageBps) ||
      p.maxSlippageBps <= 0 ||
      p.maxSlippageBps > 5_000
    ) {
      errors.push("DeFi adapter policy maxSlippageBps must be between 1 and 5000 bps.");
    }
    if (
      !Number.isFinite(p.minHealthFactor) ||
      p.minHealthFactor < 1.0 ||
      p.minHealthFactor > 10.0
    ) {
      errors.push("DeFi adapter policy minHealthFactor must be between 1.0 and 10.0.");
    }
    if (!p.emergencyExitOnly && p.enabledAdapters.length === 0) {
      errors.push(
        "DeFi adapter policy cannot disable all adapters unless emergencyExitOnly is true.",
      );
    }
    if (p.allowedChains.length === 0) {
      errors.push("DeFi adapter policy allowedChains must include at least one chain.");
    }
  } else if (domain === "portfolio_rebalancing") {
    const p = policy as PortfolioRebalancingPolicy;
    if (!Number.isFinite(p.minTradeSizeUsd) || p.minTradeSizeUsd < 0) {
      errors.push("Portfolio policy minTradeSizeUsd must be a non-negative number.");
    }
    if (
      !Number.isFinite(p.maxSingleAssetWeightPct) ||
      p.maxSingleAssetWeightPct <= 0 ||
      p.maxSingleAssetWeightPct > 100
    ) {
      errors.push(
        "Portfolio policy maxSingleAssetWeightPct must be > 0 and <= 100.",
      );
    }
    if (
      !Number.isFinite(p.driftThresholdPct) ||
      p.driftThresholdPct <= 0 ||
      p.driftThresholdPct > 50
    ) {
      errors.push(
        "Portfolio policy driftThresholdPct must be between 0 (exclusive) and 50.",
      );
    }
  } else if (domain === "auth_access") {
    const p = policy as AuthAccessPolicy;
    if (
      !Number.isFinite(p.minKycTier) ||
      p.minKycTier < 0 ||
      p.minKycTier > 3
    ) {
      errors.push("Auth policy minKycTier must be an integer between 0 and 3.");
    }
    if (
      !Number.isFinite(p.sessionTtlMinutes) ||
      p.sessionTtlMinutes < 5 ||
      p.sessionTtlMinutes > 43_200
    ) {
      errors.push(
        "Auth policy sessionTtlMinutes must be between 5 and 43200 minutes.",
      );
    }
    if (p.disallowedRoles.includes("ADMIN")) {
      errors.push(
        "Auth policy disallowedRoles cannot lock out the ADMIN role (anti-lockout invariant).",
      );
    }
  } else if (domain === "notification_routing") {
    const p = policy as NotificationRoutingPolicy;
    if (p.mandatorySecurityChannels.length === 0) {
      errors.push(
        "Notification policy mandatorySecurityChannels must retain at least one channel for critical alerts.",
      );
    }
    if (
      !Number.isFinite(p.digestWindowMinutes) ||
      p.digestWindowMinutes < 1 ||
      p.digestWindowMinutes > 1_440
    ) {
      errors.push(
        "Notification policy digestWindowMinutes must be between 1 and 1440 minutes.",
      );
    }
    if (
      !Number.isFinite(p.maxDeliveryRetries) ||
      p.maxDeliveryRetries < 0 ||
      p.maxDeliveryRetries > 20
    ) {
      errors.push(
        "Notification policy maxDeliveryRetries must be between 0 and 20.",
      );
    }
  }

  return errors;
}

/**
 * Pure, deterministic policy simulation preview evaluator.
 *
 * Never mutates state. Given identical `(domain, currentPolicy, proposedPolicy, snapshot, asOf)`,
 * returns the exact same `PolicySimulationPreviewResult`, `commitToken`, and `digest`.
 */
export function simulatePolicyChange<D extends PolicyDomain>(
  input: PolicySimulationInput<D>,
): PolicySimulationPreviewResult<D> {
  const asOf = input.asOf ?? new Date().toISOString();
  const maxSnapshotAgeSeconds =
    input.maxSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
  const snapshot = input.snapshot ?? defaultSimulationSnapshot(asOf);

  const { current, effectiveProposed } = resolveEffectivePolicies(
    input.domain,
    input.currentPolicy,
    input.proposedPolicy,
  );

  const validationErrors = validateProposedPolicy(
    input.domain,
    effectiveProposed,
  );

  const diffs = computePolicyDiffs(input.domain, current, effectiveProposed);
  const affectedRecords: AffectedRecordPreview[] = [];
  const expectedSideEffects: ExpectedSideEffect[] = [];
  const rollbackConstraints: RollbackConstraint[] = [];
  const warnings: string[] = [];

  // Evaluate snapshot freshness and completeness
  const snapshotAgeSec = computeAgeSeconds(asOf, snapshot.observedAt);
  let completeness: SnapshotCompleteness = "complete";

  if (snapshotAgeSec > maxSnapshotAgeSeconds) {
    completeness = "stale_snapshot";
    warnings.push(
      `Population snapshot '${snapshot.version}' is stale (${Math.round(snapshotAgeSec)}s old > ${maxSnapshotAgeSeconds}s limit). Refresh snapshot before committing high-impact changes.`,
    );
    expectedSideEffects.push({
      code: "STALE_SNAPSHOT_UNCERTAINTY",
      severity: "high",
      subsystem: "observability",
      description: `Simulation evaluated against a snapshot aged ${Math.round(snapshotAgeSec)}s; actual affected record count may have drifted.`,
      estimatedAffectedCount: 0,
      reversible: true,
    });
    rollbackConstraints.push({
      code: "STALE_SNAPSHOT_BLOCKS_UNSAFE_COMMIT",
      reversibility: "partially_reversible",
      constraint:
        "Snapshot age exceeds freshness threshold; committing without a fresh snapshot risks unpreviewed user impact.",
      preCommitRequirement:
        "Re-run simulation preview with a fresh population snapshot observed within the last 300 seconds.",
      rollbackProcedure:
        "Capture a fresh point-in-time snapshot before applying or rolling back the policy.",
      recoverySteps: [
        "Fetch latest population state from active repositories.",
        "Re-run POST /policy/simulations/preview to obtain a fresh commitToken.",
      ],
    });
  } else if (snapshot.isSampled) {
    completeness = "partial_sample";
    warnings.push(
      `Simulation evaluated against a sampled population snapshot (${(snapshot.users ?? []).length} of ${snapshot.totalPopulationUsers ?? "unknown"} users).`,
    );
  }

  // Run domain-specific impact analysis
  if (input.domain === "trading") {
    evaluateTradingPolicyImpact(
      current as TradingPolicy,
      effectiveProposed as TradingPolicy,
      snapshot,
      affectedRecords,
      expectedSideEffects,
      rollbackConstraints,
      warnings,
    );
  } else if (input.domain === "defi_adapters") {
    evaluateDeFiAdapterPolicyImpact(
      current as DeFiAdapterPolicy,
      effectiveProposed as DeFiAdapterPolicy,
      snapshot,
      affectedRecords,
      expectedSideEffects,
      rollbackConstraints,
      warnings,
    );
  } else if (input.domain === "portfolio_rebalancing") {
    evaluatePortfolioPolicyImpact(
      current as PortfolioRebalancingPolicy,
      effectiveProposed as PortfolioRebalancingPolicy,
      snapshot,
      affectedRecords,
      expectedSideEffects,
      rollbackConstraints,
      warnings,
    );
  } else if (input.domain === "auth_access") {
    evaluateAuthAccessPolicyImpact(
      current as AuthAccessPolicy,
      effectiveProposed as AuthAccessPolicy,
      snapshot,
      affectedRecords,
      expectedSideEffects,
      rollbackConstraints,
      warnings,
    );
  } else if (input.domain === "notification_routing") {
    evaluateNotificationPolicyImpact(
      current as NotificationRoutingPolicy,
      effectiveProposed as NotificationRoutingPolicy,
      snapshot,
      affectedRecords,
      expectedSideEffects,
      rollbackConstraints,
      warnings,
    );
  }

  // Ensure default rollback constraint is present when no destructive constraint was triggered
  if (rollbackConstraints.length === 0) {
    rollbackConstraints.push({
      code: "CONFIG_REVERT_FULLY_SUPPORTED",
      reversibility: "fully_reversible",
      constraint:
        "No destructive or one-way state transitions detected; configuration can be reverted cleanly.",
      preCommitRequirement:
        "Verify diffs and record current configuration version in audit log.",
      rollbackProcedure:
        "Invoke POST /policy/simulations/rollback/:commitId or restore previous policy configuration values.",
      recoverySteps: [
        "Revert policy configuration to previous snapshot values.",
        "Verify /policy/simulations/active matches prior digest.",
      ],
    });
  }

  // Sort affected records, side effects, and rollback constraints deterministically
  affectedRecords.sort((a, b) => a.recordId.localeCompare(b.recordId));

  const affectedUserSet = new Set<string>(
    affectedRecords.map((r) => r.ownerId),
  );
  const affectedUserIds = Array.from(affectedUserSet).sort();

  const affectedRecordsByType: Record<string, number> = {};
  for (const rec of affectedRecords) {
    affectedRecordsByType[rec.recordType] =
      (affectedRecordsByType[rec.recordType] ?? 0) + 1;
  }

  const totalUsersEvaluated = (snapshot.users ?? []).length;
  const totalRecordsEvaluated =
    (snapshot.users ?? []).length +
    (snapshot.pendingTrades ?? []).length +
    (snapshot.portfolios ?? []).length +
    (snapshot.defiPositions ?? []).length +
    (snapshot.notificationPreferences ?? []).length;

  let estimatedTotalAffectedUsers = affectedUserIds.length;
  if (
    snapshot.isSampled &&
    snapshot.totalPopulationUsers &&
    totalUsersEvaluated > 0
  ) {
    const scale = snapshot.totalPopulationUsers / totalUsersEvaluated;
    estimatedTotalAffectedUsers = Math.round(affectedUserIds.length * scale);
    expectedSideEffects.push({
      code: "PARTIAL_SAMPLE_EXTRAPOLATION",
      severity: "info",
      subsystem: "observability",
      description: `Extrapolated ${estimatedTotalAffectedUsers} affected users across total population of ${snapshot.totalPopulationUsers} from sample ratio ${scale.toFixed(2)}x.`,
      estimatedAffectedCount: estimatedTotalAffectedUsers,
      reversible: true,
    });
  }

  const affectedSummary: AffectedPopulationSummary = {
    totalUsersEvaluated,
    affectedUserCount: affectedUserIds.length,
    affectedUserIds,
    totalRecordsEvaluated,
    affectedRecordCount: affectedRecords.length,
    affectedRecordsByType,
    affectedRecords,
    completeness,
    estimatedTotalAffectedUsers,
  };

  const reversibility = deriveReversibility(
    affectedRecords,
    expectedSideEffects,
    rollbackConstraints,
  );
  const impactSeverity = deriveImpactSeverity(
    validationErrors,
    affectedSummary,
    expectedSideEffects,
    reversibility,
  );
  const status = deriveSimulationStatus(
    validationErrors,
    completeness,
    impactSeverity,
    reversibility,
    affectedSummary,
  );

  const requiresCommitToken =
    status === "high_impact_review_required" ||
    reversibility !== "fully_reversible" ||
    impactSeverity === "high" ||
    impactSeverity === "critical";

  const commitToken = computeCommitToken(
    input.domain,
    current,
    effectiveProposed,
    snapshot.version,
  );

  const corePayload = {
    domain: input.domain,
    asOf,
    snapshotVersion: snapshot.version,
    snapshotObservedAt: snapshot.observedAt,
    status,
    impactSeverity,
    reversibility,
    requiresCommitToken,
    commitToken,
    currentPolicy: current,
    effectiveProposedPolicy: effectiveProposed,
    diffs,
    affectedSummary,
    expectedSideEffects,
    rollbackConstraints,
    warnings,
    validationErrors,
  };

  const digest = computeDigest("policy-simulation-preview:v1", corePayload);
  const simulationId = `psim:${input.domain}:${digest.slice(0, 16)}`;

  return {
    simulationId,
    dryRun: true,
    readOnly: true,
    ...corePayload,
    digest,
  };
}

function computeAgeSeconds(asOf: string, observedAt: string): number {
  const nowMs = Date.parse(asOf);
  const obsMs = Date.parse(observedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(obsMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (nowMs - obsMs) / 1000);
}

function computePolicyDiffs<D extends PolicyDomain>(
  domain: D,
  current: DomainPolicyMap[D],
  proposed: DomainPolicyMap[D],
): PolicyFieldDiff[] {
  const currentRec = current as unknown as Record<string, unknown>;
  const proposedRec = proposed as unknown as Record<string, unknown>;
  const keys = Array.from(
    new Set([...Object.keys(currentRec), ...Object.keys(proposedRec)]),
  ).sort();

  return keys.map((field) => {
    const prev = currentRec[field];
    const next = proposedRec[field];
    const equal = canonicalizeValue(prev) === canonicalizeValue(next);
    if (equal) {
      return {
        field,
        previousValue: prev ?? null,
        proposedValue: next ?? null,
        changeType: "unchanged",
        summary: `${domain}.${field} remains unchanged.`,
      };
    }

    let changeType: PolicyFieldDiff["changeType"] = "modified";
    if (typeof prev === "boolean" && typeof next === "boolean") {
      changeType = "toggled";
    } else if (typeof prev === "number" && typeof next === "number") {
      // Determine tightened vs relaxed based on field semantics
      const lowerIsTighter =
        field === "maxOrderAmount" ||
        field === "maxSlippageBps" ||
        field === "maxSingleAssetWeightPct" ||
        field === "sessionTtlMinutes" ||
        field === "maxDeliveryRetries";
      const higherIsTighter =
        field === "minHealthFactor" ||
        field === "minKycTier" ||
        field === "minTradeSizeUsd";
      if (lowerIsTighter) {
        changeType = next < prev ? "tightened" : "relaxed";
      } else if (higherIsTighter) {
        changeType = next > prev ? "tightened" : "relaxed";
      }
    } else if (Array.isArray(prev) && Array.isArray(next)) {
      if (field === "disallowedRoles" || field === "mandatorySecurityChannels") {
        changeType = next.length > prev.length ? "tightened" : "relaxed";
      } else {
        changeType = next.length < prev.length ? "tightened" : "relaxed";
      }
    } else if (field === "allowedAssets") {
      if (prev === undefined && Array.isArray(next)) {
        changeType = "tightened";
      } else if (Array.isArray(prev) && next === undefined) {
        changeType = "relaxed";
      }
    }

    return {
      field,
      previousValue: prev ?? null,
      proposedValue: next ?? null,
      changeType,
      summary: `${domain}.${field} changed from ${JSON.stringify(prev ?? null)} to ${JSON.stringify(next ?? null)} (${changeType}).`,
    };
  });
}

function evaluateTradingPolicyImpact(
  current: TradingPolicy,
  proposed: TradingPolicy,
  snapshot: PolicySimulationSnapshot,
  affectedRecords: AffectedRecordPreview[],
  sideEffects: ExpectedSideEffect[],
  rollbackConstraints: RollbackConstraint[],
  warnings: string[],
): void {
  const trades = snapshot.pendingTrades ?? [];
  const portfolios = snapshot.portfolios ?? [];

  if (current.enabled && !proposed.enabled) {
    warnings.push(
      "Disabling trading globally will reject all pending and incoming trade executions immediately.",
    );
    sideEffects.push({
      code: "TRADING_HALTED_GLOBALLY",
      severity: "critical",
      subsystem: "trading",
      description:
        "All trade executions via POST /trading/execute and portfolio rebalancing will be rejected with TRADING_DISABLED.",
      estimatedAffectedCount: trades.length,
      reversible: false,
    });
  }

  let rejectedTradeCount = 0;
  for (const trade of trades) {
    const asset = trade.asset.trim().toUpperCase();
    const side = trade.side as TradeSide;

    const wasAllowed = isTradeAllowedByPolicy(trade.amount, asset, side, current);
    const nowAllowed = isTradeAllowedByPolicy(
      trade.amount,
      asset,
      side,
      proposed,
    );

    if (wasAllowed.allowed && !nowAllowed.allowed) {
      rejectedTradeCount++;
      affectedRecords.push({
        recordId: trade.tradeId,
        recordType: "pending_trade",
        ownerId: maskIdentifier(trade.userId),
        impactType: "blocked",
        reversible: false,
        reason: nowAllowed.reason,
        beforeState: { status: "eligible", asset, amount: trade.amount, side },
        afterState: {
          status: "rejected",
          violationCode: nowAllowed.code,
          asset,
          amount: trade.amount,
        },
      });
    }
  }

  if (rejectedTradeCount > 0) {
    sideEffects.push({
      code: "PENDING_TRADES_REJECTED",
      severity: rejectedTradeCount >= 2 || !proposed.enabled ? "high" : "warning",
      subsystem: "trading",
      description: `${rejectedTradeCount} pending trade(s) will be rejected under the proposed trading policy.`,
      estimatedAffectedCount: rejectedTradeCount,
      reversible: false,
    });
    rollbackConstraints.push({
      code: "REJECTED_TRADES_REQUIRE_RESUBMISSION",
      reversibility: "partially_reversible",
      constraint:
        "Reverting the trading policy restores future trade eligibility, but rejected in-flight orders are not automatically re-submitted.",
      preCommitRequirement:
        "Drain or notify owners of queued orders exceeding the new limit or asset/side restrictions.",
      rollbackProcedure:
        "Revert trading policy parameters and notify clients that rejected idempotency keys can be re-issued with fresh keys.",
      recoverySteps: [
        "Restore previous TRADING_ENABLED / TRADING_MAX_ORDER_AMOUNT / TRADING_ALLOWED_ASSETS / TRADING_ALLOWED_SIDES values.",
        "Query audit logs for trades rejected with policy violation codes during the active window.",
        "Instruct affected clients or rebalancing workers to resubmit with new idempotency keys.",
      ],
    });
  }

  // Check portfolios holding assets removed from allowedAssets
  if (proposed.allowedAssets && proposed.allowedAssets.length > 0) {
    let affectedPortfolioCount = 0;
    for (const portfolio of portfolios) {
      const disallowedTargets = Object.keys(portfolio.targetAllocations).filter(
        (ticker) =>
          (portfolio.targetAllocations[ticker] ?? 0) > 0 &&
          !proposed.allowedAssets!.includes(ticker.trim().toUpperCase()),
      );
      if (disallowedTargets.length > 0) {
        affectedPortfolioCount++;
        affectedRecords.push({
          recordId: portfolio.portfolioId,
          recordType: "portfolio",
          ownerId: maskIdentifier(portfolio.userId),
          impactType: "degraded",
          reversible: true,
          reason: `Portfolio holds target allocations in disallowed asset(s): ${disallowedTargets.join(", ")}. Rebalancing trades for these assets will fail.`,
          beforeState: {
            rebalanceable: true,
            assets: Object.keys(portfolio.targetAllocations).join(","),
          },
          afterState: {
            rebalanceable: false,
            blockedAssets: disallowedTargets.join(","),
          },
        });
      }
    }

    if (affectedPortfolioCount > 0) {
      sideEffects.push({
        code: "PORTFOLIO_ALLOCATIONS_INVALIDATED",
        severity: "warning",
        subsystem: "portfolio",
        description: `${affectedPortfolioCount} portfolio(s) contain target allocations for assets excluded from TRADING_ALLOWED_ASSETS.`,
        estimatedAffectedCount: affectedPortfolioCount,
        reversible: true,
      });
    }
  }
}

function isTradeAllowedByPolicy(
  amount: number,
  asset: string,
  side: TradeSide,
  policy: TradingPolicy,
): { allowed: true } | { allowed: false; code: string; reason: string } {
  if (!policy.enabled) {
    return {
      allowed: false,
      code: "TRADING_DISABLED",
      reason: "Trading is disabled globally.",
    };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      allowed: false,
      code: "INVALID_TRADE_AMOUNT",
      reason: "Trade amount must be greater than zero.",
    };
  }
  if (amount > policy.maxOrderAmount) {
    return {
      allowed: false,
      code: "TRADE_AMOUNT_LIMIT_EXCEEDED",
      reason: `Trade amount ${amount} exceeds proposed maxOrderAmount of ${policy.maxOrderAmount}.`,
    };
  }
  if (policy.allowedAssets && !policy.allowedAssets.includes(asset)) {
    return {
      allowed: false,
      code: "ASSET_NOT_ALLOWED",
      reason: `Asset ${asset} is not in proposed allowedAssets (${policy.allowedAssets.join(", ")}).`,
    };
  }
  if (!policy.allowedSides.includes(side)) {
    return {
      allowed: false,
      code: "TRADE_SIDE_NOT_ALLOWED",
      reason: `Trade side '${side}' is not in proposed allowedSides (${policy.allowedSides.join(", ")}).`,
    };
  }
  return { allowed: true };
}

function evaluateDeFiAdapterPolicyImpact(
  current: DeFiAdapterPolicy,
  proposed: DeFiAdapterPolicy,
  snapshot: PolicySimulationSnapshot,
  affectedRecords: AffectedRecordPreview[],
  sideEffects: ExpectedSideEffect[],
  rollbackConstraints: RollbackConstraint[],
  warnings: string[],
): void {
  const positions = snapshot.defiPositions ?? [];
  let strandedCount = 0;
  let emergencyUnwindCount = 0;
  let healthViolationCount = 0;

  for (const pos of positions) {
    const adapter = pos.adapterId.trim().toLowerCase();
    const chain = pos.chain.trim().toLowerCase();

    const adapterDisabled =
      current.enabledAdapters.includes(adapter) &&
      !proposed.enabledAdapters.includes(adapter);
    const chainDisallowed =
      current.allowedChains.includes(chain) &&
      !proposed.allowedChains.includes(chain);
    const healthBreached =
      pos.healthFactor >= current.minHealthFactor &&
      pos.healthFactor < proposed.minHealthFactor;
    const slippageBreached =
      pos.estimatedExitSlippageBps <= current.maxSlippageBps &&
      pos.estimatedExitSlippageBps > proposed.maxSlippageBps;

    if (
      proposed.emergencyExitOnly ||
      adapterDisabled ||
      chainDisallowed ||
      healthBreached ||
      slippageBreached
    ) {
      const triggersUnwind =
        proposed.emergencyExitOnly || adapterDisabled || healthBreached;
      if (triggersUnwind) {
        emergencyUnwindCount++;
      } else {
        strandedCount++;
      }
      if (healthBreached) {
        healthViolationCount++;
      }

      const reasons: string[] = [];
      if (proposed.emergencyExitOnly && !current.emergencyExitOnly) {
        reasons.push("emergencyExitOnly mode activated");
      }
      if (adapterDisabled) {
        reasons.push(`adapter '${adapter}' disabled`);
      }
      if (chainDisallowed) {
        reasons.push(`chain '${chain}' removed from allowedChains`);
      }
      if (healthBreached) {
        reasons.push(
          `position healthFactor ${pos.healthFactor} falls below proposed minHealthFactor ${proposed.minHealthFactor}`,
        );
      }
      if (slippageBreached) {
        reasons.push(
          `estimated exit slippage ${pos.estimatedExitSlippageBps}bps exceeds proposed maxSlippageBps ${proposed.maxSlippageBps}bps`,
        );
      }

      affectedRecords.push({
        recordId: pos.positionId,
        recordType: "defi_position",
        ownerId: maskIdentifier(pos.userId),
        impactType: triggersUnwind ? "force_unwound" : "blocked",
        reversible: !triggersUnwind,
        reason: `DeFi position affected: ${reasons.join("; ")}.`,
        beforeState: {
          adapterId: adapter,
          chain,
          healthFactor: pos.healthFactor,
          status: "active",
        },
        afterState: {
          adapterId: adapter,
          chain,
          healthFactor: pos.healthFactor,
          status: triggersUnwind ? "emergency_exit_queued" : "adapter_blocked",
        },
      });
    }
  }

  if (emergencyUnwindCount > 0) {
    warnings.push(
      `${emergencyUnwindCount} active DeFi position(s) will be queued for irreversible on-chain emergency unwinding or collateral deleveraging.`,
    );
    sideEffects.push({
      code: "DEFI_EMERGENCY_UNWIND_TRIGGERED",
      severity: "critical",
      subsystem: "defi",
      description: `${emergencyUnwindCount} DeFi position(s) trigger on-chain emergency exit / deleveraging Jobs on 'defi-emergency-exit' queue.`,
      estimatedAffectedCount: emergencyUnwindCount,
      reversible: false,
    });
    rollbackConstraints.push({
      code: "IRREVERSIBLE_ONCHAIN_DEFI_EXIT",
      reversibility: "irreversible",
      constraint:
        "On-chain DeFi emergency exits and collateral liquidations settle on external protocols (Aave/Compound) and cannot be rolled back by reverting API config.",
      preCommitRequirement:
        "Verify protocol liquidity, slippage tolerance, and pause 'defi-emergency-exit' worker if dry-run only is intended.",
      rollbackProcedure:
        "Revert DeFi adapter policy immediately to stop unsubmitted jobs in 'defi-emergency-exit', then reconcile already settled on-chain transactions.",
      recoverySteps: [
        "Pause 'defi-emergency-exit' Bull queue before reverting config to halt in-flight unwinds.",
        "Restore enabledAdapters, minHealthFactor, and emergencyExitOnly to previous values.",
        "Run Stellar/EVM position reconciliation to re-sync positions that already exited on-chain.",
      ],
    });
  }

  if (strandedCount > 0) {
    sideEffects.push({
      code: "DEFI_ADAPTER_POSITIONS_STRANDED",
      severity: "high",
      subsystem: "defi",
      description: `${strandedCount} DeFi position(s) will be blocked from rebalancing or exiting due to chain or slippage constraints.`,
      estimatedAffectedCount: strandedCount,
      reversible: true,
    });
  }

  if (healthViolationCount > 0) {
    sideEffects.push({
      code: "DEFI_LIQUIDATION_THRESHOLD_TIGHTENED",
      severity: "high",
      subsystem: "defi",
      description: `${healthViolationCount} DeFi position(s) fall below the tightened minHealthFactor (${proposed.minHealthFactor}).`,
      estimatedAffectedCount: healthViolationCount,
      reversible: false,
    });
  }
}

function evaluatePortfolioPolicyImpact(
  current: PortfolioRebalancingPolicy,
  proposed: PortfolioRebalancingPolicy,
  snapshot: PolicySimulationSnapshot,
  affectedRecords: AffectedRecordPreview[],
  sideEffects: ExpectedSideEffect[],
  rollbackConstraints: RollbackConstraint[],
  warnings: string[],
): void {
  const portfolios = snapshot.portfolios ?? [];
  let weightInvalidatedCount = 0;
  let newlyTriggeredRebalanceCount = 0;
  let suppressedRebalanceCount = 0;

  for (const portfolio of portfolios) {
    const maxWeight = Math.max(
      0,
      ...Object.values(portfolio.targetAllocations),
    );
    const weightViolated =
      maxWeight <= current.maxSingleAssetWeightPct &&
      maxWeight > proposed.maxSingleAssetWeightPct;

    const wasTriggeringDrift =
      current.autoRebalanceEnabled &&
      portfolio.autoRebalanceOptIn &&
      portfolio.currentDriftPct >= current.driftThresholdPct &&
      (portfolio.pendingRebalanceTradeUsd ?? 0) >= current.minTradeSizeUsd;

    const nowTriggeringDrift =
      proposed.autoRebalanceEnabled &&
      portfolio.autoRebalanceOptIn &&
      portfolio.currentDriftPct >= proposed.driftThresholdPct &&
      (portfolio.pendingRebalanceTradeUsd ?? 0) >= proposed.minTradeSizeUsd;

    if (weightViolated || wasTriggeringDrift !== nowTriggeringDrift) {
      const reasons: string[] = [];
      let impactType: AffectedRecordPreview["impactType"] = "modified" as any;

      if (weightViolated) {
        weightInvalidatedCount++;
        impactType = "invalidated";
        reasons.push(
          `highest target weight ${maxWeight}% exceeds proposed maxSingleAssetWeightPct ${proposed.maxSingleAssetWeightPct}%`,
        );
      }
      if (!wasTriggeringDrift && nowTriggeringDrift) {
        newlyTriggeredRebalanceCount++;
        if (!weightViolated) impactType = "requeued";
        reasons.push(
          `portfolio drift ${portfolio.currentDriftPct}% now triggers automatic rebalancing (threshold lowered to ${proposed.driftThresholdPct}%)`,
        );
      }
      if (wasTriggeringDrift && !nowTriggeringDrift) {
        suppressedRebalanceCount++;
        if (!weightViolated) impactType = "blocked";
        reasons.push(
          `pending rebalance ($${portfolio.pendingRebalanceTradeUsd ?? 0}, drift ${portfolio.currentDriftPct}%) suppressed under proposed policy`,
        );
      }

      affectedRecords.push({
        recordId: portfolio.portfolioId,
        recordType: "portfolio",
        ownerId: maskIdentifier(portfolio.userId),
        impactType,
        reversible: !nowTriggeringDrift,
        reason: `Portfolio affected: ${reasons.join("; ")}.`,
        beforeState: {
          maxAssetWeightPct: maxWeight,
          currentDriftPct: portfolio.currentDriftPct,
          autoRebalanceEligible: wasTriggeringDrift,
        },
        afterState: {
          maxAssetWeightPct: maxWeight,
          currentDriftPct: portfolio.currentDriftPct,
          autoRebalanceEligible: nowTriggeringDrift,
          allocationValid: !weightViolated,
        },
      });
    }
  }

  if (weightInvalidatedCount > 0) {
    warnings.push(
      `${weightInvalidatedCount} portfolio(s) have persisted target allocations exceeding maxSingleAssetWeightPct (${proposed.maxSingleAssetWeightPct}%).`,
    );
    sideEffects.push({
      code: "PORTFOLIO_ALLOCATIONS_INVALIDATED",
      severity: "high",
      subsystem: "portfolio",
      description: `${weightInvalidatedCount} portfolio(s) fail target allocation concentration constraints until owners update their target weights.`,
      estimatedAffectedCount: weightInvalidatedCount,
      reversible: true,
    });
    rollbackConstraints.push({
      code: "PORTFOLIO_TARGETS_REQUIRE_VERSION_RESTORE",
      reversibility: "partially_reversible",
      constraint:
        "Portfolios forced to re-save target allocations create new TargetAllocationVersion rows; config rollback restores the limit but does not revert user-modified allocation versions.",
      preCommitRequirement:
        "Snapshot TargetAllocationVersion table or notify affected portfolio owners before tightening concentration limits.",
      rollbackProcedure:
        "Revert maxSingleAssetWeightPct and, if needed, restore prior TargetAllocationVersion per portfolio.",
      recoverySteps: [
        "Revert portfolio_rebalancing policy configuration.",
        "Inspect GET /portfolio/:portfolioId/allocations/history for versions created after policy commit.",
      ],
    });
  }

  if (newlyTriggeredRebalanceCount > 0) {
    sideEffects.push({
      code: "AUTO_REBALANCE_WAVE_TRIGGERED",
      severity: "warning",
      subsystem: "portfolio",
      description: `${newlyTriggeredRebalanceCount} portfolio(s) immediately qualify for automated rebalancing trades.`,
      estimatedAffectedCount: newlyTriggeredRebalanceCount,
      reversible: false,
    });
    rollbackConstraints.push({
      code: "IN_FLIGHT_QUEUE_DRAIN_REQUIRED",
      reversibility: "partially_reversible",
      constraint:
        "Lowering driftThresholdPct triggers immediate rebalancing trades; trades already executed cannot be reversed by restoring the threshold.",
      preCommitRequirement:
        "Verify trade execution capacity and rate limits before lowering driftThresholdPct.",
      rollbackProcedure:
        "Raise driftThresholdPct back to previous value and drain unexecuted rebalancing jobs.",
      recoverySteps: [
        "Revert driftThresholdPct / autoRebalanceEnabled to prior values.",
        "Check RebalancingService execution logs for trades executed during the window.",
      ],
    });
  }

  if (suppressedRebalanceCount > 0) {
    sideEffects.push({
      code: "AUTO_REBALANCE_SUPPRESSED",
      severity: "info",
      subsystem: "portfolio",
      description: `${suppressedRebalanceCount} portfolio(s) will have scheduled auto-rebalancing suppressed.`,
      estimatedAffectedCount: suppressedRebalanceCount,
      reversible: true,
    });
  }
}

function evaluateAuthAccessPolicyImpact(
  current: AuthAccessPolicy,
  proposed: AuthAccessPolicy,
  snapshot: PolicySimulationSnapshot,
  affectedRecords: AffectedRecordPreview[],
  sideEffects: ExpectedSideEffect[],
  rollbackConstraints: RollbackConstraint[],
  warnings: string[],
): void {
  const users = snapshot.users ?? [];
  let revokedSessionCount = 0;
  let mfaEnforcedUserCount = 0;
  let roleRestrictedCount = 0;

  for (const user of users) {
    const role = user.role.trim().toUpperCase();
    const roleNewlyDisallowed =
      !current.disallowedRoles.includes(role) &&
      proposed.disallowedRoles.includes(role);
    const kycInsufficient =
      user.kycTier >= current.minKycTier && user.kycTier < proposed.minKycTier;
    const ttlExpired =
      user.sessionAgeMinutes <= current.sessionTtlMinutes &&
      user.sessionAgeMinutes > proposed.sessionTtlMinutes;
    const unverifiedRevoked =
      !current.revokeUnverifiedSessions &&
      proposed.revokeUnverifiedSessions &&
      (!user.mfaEnabled || user.kycTier < proposed.minKycTier);
    const mfaNewlyRequired =
      !current.requireMfaForSensitiveActions &&
      proposed.requireMfaForSensitiveActions &&
      !user.mfaEnabled;

    if (
      roleNewlyDisallowed ||
      kycInsufficient ||
      ttlExpired ||
      unverifiedRevoked ||
      mfaNewlyRequired
    ) {
      const sessionTerminated =
        roleNewlyDisallowed || ttlExpired || unverifiedRevoked;
      if (sessionTerminated && user.activeSessionCount > 0) {
        revokedSessionCount += user.activeSessionCount;
      }
      if (mfaNewlyRequired) {
        mfaEnforcedUserCount++;
      }
      if (roleNewlyDisallowed) {
        roleRestrictedCount++;
      }

      const reasons: string[] = [];
      if (roleNewlyDisallowed) {
        reasons.push(`role '${role}' added to disallowedRoles`);
      }
      if (unverifiedRevoked) {
        reasons.push(
          `active sessions (${user.activeSessionCount}) revoked due to revokeUnverifiedSessions`,
        );
      }
      if (ttlExpired) {
        reasons.push(
          `session age ${user.sessionAgeMinutes}m exceeds reduced sessionTtlMinutes ${proposed.sessionTtlMinutes}m`,
        );
      }
      if (kycInsufficient) {
        reasons.push(
          `user kycTier ${user.kycTier} is below proposed minKycTier ${proposed.minKycTier}`,
        );
      }
      if (mfaNewlyRequired) {
        reasons.push("MFA step-up required for sensitive operations");
      }

      affectedRecords.push({
        recordId: `sess:${maskIdentifier(user.userId)}`,
        recordType: "user_session",
        ownerId: maskIdentifier(user.userId),
        impactType: sessionTerminated ? "invalidated" : "blocked",
        reversible: !sessionTerminated,
        reason: `Auth access impact: ${reasons.join("; ")}.`,
        beforeState: {
          role,
          mfaEnabled: user.mfaEnabled,
          kycTier: user.kycTier,
          activeSessions: user.activeSessionCount,
        },
        afterState: {
          role,
          mfaEnabled: user.mfaEnabled,
          kycTier: user.kycTier,
          activeSessions: sessionTerminated ? 0 : user.activeSessionCount,
          requiresStepUp: mfaNewlyRequired || kycInsufficient,
        },
      });
    }
  }

  if (revokedSessionCount > 0) {
    warnings.push(
      `${revokedSessionCount} active user session(s) will be immediately invalidated; affected users must re-authenticate.`,
    );
    sideEffects.push({
      code: "ACTIVE_SESSIONS_REVOKED",
      severity: "critical",
      subsystem: "auth",
      description: `${revokedSessionCount} active JWT/session(s) will be terminated immediately.`,
      estimatedAffectedCount: revokedSessionCount,
      reversible: false,
    });
    rollbackConstraints.push({
      code: "IRREVERSIBLE_SESSION_REVOCATION",
      reversibility: "irreversible",
      constraint:
        "Revoked sessions and invalidated JWT/refresh tokens cannot be silently restored by rolling back auth policy configuration; users must re-authenticate.",
      preCommitRequirement:
        "Confirm communications banner is scheduled and verify that service actors / admin accounts are not using short-lived interactive sessions.",
      rollbackProcedure:
        "Revert auth_access policy settings to allow affected users to log back in without friction.",
      recoverySteps: [
        "Revert revokeUnverifiedSessions, sessionTtlMinutes, or disallowedRoles to previous values.",
        "Clear auth rate-limit buckets so returning users are not throttled during re-login.",
        "Monitor /auth/verify and /auth/challenge error rates.",
      ],
    });
  }

  if (mfaEnforcedUserCount > 0) {
    sideEffects.push({
      code: "MFA_STEP_UP_ENFORCED",
      severity: "warning",
      subsystem: "auth",
      description: `${mfaEnforcedUserCount} user(s) without MFA enabled will be challenged or blocked on sensitive actions.`,
      estimatedAffectedCount: mfaEnforcedUserCount,
      reversible: true,
    });
  }

  if (roleRestrictedCount > 0) {
    sideEffects.push({
      code: "PRIVILEGED_ROLES_RESTRICTED",
      severity: "high",
      subsystem: "auth",
      description: `${roleRestrictedCount} user(s) hold roles newly restricted by disallowedRoles.`,
      estimatedAffectedCount: roleRestrictedCount,
      reversible: false,
    });
  }
}

function evaluateNotificationPolicyImpact(
  current: NotificationRoutingPolicy,
  proposed: NotificationRoutingPolicy,
  snapshot: PolicySimulationSnapshot,
  affectedRecords: AffectedRecordPreview[],
  sideEffects: ExpectedSideEffect[],
  rollbackConstraints: RollbackConstraint[],
  warnings: string[],
): void {
  const prefs = snapshot.notificationPreferences ?? [];
  let overriddenCount = 0;
  let rebatchedCount = 0;

  for (const pref of prefs) {
    const missingMandatory = proposed.mandatorySecurityChannels.filter(
      (ch) => !pref.enabledChannels.includes(ch),
    );
    const newlyForcedChannels = missingMandatory.filter(
      (ch) => !current.mandatorySecurityChannels.includes(ch),
    );
    const marketingSuppressed =
      !current.suppressMarketingChannels &&
      proposed.suppressMarketingChannels &&
      pref.marketingOptIn;
    const digestChanged =
      current.digestWindowMinutes !== proposed.digestWindowMinutes &&
      pref.pendingDigestCount > 0;

    if (
      newlyForcedChannels.length > 0 ||
      marketingSuppressed ||
      digestChanged
    ) {
      const reasons: string[] = [];
      if (newlyForcedChannels.length > 0) {
        overriddenCount++;
        reasons.push(
          `mandatory security channel(s) [${newlyForcedChannels.join(", ")}] enforced over user preference`,
        );
      }
      if (marketingSuppressed) {
        overriddenCount++;
        reasons.push("marketing notifications suppressed globally");
      }
      if (digestChanged) {
        rebatchedCount += pref.pendingDigestCount;
        reasons.push(
          `${pref.pendingDigestCount} pending digest item(s) re-windowed from ${current.digestWindowMinutes}m to ${proposed.digestWindowMinutes}m`,
        );
      }

      affectedRecords.push({
        recordId: pref.preferenceId,
        recordType: "notification_preference",
        ownerId: maskIdentifier(pref.userId),
        impactType:
          newlyForcedChannels.length > 0 || marketingSuppressed
            ? "overridden"
            : "requeued",
        reversible: true,
        reason: `Notification routing impact: ${reasons.join("; ")}.`,
        beforeState: {
          enabledChannels: pref.enabledChannels.join(","),
          marketingOptIn: pref.marketingOptIn,
          digestWindowMinutes: current.digestWindowMinutes,
        },
        afterState: {
          effectiveChannels: Array.from(
            new Set([
              ...pref.enabledChannels,
              ...proposed.mandatorySecurityChannels,
            ]),
          ).join(","),
          effectiveMarketing: proposed.suppressMarketingChannels
            ? false
            : pref.marketingOptIn,
          digestWindowMinutes: proposed.digestWindowMinutes,
        },
      });
    }
  }

  if (overriddenCount > 0) {
    warnings.push(
      `${overriddenCount} user notification preference record(s) will be overridden by mandatory security routing or marketing suppression.`,
    );
    sideEffects.push({
      code: "NOTIFICATION_PREFERENCES_OVERRIDDEN",
      severity: "warning",
      subsystem: "notifications",
      description: `${overriddenCount} user preference(s) overridden to enforce mandatory security channels or marketing suppression.`,
      estimatedAffectedCount: overriddenCount,
      reversible: true,
    });
    rollbackConstraints.push({
      code: "NOTIFICATION_OVERRIDES_REQUIRE_SNAPSHOT_RESTORE",
      reversibility: "partially_reversible",
      constraint:
        "Notifications already dispatched via mandatory channels cannot be recalled, though user channel preferences remain intact on policy revert.",
      preCommitRequirement:
        "Ensure notification templates exist for all mandatorySecurityChannels before committing.",
      rollbackProcedure:
        "Revert notification_routing policy to restore user-selected channel filtering.",
      recoverySteps: [
        "Revert mandatorySecurityChannels and suppressMarketingChannels to previous configuration.",
        "Verify NotificationPreference entities were not destructively overwritten in storage.",
      ],
    });
  }

  if (rebatchedCount > 0) {
    sideEffects.push({
      code: "NOTIFICATION_DIGEST_REBATCHED",
      severity: "info",
      subsystem: "notifications",
      description: `${rebatchedCount} pending notification aggregation item(s) will be re-windowed to ${proposed.digestWindowMinutes}m.`,
      estimatedAffectedCount: rebatchedCount,
      reversible: true,
    });
  }
}

function deriveReversibility(
  affectedRecords: AffectedRecordPreview[],
  sideEffects: ExpectedSideEffect[],
  rollbackConstraints: RollbackConstraint[],
): PolicyReversibility {
  if (
    rollbackConstraints.some((c) => c.reversibility === "irreversible") ||
    sideEffects.some((s) => !s.reversible && s.severity === "critical")
  ) {
    return "irreversible";
  }
  if (
    rollbackConstraints.some(
      (c) => c.reversibility === "partially_reversible",
    ) ||
    affectedRecords.some((r) => !r.reversible) ||
    sideEffects.some((s) => !s.reversible)
  ) {
    return "partially_reversible";
  }
  return "fully_reversible";
}

function deriveImpactSeverity(
  validationErrors: string[],
  affectedSummary: AffectedPopulationSummary,
  sideEffects: ExpectedSideEffect[],
  reversibility: PolicyReversibility,
): PolicyImpactSeverity {
  if (
    validationErrors.length > 0 ||
    reversibility === "irreversible" ||
    sideEffects.some((s) => s.severity === "critical")
  ) {
    return "critical";
  }
  if (
    sideEffects.some((s) => s.severity === "high") ||
    affectedSummary.affectedRecordCount >= 3 ||
    reversibility === "partially_reversible"
  ) {
    return "high";
  }
  if (
    sideEffects.some((s) => s.severity === "warning") ||
    affectedSummary.affectedRecordCount > 0
  ) {
    return "medium";
  }
  return "low";
}

function deriveSimulationStatus(
  validationErrors: string[],
  completeness: SnapshotCompleteness,
  impactSeverity: PolicyImpactSeverity,
  reversibility: PolicyReversibility,
  affectedSummary: AffectedPopulationSummary,
): PolicySimulationStatus {
  if (validationErrors.length > 0) {
    return "blocked_invalid_policy";
  }
  if (
    reversibility === "irreversible" ||
    impactSeverity === "critical" ||
    impactSeverity === "high" ||
    completeness === "stale_snapshot"
  ) {
    return "high_impact_review_required";
  }
  if (
    reversibility === "partially_reversible" ||
    impactSeverity === "medium" ||
    affectedSummary.affectedRecordCount > 0 ||
    completeness === "partial_sample"
  ) {
    return "caution_required";
  }
  return "safe_to_apply";
}

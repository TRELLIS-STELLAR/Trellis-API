import type { TradeSide, TradingPolicy } from "./policy.types";

/**
 * Policy domains supported by the policy simulation preview engine.
 * Covers trading, DeFi protocol adapters, portfolio rebalancing constraints,
 * authentication/access controls, and notification/alert routing.
 */
export type PolicyDomain =
  | "trading"
  | "defi_adapters"
  | "portfolio_rebalancing"
  | "auth_access"
  | "notification_routing";

/**
 * Aggregate simulation verdict indicating whether the policy change can be
 * safely applied, requires maintainer caution, requires an explicit commit token
 * due to high-impact or irreversible side effects, or is blocked due to invalid
 * configuration / stale state.
 */
export type PolicySimulationStatus =
  | "safe_to_apply"
  | "caution_required"
  | "high_impact_review_required"
  | "blocked_invalid_policy";

/** Impact severity tier across affected users, records, and subsystems. */
export type PolicyImpactSeverity = "low" | "medium" | "high" | "critical";

/**
 * Reversibility classification of a policy change:
 * - `fully_reversible`: Reverting configuration immediately restores prior behavior with no data or state loss.
 * - `partially_reversible`: Configuration can be reverted, but in-flight rejections, overrides, or queued items require manual replay or user action.
 * - `irreversible`: Triggers destructive or one-way side effects (e.g. emergency DeFi position unwinding or immediate session/token revocation) that cannot be undone by reverting configuration.
 */
export type PolicyReversibility =
  | "fully_reversible"
  | "partially_reversible"
  | "irreversible";

/** Completeness of the population snapshot used during simulation. */
export type SnapshotCompleteness =
  | "complete"
  | "partial_sample"
  | "stale_snapshot";

/** DeFi protocol adapter policy configuration. */
export interface DeFiAdapterPolicy {
  enabledAdapters: string[];
  allowedChains: string[];
  maxSlippageBps: number;
  minHealthFactor: number;
  emergencyExitOnly: boolean;
}

/** Portfolio constraint and auto-rebalancing policy configuration. */
export interface PortfolioRebalancingPolicy {
  autoRebalanceEnabled: boolean;
  minTradeSizeUsd: number;
  maxSingleAssetWeightPct: number;
  driftThresholdPct: number;
}

/** Authentication, KYC, and session access policy configuration. */
export interface AuthAccessPolicy {
  requireMfaForSensitiveActions: boolean;
  minKycTier: number;
  sessionTtlMinutes: number;
  revokeUnverifiedSessions: boolean;
  disallowedRoles: string[];
}

/** Notification and mandatory alert routing policy configuration. */
export interface NotificationRoutingPolicy {
  mandatorySecurityChannels: string[];
  digestWindowMinutes: number;
  suppressMarketingChannels: boolean;
  maxDeliveryRetries: number;
}

/** Map of domain-specific policy configurations. */
export interface DomainPolicyMap {
  trading: TradingPolicy;
  defi_adapters: DeFiAdapterPolicy;
  portfolio_rebalancing: PortfolioRebalancingPolicy;
  auth_access: AuthAccessPolicy;
  notification_routing: NotificationRoutingPolicy;
}

/** Union of all supported policy configuration shapes. */
export type AnyDomainPolicy = DomainPolicyMap[PolicyDomain];

/** Snapshot of an active user/session evaluated during policy simulation. */
export interface SimulatedUserRecord {
  userId: string;
  role: string;
  mfaEnabled: boolean;
  kycTier: number;
  activeSessionCount: number;
  sessionAgeMinutes: number;
  apiKeyCount?: number;
}

/** Snapshot of a pending trade or order evaluated against trading policy changes. */
export interface SimulatedPendingTradeRecord {
  tradeId: string;
  userId: string;
  portfolioId?: string;
  asset: string;
  amount: number;
  side: TradeSide | string;
}

/** Snapshot of a portfolio evaluated against trading and rebalancing policy changes. */
export interface SimulatedPortfolioRecord {
  portfolioId: string;
  userId: string;
  totalValueUsd: number;
  targetAllocations: Record<string, number>;
  currentDriftPct: number;
  pendingRebalanceTradeUsd?: number;
  autoRebalanceOptIn: boolean;
}

/** Snapshot of an active DeFi position evaluated against DeFi adapter policy changes. */
export interface SimulatedDeFiPositionRecord {
  positionId: string;
  userId: string;
  adapterId: string;
  chain: string;
  asset: string;
  suppliedUsd: number;
  borrowedUsd: number;
  healthFactor: number;
  estimatedExitSlippageBps: number;
}

/** Snapshot of a user notification preference record evaluated against routing policy changes. */
export interface SimulatedNotificationPreferenceRecord {
  preferenceId: string;
  userId: string;
  enabledChannels: string[];
  marketingOptIn: boolean;
  digestFrequencyMinutes: number;
  pendingDigestCount: number;
}

/**
 * Point-in-time population and record snapshot evaluated by the simulation engine.
 */
export interface PolicySimulationSnapshot {
  version: string;
  observedAt: string;
  isSampled?: boolean;
  totalPopulationUsers?: number;
  users?: SimulatedUserRecord[];
  pendingTrades?: SimulatedPendingTradeRecord[];
  portfolios?: SimulatedPortfolioRecord[];
  defiPositions?: SimulatedDeFiPositionRecord[];
  notificationPreferences?: SimulatedNotificationPreferenceRecord[];
}

/** Field-level diff between the current and proposed policy. */
export interface PolicyFieldDiff {
  field: string;
  previousValue: unknown;
  proposedValue: unknown;
  changeType: "tightened" | "relaxed" | "toggled" | "modified" | "unchanged";
  summary: string;
}

/** Impact classification for an individual affected record. */
export type RecordImpactType =
  | "blocked"
  | "invalidated"
  | "force_unwound"
  | "requeued"
  | "overridden"
  | "degraded";

/** Preview of a single affected record or user resource. */
export interface AffectedRecordPreview {
  recordId: string;
  recordType:
    | "pending_trade"
    | "portfolio"
    | "defi_position"
    | "user_session"
    | "notification_preference";
  ownerId: string;
  impactType: RecordImpactType;
  reversible: boolean;
  reason: string;
  beforeState: Record<string, string | number | boolean | null>;
  afterState: Record<string, string | number | boolean | null>;
}

/** Aggregate summary of affected users and records. */
export interface AffectedPopulationSummary {
  totalUsersEvaluated: number;
  affectedUserCount: number;
  /** Redacted/masked user identifiers safe for maintainer preview logs and responses. */
  affectedUserIds: string[];
  totalRecordsEvaluated: number;
  affectedRecordCount: number;
  affectedRecordsByType: Record<string, number>;
  affectedRecords: AffectedRecordPreview[];
  completeness: SnapshotCompleteness;
  estimatedTotalAffectedUsers?: number;
}

/** Stable machine-readable codes for expected operational side effects. */
export type PolicySideEffectCode =
  | "TRADING_HALTED_GLOBALLY"
  | "PENDING_TRADES_REJECTED"
  | "PORTFOLIO_ALLOCATIONS_INVALIDATED"
  | "AUTO_REBALANCE_WAVE_TRIGGERED"
  | "AUTO_REBALANCE_SUPPRESSED"
  | "DEFI_ADAPTER_POSITIONS_STRANDED"
  | "DEFI_EMERGENCY_UNWIND_TRIGGERED"
  | "DEFI_LIQUIDATION_THRESHOLD_TIGHTENED"
  | "ACTIVE_SESSIONS_REVOKED"
  | "MFA_STEP_UP_ENFORCED"
  | "PRIVILEGED_ROLES_RESTRICTED"
  | "NOTIFICATION_PREFERENCES_OVERRIDDEN"
  | "NOTIFICATION_DIGEST_REBATCHED"
  | "STALE_SNAPSHOT_UNCERTAINTY"
  | "PARTIAL_SAMPLE_EXTRAPOLATION";

/** Expected side effect surfaced before committing a policy change. */
export interface ExpectedSideEffect {
  code: PolicySideEffectCode;
  severity: "info" | "warning" | "high" | "critical";
  subsystem:
    | "trading"
    | "portfolio"
    | "defi"
    | "auth"
    | "notifications"
    | "observability";
  description: string;
  estimatedAffectedCount: number;
  reversible: boolean;
}

/** Stable machine-readable codes for rollback constraints and recovery steps. */
export type RollbackConstraintCode =
  | "IRREVERSIBLE_ONCHAIN_DEFI_EXIT"
  | "IRREVERSIBLE_SESSION_REVOCATION"
  | "REJECTED_TRADES_REQUIRE_RESUBMISSION"
  | "PORTFOLIO_TARGETS_REQUIRE_VERSION_RESTORE"
  | "NOTIFICATION_OVERRIDES_REQUIRE_SNAPSHOT_RESTORE"
  | "IN_FLIGHT_QUEUE_DRAIN_REQUIRED"
  | "STALE_SNAPSHOT_BLOCKS_UNSAFE_COMMIT"
  | "CONFIG_REVERT_FULLY_SUPPORTED";

/** Rollback constraint and recovery guidance for maintainers. */
export interface RollbackConstraint {
  code: RollbackConstraintCode;
  reversibility: PolicyReversibility;
  constraint: string;
  preCommitRequirement: string;
  rollbackProcedure: string;
  recoverySteps: string[];
}

/** Input to the pure policy simulation engine. */
export interface PolicySimulationInput<
  D extends PolicyDomain = PolicyDomain,
> {
  domain: D;
  currentPolicy?: Partial<DomainPolicyMap[D]>;
  proposedPolicy: Partial<DomainPolicyMap[D]>;
  snapshot?: PolicySimulationSnapshot;
  asOf?: string;
  maxSnapshotAgeSeconds?: number;
}

/** Complete, deterministic policy simulation preview result. */
export interface PolicySimulationPreviewResult<
  D extends PolicyDomain = PolicyDomain,
> {
  simulationId: string;
  dryRun: true;
  readOnly: true;
  domain: D;
  asOf: string;
  snapshotVersion: string;
  snapshotObservedAt: string;
  status: PolicySimulationStatus;
  impactSeverity: PolicyImpactSeverity;
  reversibility: PolicyReversibility;
  requiresCommitToken: boolean;
  commitToken: string;
  currentPolicy: DomainPolicyMap[D];
  effectiveProposedPolicy: DomainPolicyMap[D];
  diffs: PolicyFieldDiff[];
  affectedSummary: AffectedPopulationSummary;
  expectedSideEffects: ExpectedSideEffect[];
  rollbackConstraints: RollbackConstraint[];
  warnings: string[];
  validationErrors: string[];
  digest: string;
}

/** Audit and rollback record created when a maintainer commits a simulated policy change. */
export interface PolicyCommitRecord<D extends PolicyDomain = PolicyDomain> {
  commitId: string;
  domain: D;
  actorId: string;
  reason: string;
  committedAt: string;
  simulationId: string;
  previewDigest: string;
  previousPolicy: DomainPolicyMap[D];
  appliedPolicy: DomainPolicyMap[D];
  reversibility: PolicyReversibility;
  impactSeverity: PolicyImpactSeverity;
  rollbackAvailable: boolean;
  rolledBackAt?: string;
  rolledBackBy?: string;
  rollbackReason?: string;
  rollbackConstraints: RollbackConstraint[];
}

/** Observability metrics snapshot for policy simulations, commits, and rollbacks. */
export interface PolicySimulationMetricsSnapshot {
  totalSimulations: number;
  totalCommits: number;
  totalBlockedCommits: number;
  totalRollbacks: number;
  byDomain: Record<PolicyDomain, number>;
  byStatus: Record<PolicySimulationStatus, number>;
  byImpactSeverity: Record<PolicyImpactSeverity, number>;
  byReversibility: Record<PolicyReversibility, number>;
}

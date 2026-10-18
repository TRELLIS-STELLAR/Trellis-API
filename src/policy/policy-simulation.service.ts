import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  CommitPolicyChangeDto,
  SimulatePolicyChangeDto,
} from "./dto/policy-simulation.dto";
import {
  computeDigest,
  defaultDomainPolicies,
  defaultSimulationSnapshot,
  simulatePolicyChange,
} from "./policy-simulation.rules";
import { PolicyService } from "./policy.service";
import {
  DomainPolicyMap,
  PolicyCommitRecord,
  PolicyDomain,
  PolicyImpactSeverity,
  PolicyReversibility,
  PolicySimulationMetricsSnapshot,
  PolicySimulationPreviewResult,
  PolicySimulationSnapshot,
  PolicySimulationStatus,
  RollbackConstraint,
} from "./policy.types";

export const POLICY_POPULATION_PROVIDER = "POLICY_POPULATION_PROVIDER";

export interface PolicyPopulationProvider {
  loadSnapshot(
    domain: PolicyDomain,
    asOf: string,
  ): Promise<PolicySimulationSnapshot> | PolicySimulationSnapshot;
}

export const POLICY_SIMULATION_EVENTS = {
  PREVIEWED: "policy.simulation.previewed",
  COMMITTED: "policy.simulation.committed",
  COMMIT_BLOCKED: "policy.simulation.commit_blocked",
  ROLLED_BACK: "policy.simulation.rolled_back",
} as const;

@Injectable()
export class PolicySimulationService {
  private readonly logger = new Logger(PolicySimulationService.name);
  private readonly activePolicies: DomainPolicyMap;
  private readonly commitHistory = new Map<string, PolicyCommitRecord>();

  private totalSimulations = 0;
  private totalCommits = 0;
  private totalBlockedCommits = 0;
  private totalRollbacks = 0;

  private readonly byDomain: Record<PolicyDomain, number> = {
    trading: 0,
    defi_adapters: 0,
    portfolio_rebalancing: 0,
    auth_access: 0,
    notification_routing: 0,
  };

  private readonly byStatus: Record<PolicySimulationStatus, number> = {
    safe_to_apply: 0,
    caution_required: 0,
    high_impact_review_required: 0,
    blocked_invalid_policy: 0,
  };

  private readonly byImpactSeverity: Record<PolicyImpactSeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  private readonly byReversibility: Record<PolicyReversibility, number> = {
    fully_reversible: 0,
    partially_reversible: 0,
    irreversible: 0,
  };

  constructor(
    @Optional() private readonly policyService?: PolicyService,
    @Optional()
    @Inject(POLICY_POPULATION_PROVIDER)
    private readonly populationProvider?: PolicyPopulationProvider,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {
    this.activePolicies = defaultDomainPolicies();
    if (this.policyService) {
      this.activePolicies.trading = this.policyService.getTradingPolicy();
    }
  }

  /**
   * Executes a read-only policy simulation preview for the specified domain.
   * Never mutates active policy configuration or user records.
   */
  async preview<D extends PolicyDomain = PolicyDomain>(
    dto: SimulatePolicyChangeDto & { domain: D },
    actorId = "anonymous",
  ): Promise<PolicySimulationPreviewResult<D>> {
    const asOf = dto.asOf ?? new Date().toISOString();
    const snapshot = await this.resolveSnapshot(dto.domain, asOf, dto.snapshot);
    const currentPolicy = (dto.currentPolicy ??
      this.getActivePolicy(dto.domain)) as Partial<DomainPolicyMap[D]>;

    const result = simulatePolicyChange<D>({
      domain: dto.domain,
      currentPolicy,
      proposedPolicy: dto.proposedPolicy as Partial<DomainPolicyMap[D]>,
      snapshot,
      asOf,
      maxSnapshotAgeSeconds: dto.maxSnapshotAgeSeconds,
    });

    this.recordSimulationMetrics(result);

    this.eventEmitter?.emit(POLICY_SIMULATION_EVENTS.PREVIEWED, {
      simulationId: result.simulationId,
      domain: result.domain,
      actorId,
      status: result.status,
      impactSeverity: result.impactSeverity,
      reversibility: result.reversibility,
      affectedUsers: result.affectedSummary.affectedUserCount,
      affectedRecords: result.affectedSummary.affectedRecordCount,
      digest: result.digest,
    });

    this.logger.log(
      `Policy simulation preview ${result.simulationId} domain=${result.domain} status=${result.status} severity=${result.impactSeverity} reversibility=${result.reversibility} affectedUsers=${result.affectedSummary.affectedUserCount}`,
    );

    return result;
  }

  /**
   * Evaluates and asserts that a proposed policy change is valid, uses a fresh
   * snapshot, and carries a matching `commitToken` when high-impact or irreversible.
   */
  async assertProceedable<D extends PolicyDomain = PolicyDomain>(
    dto: CommitPolicyChangeDto & { domain: D },
    actorId = "anonymous",
  ): Promise<PolicySimulationPreviewResult<D>> {
    const preview = await this.preview(dto, actorId);

    if (preview.validationErrors.length > 0) {
      this.totalBlockedCommits++;
      this.emitBlockedCommit(preview, actorId, "VALIDATION_FAILED");
      throw new BadRequestException({
        error: "POLICY_SIMULATION_VALIDATION_FAILED",
        message: "Proposed policy failed safety and schema validation checks.",
        domain: preview.domain,
        validationErrors: preview.validationErrors,
        simulationId: preview.simulationId,
      });
    }

    if (preview.affectedSummary.completeness === "stale_snapshot") {
      this.totalBlockedCommits++;
      this.emitBlockedCommit(preview, actorId, "STALE_POPULATION_SNAPSHOT");
      throw new BadRequestException({
        error: "POLICY_SIMULATION_SNAPSHOT_STALE",
        message:
          "Cannot commit policy change against a stale population snapshot. Re-run preview with a fresh snapshot.",
        domain: preview.domain,
        snapshotVersion: preview.snapshotVersion,
        snapshotObservedAt: preview.snapshotObservedAt,
        rollbackConstraints: preview.rollbackConstraints,
        simulationId: preview.simulationId,
      });
    }

    if (preview.requiresCommitToken) {
      if (!dto.commitToken || dto.commitToken.trim() !== preview.commitToken) {
        this.totalBlockedCommits++;
        this.emitBlockedCommit(
          preview,
          actorId,
          "MISSING_OR_MISMATCHED_COMMIT_TOKEN",
        );
        throw new BadRequestException({
          error: "POLICY_COMMIT_TOKEN_REQUIRED",
          message:
            "This policy change is high-impact or not fully reversible. Run POST /policy/simulations/preview first and supply the exact commitToken.",
          domain: preview.domain,
          status: preview.status,
          impactSeverity: preview.impactSeverity,
          reversibility: preview.reversibility,
          expectedCommitToken: preview.commitToken,
          affectedSummary: preview.affectedSummary,
          expectedSideEffects: preview.expectedSideEffects,
          rollbackConstraints: preview.rollbackConstraints,
          simulationId: preview.simulationId,
        });
      }
    }

    return preview;
  }

  /**
   * Commits a simulated policy change after verifying safety preconditions and
   * records a rollback snapshot in the commit audit history.
   */
  async commitPolicyChange<D extends PolicyDomain = PolicyDomain>(
    dto: CommitPolicyChangeDto & { domain: D },
    actorId = "anonymous",
  ): Promise<{
    commit: PolicyCommitRecord<D>;
    preview: PolicySimulationPreviewResult<D>;
  }> {
    if (!dto.reason || dto.reason.trim().length < 3) {
      throw new BadRequestException(
        "A valid audit reason (at least 3 characters) is required to commit a policy change.",
      );
    }

    const preview = await this.assertProceedable(dto, actorId);
    const committedAt = dto.asOf ?? new Date().toISOString();

    const commitHash = computeDigest("policy-commit-record:v1", {
      domain: preview.domain,
      simulationId: preview.simulationId,
      previewDigest: preview.digest,
      actorId,
      committedAt,
      seq: this.totalCommits + 1,
    });
    const commitId = `pcmt:${preview.domain}:${commitHash.slice(0, 16)}`;

    const commitRecord: PolicyCommitRecord<D> = {
      commitId,
      domain: preview.domain,
      actorId,
      reason: dto.reason.trim(),
      committedAt,
      simulationId: preview.simulationId,
      previewDigest: preview.digest,
      previousPolicy: structuredClone(preview.currentPolicy),
      appliedPolicy: structuredClone(preview.effectiveProposedPolicy),
      reversibility: preview.reversibility,
      impactSeverity: preview.impactSeverity,
      rollbackAvailable: true,
      rollbackConstraints: preview.rollbackConstraints,
    };

    this.activePolicies[preview.domain] = structuredClone(
      preview.effectiveProposedPolicy,
    );
    this.commitHistory.set(
      commitId,
      commitRecord as unknown as PolicyCommitRecord,
    );
    this.totalCommits++;

    this.eventEmitter?.emit(POLICY_SIMULATION_EVENTS.COMMITTED, {
      commitId,
      simulationId: preview.simulationId,
      domain: preview.domain,
      actorId,
      reversibility: preview.reversibility,
      impactSeverity: preview.impactSeverity,
    });

    this.logger.warn(
      `Policy committed ${commitId} domain=${preview.domain} by=${actorId} reversibility=${preview.reversibility}`,
    );

    return { commit: commitRecord, preview };
  }

  /**
   * Rolls back a previously committed policy configuration to its prior snapshot
   * and returns any partial/irreversible recovery steps required for side effects.
   */
  rollbackPolicyChange(
    commitId: string,
    reason: string,
    actorId = "anonymous",
  ): {
    commit: PolicyCommitRecord;
    restoredPolicy: DomainPolicyMap[PolicyDomain];
    manualRecoveryRequired: boolean;
    recoveryConstraints: RollbackConstraint[];
  } {
    const record = this.commitHistory.get(commitId);
    if (!record) {
      throw new NotFoundException(`Policy commit record '${commitId}' not found.`);
    }
    if (!record.rollbackAvailable || record.rolledBackAt) {
      throw new BadRequestException(
        `Policy commit '${commitId}' has already been rolled back at ${record.rolledBackAt}.`,
      );
    }
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException(
        "A valid rollback reason (at least 3 characters) is required.",
      );
    }

    const domain = record.domain;
    (this.activePolicies as Record<PolicyDomain, unknown>)[domain] =
      structuredClone(record.previousPolicy);

    record.rollbackAvailable = false;
    record.rolledBackAt = new Date().toISOString();
    record.rolledBackBy = actorId;
    record.rollbackReason = reason.trim();
    this.totalRollbacks++;

    const recoveryConstraints = record.rollbackConstraints.filter(
      (c) => c.reversibility !== "fully_reversible",
    );
    const manualRecoveryRequired =
      record.reversibility !== "fully_reversible" ||
      recoveryConstraints.length > 0;

    this.eventEmitter?.emit(POLICY_SIMULATION_EVENTS.ROLLED_BACK, {
      commitId,
      domain,
      actorId,
      reason: record.rollbackReason,
      manualRecoveryRequired,
    });

    this.logger.warn(
      `Policy rolled back ${commitId} domain=${domain} by=${actorId} manualRecoveryRequired=${manualRecoveryRequired}`,
    );

    return {
      commit: structuredClone(record),
      restoredPolicy: structuredClone(record.previousPolicy),
      manualRecoveryRequired,
      recoveryConstraints,
    };
  }

  getActivePolicy<D extends PolicyDomain>(domain: D): DomainPolicyMap[D] {
    if (domain === "trading" && this.policyService) {
      // If trading policy hasn't been overridden by an in-memory commit, sync with ConfigService
      const hasTradingCommit = Array.from(this.commitHistory.values()).some(
        (c) => c.domain === "trading",
      );
      if (!hasTradingCommit) {
        this.activePolicies.trading = this.policyService.getTradingPolicy();
      }
    }
    return structuredClone(this.activePolicies[domain]);
  }

  getActivePolicies(): DomainPolicyMap {
    return {
      trading: this.getActivePolicy("trading"),
      defi_adapters: this.getActivePolicy("defi_adapters"),
      portfolio_rebalancing: this.getActivePolicy("portfolio_rebalancing"),
      auth_access: this.getActivePolicy("auth_access"),
      notification_routing: this.getActivePolicy("notification_routing"),
    };
  }

  getCommitHistory(domain?: PolicyDomain): PolicyCommitRecord[] {
    const records = Array.from(this.commitHistory.values());
    const filtered = domain
      ? records.filter((r) => r.domain === domain)
      : records;
    return filtered.map((r) => structuredClone(r)).reverse();
  }

  getMetricsSnapshot(): PolicySimulationMetricsSnapshot {
    return {
      totalSimulations: this.totalSimulations,
      totalCommits: this.totalCommits,
      totalBlockedCommits: this.totalBlockedCommits,
      totalRollbacks: this.totalRollbacks,
      byDomain: { ...this.byDomain },
      byStatus: { ...this.byStatus },
      byImpactSeverity: { ...this.byImpactSeverity },
      byReversibility: { ...this.byReversibility },
    };
  }

  private async resolveSnapshot(
    domain: PolicyDomain,
    asOf: string,
    explicitSnapshot?: PolicySimulationSnapshot,
  ): Promise<PolicySimulationSnapshot> {
    if (explicitSnapshot) {
      return explicitSnapshot;
    }
    if (this.populationProvider) {
      try {
        return await this.populationProvider.loadSnapshot(domain, asOf);
      } catch (err) {
        this.logger.warn(
          `Population provider failed for domain=${domain}, falling back to default snapshot: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return defaultSimulationSnapshot(asOf);
  }

  private recordSimulationMetrics(
    result: PolicySimulationPreviewResult<PolicyDomain>,
  ): void {
    this.totalSimulations++;
    this.byDomain[result.domain] = (this.byDomain[result.domain] ?? 0) + 1;
    this.byStatus[result.status] = (this.byStatus[result.status] ?? 0) + 1;
    this.byImpactSeverity[result.impactSeverity] =
      (this.byImpactSeverity[result.impactSeverity] ?? 0) + 1;
    this.byReversibility[result.reversibility] =
      (this.byReversibility[result.reversibility] ?? 0) + 1;
  }

  private emitBlockedCommit(
    preview: PolicySimulationPreviewResult<PolicyDomain>,
    actorId: string,
    reasonCode: string,
  ): void {
    this.eventEmitter?.emit(POLICY_SIMULATION_EVENTS.COMMIT_BLOCKED, {
      simulationId: preview.simulationId,
      domain: preview.domain,
      actorId,
      reasonCode,
      status: preview.status,
      impactSeverity: preview.impactSeverity,
      reversibility: preview.reversibility,
    });
  }
}

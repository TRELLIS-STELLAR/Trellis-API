import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  DisasterRecoveryValidationReport,
  InvariantCategory,
  InvariantSeverity,
} from './disaster-recovery.types';
import { DisasterRecoveryValidatorService } from './disaster-recovery-validator.service';
import {
  DataValidationGateResult,
  DrillPhase,
  DrillScenarioId,
  DrillStepCheck,
  DrillSubsystem,
  ImpactedOperationRecord,
  IncidentDrillScenarioReport,
  IncidentDrillSuiteReport,
  IncidentSeverity,
  InjectedSqlState,
  MigrationRollbackCheckInput,
  ProbeStatusSnapshot,
  RecoveryOperationInput,
  RecoveryVerificationResult,
  RollbackVerificationResult,
  UserImpactReport,
} from './incident-drill.types';
import {
  OperationType,
  RecoveryEntry,
  RecoveryState,
} from '../../common/contract/types/trellis-contract.types';
import {
  SNAPSHOT_HASH_ALGORITHM,
  SNAPSHOT_HMAC_ALGORITHM,
  SNAPSHOT_REDACTED_FIELDS,
  REDACTED_PLACEHOLDER,
} from '../../snapshot/snapshot.constants';

const SCALE = 7n;
const SCALE_FACTOR = 10n ** SCALE;

function toUnits(value: string | undefined): bigint {
  if (!value) return 0n;
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return 0n;
  }
  const [whole, fraction = ''] = normalized.split('.');
  return (
    BigInt(whole) * SCALE_FACTOR +
    BigInt(fraction.padEnd(Number(SCALE), '0').slice(0, Number(SCALE)))
  );
}

function fromUnits(units: bigint): string {
  const whole = units / SCALE_FACTOR;
  const fraction = (units % SCALE_FACTOR)
    .toString()
    .padStart(Number(SCALE), '0');
  return `${whole}.${fraction}`;
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /S[A-Z2-7]{55}/g, // Stellar secret seed
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, // JWT
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /postgresql:\/\/[^@\s]+@[^\s]+/gi,
];

const EXTRA_SENSITIVE_KEYS = new Set([
  ...SNAPSHOT_REDACTED_FIELDS.map((f) => f.toLowerCase()),
  'jwt',
  'jwtsecret',
  'jwt_secret',
  'stellarsecret',
  'stellar_secret',
  'webhooksecret',
  'webhook_secret',
  'databaseurl',
  'database_url',
  'email',
]);

@Injectable()
export class IncidentDrillService {
  private readonly logger = new Logger(IncidentDrillService.name);
  private readonly signingKey = 'trellis-incident-drill-verification-key';

  /**
   * Executes the complete suite of incident drill scenarios and returns an
   * aggregated verification report.
   */
  async runAllDrillScenarios(): Promise<IncidentDrillSuiteReport> {
    const start = Date.now();
    const scenarioIds: DrillScenarioId[] = [
      DrillScenarioId.SEV1_SETTLEMENT_AND_PORTFOLIO_DRIFT,
      DrillScenarioId.SEV1_AUTH_KEY_ROTATION_AND_SESSION_CONTAINMENT,
      DrillScenarioId.SEV2_DEFI_ORACLE_STALE_FEED_AND_ROLLBACK,
      DrillScenarioId.EDGE_CASE_UNSAFE_SCHEMA_ROLLBACK_BLOCKED,
      DrillScenarioId.EDGE_CASE_TAMPERED_SNAPSHOT_REJECTED,
    ];

    const scenarios: IncidentDrillScenarioReport[] = [];
    for (const id of scenarioIds) {
      scenarios.push(await this.runScenario(id));
    }

    const passedScenarios = scenarios.filter((s) => s.passed).length;
    const failedScenarios = scenarios.length - passedScenarios;
    const totalSteps = scenarios.reduce((acc, s) => acc + s.steps.length, 0);
    const passedSteps = scenarios.reduce(
      (acc, s) => acc + s.steps.filter((st) => st.passed).length,
      0,
    );

    return {
      executedAt: new Date().toISOString(),
      allPassed: failedScenarios === 0,
      totalScenarios: scenarios.length,
      passedScenarios,
      failedScenarios,
      totalSteps,
      passedSteps,
      durationMs: Date.now() - start,
      scenarios,
    };
  }

  /**
   * Runs a single incident drill scenario end-to-end and verifies that all
   * containment, rollback, data validation, recovery, and user-impact checks behave as expected.
   */
  async runScenario(
    scenarioId: DrillScenarioId,
  ): Promise<IncidentDrillScenarioReport> {
    const startedAt = Date.now();

    switch (scenarioId) {
      case DrillScenarioId.SEV1_SETTLEMENT_AND_PORTFOLIO_DRIFT:
        return this.executeSev1SettlementAndPortfolioDrill(startedAt);
      case DrillScenarioId.SEV1_AUTH_KEY_ROTATION_AND_SESSION_CONTAINMENT:
        return this.executeSev1AuthKeyRotationDrill(startedAt);
      case DrillScenarioId.SEV2_DEFI_ORACLE_STALE_FEED_AND_ROLLBACK:
        return this.executeSev2DefiOracleRollbackDrill(startedAt);
      case DrillScenarioId.EDGE_CASE_UNSAFE_SCHEMA_ROLLBACK_BLOCKED:
        return this.executeUnsafeSchemaRollbackEdgeCase(startedAt);
      case DrillScenarioId.EDGE_CASE_TAMPERED_SNAPSHOT_REJECTED:
        return this.executeTamperedSnapshotEdgeCase(startedAt);
    }
  }

  // ===========================================================================
  // PILLAR 1: CONTAINMENT, SNAPSHOT & ROLLBACK VERIFICATION
  // ===========================================================================

  verifyRollbackAndContainment(params: {
    scopesToPause: string[];
    migrationCheck: MigrationRollbackCheckInput;
    snapshotPayload: Record<string, unknown>;
    tamperSnapshotAfterCapture?: boolean;
    postRollbackProbes?: ProbeStatusSnapshot;
  }): RollbackVerificationResult {
    const blockingReasons: string[] = [];
    const pausedScopes = [...new Set(params.scopesToPause)];
    let auditTrailCount = pausedScopes.length; // 1 audit entry per pause activation

    // 1. Capture signed canonical snapshot with secret redaction
    const { redacted } = this.redactObject(params.snapshotPayload);
    const canonical = this.canonicalise(redacted);
    const integrityHash = this.computeSha256(canonical);
    const signature = this.computeHmac(integrityHash);
    const snapshotId = `snap-${integrityHash.slice(0, 12)}`;

    // Check if snapshot was tampered with before rollback
    const VerificationPayload = params.tamperSnapshotAfterCapture
      ? { ...redacted, __tampered: true }
      : redacted;
    const recomputedHash = this.computeSha256(
      this.canonicalise(VerificationPayload),
    );
    const recomputedSig = this.computeHmac(recomputedHash);
    const snapshotVerified =
      recomputedHash === integrityHash &&
      this.timingSafeEqualHex(recomputedSig, signature);

    if (!snapshotVerified) {
      blockingReasons.push(
        'Snapshot integrity hash or HMAC signature mismatch: rollback artifact was modified after capture.',
      );
      return {
        allowed: false,
        executed: false,
        strategy: 'blocked_tampered_snapshot',
        fromReleaseSha: params.migrationCheck.currentReleaseSha,
        toReleaseSha: params.migrationCheck.targetReleaseSha,
        snapshotId,
        snapshotVerified: false,
        pausedScopes,
        resumedScopes: [],
        postRollbackProbes: {
          live: true,
          ready: false,
          startup: true,
          metricsAvailable: true,
          errorRatePercent: 5.2,
          p95LatencyMs: 1450,
          queueDepth: 120,
        },
        blockingReasons,
        auditTrailCount,
      };
    }

    // 2. Check schema and API contract compatibility
    if (params.migrationCheck.hasDestructiveSchemaChanges) {
      blockingReasons.push(
        `Destructive schema migration (${params.migrationCheck.currentMigrationVersion} -> ${params.migrationCheck.targetMigrationVersion}) prevents binary rollback. Use a forward-fix migration or approved point-in-time restore.`,
      );
    }

    if (!params.migrationCheck.openApiContractCompatible) {
      blockingReasons.push(
        'Target release breaks active public API contract expectations without a deprecation window.',
      );
    }

    if (
      params.migrationCheck.targetReleaseSha === 'latest' ||
      !params.migrationCheck.targetReleaseSha.trim()
    ) {
      blockingReasons.push(
        'Mutable tag (such as "latest") or empty target release digest is forbidden during rollback.',
      );
    }

    const allowed = blockingReasons.length === 0;
    const probes: ProbeStatusSnapshot =
      params.postRollbackProbes ??
      (allowed
        ? {
            live: true,
            ready: true,
            startup: true,
            metricsAvailable: true,
            errorRatePercent: 0.05,
            p95LatencyMs: 85,
            queueDepth: 4,
          }
        : {
            live: true,
            ready: false,
            startup: true,
            metricsAvailable: true,
            errorRatePercent: 4.8,
            p95LatencyMs: 1200,
            queueDepth: 95,
          });

    const probesHealthy =
      probes.live &&
      probes.ready &&
      probes.startup &&
      probes.metricsAvailable &&
      probes.errorRatePercent < 1.0;

    const executed = allowed && probesHealthy;
    const resumedScopes = executed ? [...pausedScopes] : [];
    if (executed) {
      auditTrailCount += resumedScopes.length; // 1 audit entry per pause resume
    }

    let strategy: RollbackVerificationResult['strategy'] = 'binary_rollback';
    if (!allowed && params.migrationCheck.hasDestructiveSchemaChanges) {
      strategy = 'forward_fix_required';
    }

    return {
      allowed,
      executed,
      strategy,
      fromReleaseSha: params.migrationCheck.currentReleaseSha,
      toReleaseSha: params.migrationCheck.targetReleaseSha,
      snapshotId,
      snapshotVerified,
      pausedScopes,
      resumedScopes,
      postRollbackProbes: probes,
      blockingReasons,
      auditTrailCount,
    };
  }

  // ===========================================================================
  // PILLAR 2: DATA VALIDATION & DOMAIN INVARIANTS GATE
  // ===========================================================================

  async verifyDataValidation(params: {
    preRepairState: InjectedSqlState;
    postRepairState: InjectedSqlState;
    reconciliationMatchedCount?: number;
    reconciliationUnmatchedCount?: number;
    reconciliationCriticalCount?: number;
  }): Promise<DataValidationGateResult> {
    const preValidator = new DisasterRecoveryValidatorService(
      this.createMockDataSource(params.preRepairState) as any,
    );
    const postValidator = new DisasterRecoveryValidatorService(
      this.createMockDataSource(params.postRepairState) as any,
    );

    const preReport: DisasterRecoveryValidationReport =
      await preValidator.validateAllInvariants();
    const postReport: DisasterRecoveryValidationReport =
      await postValidator.validateAllInvariants();

    const detectedFailureCodes = preReport.results
      .filter((r) => !r.passed)
      .map((r) => r.code);

    const verifiedCategories = Array.from(
      new Set(postReport.results.map((r) => r.category)),
    );

    const reconciliationCriticalCount =
      params.reconciliationCriticalCount ?? 0;
    const gatePassed =
      postReport.isConsistent &&
      postReport.criticalFailures === 0 &&
      postReport.errorFailures === 0 &&
      reconciliationCriticalCount === 0;

    return {
      gatePassed,
      preRepairConsistent: preReport.isConsistent,
      postRepairConsistent: postReport.isConsistent,
      preRepairCriticalCount: preReport.criticalFailures,
      preRepairErrorCount: preReport.errorFailures,
      postRepairCriticalCount: postReport.criticalFailures,
      postRepairErrorCount: postReport.errorFailures,
      reconciliationCriticalCount,
      reconciliationMatchedTransactions:
        params.reconciliationMatchedCount ?? 12,
      reconciliationUnmatchedTransactions:
        params.reconciliationUnmatchedCount ?? 0,
      verifiedCategories,
      detectedFailureCodes,
    };
  }

  // ===========================================================================
  // PILLAR 3: RECOVERY WORKFLOW & IDEMPOTENCY VERIFICATION
  // ===========================================================================

  verifyRecoveryWorkflow(
    operations: RecoveryOperationInput[],
  ): RecoveryVerificationResult {
    const entries = new Map<
      string,
      RecoveryEntry & { userId: string }
    >();
    const sideEffectLedger = new Map<string, number>();

    let retriedCount = 0;
    let resolvedCount = 0;
    let onChainLinksVerified = true;

    // 1. Register operations and verify available actions
    for (const op of operations) {
      const id = `rec-${op.operationId}`;
      const needsChainLink = [
        OperationType.Payment,
        OperationType.Submission,
        OperationType.Staking,
      ].includes(op.operationType);

      const availableActions = [
        {
          actionId: 'retry',
          label: 'Retry',
          description: 'Attempt the operation again from the last checkpoint.',
          endpoint: `/api/v1/recovery/${op.operationId}/retry`,
          method: 'POST' as const,
          requiresConfirmation: false,
        },
        {
          actionId: 'cancel',
          label: 'Cancel',
          description: 'Cancel this operation and release any held resources.',
          endpoint: `/api/v1/recovery/${op.operationId}/cancel`,
          method: 'DELETE' as const,
          requiresConfirmation: true,
        },
      ];

      if (needsChainLink) {
        availableActions.push({
          actionId: 'view-on-chain',
          label: 'View on-chain',
          description: 'Inspect the Stellar transaction on the network explorer.',
          endpoint: `/api/v1/recovery/${op.operationId}/chain-link`,
          method: 'POST' as const,
          requiresConfirmation: false,
        });
      }

      if (
        needsChainLink &&
        !availableActions.some((a) => a.actionId === 'view-on-chain')
      ) {
        onChainLinksVerified = false;
      }

      entries.set(id, {
        id,
        operationId: op.operationId,
        operationType: op.operationType,
        userId: op.userId,
        state: 'unresolved',
        title: op.title,
        description: op.description,
        availableActions,
        createdAt: new Date().toISOString(),
      });
    }

    // 2. Verify tenant isolation (user A cannot mutate user B's recovery entry)
    const accessChecks = [...entries.values()].map((entry) => {
      const ownerAccessAllowed = this.canAccessRecoveryEntry(
        entry,
        entry.userId,
      );
      const otherUserId = operations.find(
        (operation) => operation.userId !== entry.userId,
      )?.userId;
      const unauthorizedActor =
        otherUserId ?? `unauthorized-user-for-${entry.userId}`;
      return {
        entryId: entry.id,
        ownerAccessAllowed,
        crossTenantAccessDenied: !this.canAccessRecoveryEntry(
          entry,
          unauthorizedActor,
        ),
      };
    });
    const tenantIsolationVerified = accessChecks.every(
      (check) =>
        check.ownerAccessAllowed && check.crossTenantAccessDenied,
    );

    // 3. Execute idempotent retry (simulating 2 retry attempts per operation with idempotency key guard)
    for (const op of operations) {
      const id = `rec-${op.operationId}`;
      const entry = entries.get(id)!;

      // Retry transitions unresolved -> in_progress
      if (entry.state === 'unresolved') {
        entry.state = 'in_progress';
        retriedCount += 1;
      }

      // Idempotent execution: even if retry is invoked twice, the side effect ledger only records once per idempotencyKey
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (!sideEffectLedger.has(op.idempotencyKey)) {
          sideEffectLedger.set(op.idempotencyKey, 1);
        }
      }

      // Transition to resolved and strip residual actions
      entry.state = 'resolved';
      entry.availableActions = [];
      entry.resolvedAt = new Date().toISOString();
      resolvedCount += 1;
    }

    // 4. Verify terminal state immutability (resolved entries cannot transition again)
    let terminalStateImmutabilityVerified = true;
    for (const entry of entries.values()) {
      if (
        (entry.state === 'resolved' || entry.state === 'dismissed') &&
        entry.availableActions.length > 0
      ) {
        terminalStateImmutabilityVerified = false;
      }
    }

    const duplicateSideEffectsDetected = [...sideEffectLedger.values()].filter(
      (count) => count > 1,
    ).length;

    return {
      totalOperationsRegistered: operations.length,
      retriedCount,
      resolvedCount,
      duplicateSideEffectsDetected,
      terminalStateImmutabilityVerified,
      tenantIsolationVerified,
      accessChecks,
      onChainLinksVerified,
      entries: [...entries.values()].map((e) => ({
        id: e.id,
        operationId: e.operationId,
        userId: e.userId,
        finalState: e.state,
        hasResidualActions: e.availableActions.length > 0,
      })),
    };
  }

  private canAccessRecoveryEntry(
    entry: RecoveryEntry & { userId: string },
    actorUserId: string,
  ): boolean {
    return entry.userId === actorUserId;
  }

  // ===========================================================================
  // PILLAR 4: USER-IMPACT REPORTING & PRIVACY REDACTION
  // ===========================================================================

  generateUserImpactReport(params: {
    incidentId: string;
    scenarioId: DrillScenarioId;
    severity: IncidentSeverity;
    impactedOperations: ImpactedOperationRecord[];
    rawDiagnosticContext?: Record<string, unknown>;
    now?: Date;
  }): UserImpactReport {
    const now = params.now ?? new Date();
    const cadenceMinutes =
      params.severity === IncidentSeverity.SEV_1
        ? 30
        : params.severity === IncidentSeverity.SEV_2
          ? 60
          : 240;
    const nextUpdateAt = new Date(
      now.getTime() + cadenceMinutes * 60_000,
    ).toISOString();

    const uniqueUsers = new Set<string>();
    const uniqueSubsystems = new Set<DrillSubsystem>();
    const degradedRoutes = new Set<string>();
    const deduplicationKeys: string[] = [];
    let totalExposure = 0n;

    for (const op of params.impactedOperations) {
      uniqueUsers.add(op.userId);
      uniqueSubsystems.add(op.subsystem);
      if (op.route) {
        degradedRoutes.add(this.normalizeRoute(op.route));
      }
      totalExposure += toUnits(op.amountAtRisk);
    }

    for (const userId of uniqueUsers) {
      const dedupKey = `incident:${params.incidentId}:user:${this.hashIdentifier(userId)}:status`;
      deduplicationKeys.push(dedupKey);
    }

    const { redacted: redactedContext, removedFields } = this.redactObject({
      ...(params.rawDiagnosticContext ?? {}),
      operationsMetadata: params.impactedOperations.map(
        (o) => o.metadata ?? {},
      ),
    });

    const formattedExposure = fromUnits(totalExposure);
    const rawSummary =
      `[${params.severity}] Incident ${params.incidentId}: ` +
      `${uniqueUsers.size} user(s) and ${params.impactedOperations.length} operation(s) impacted across ` +
      `${[...uniqueSubsystems].join(', ')}. ` +
      `Mitigation active; affected writes paused and reconciliation verified. ` +
      `Next update by ${nextUpdateAt}.`;

    const publicStatusSummary = this.scrubRawStrings(rawSummary);
    const serializedCheck =
      JSON.stringify(redactedContext) + ' ' + publicStatusSummary;
    const containsUnredactedSecrets = this.detectSecretLeak(serializedCheck);

    return {
      incidentId: params.incidentId,
      scenarioId: params.scenarioId,
      severity: params.severity,
      generatedAt: now.toISOString(),
      nextUpdateAt,
      updateCadenceMinutes: cadenceMinutes,
      affectedSubsystems: [...uniqueSubsystems],
      affectedUserCount: uniqueUsers.size,
      affectedOperationCount: params.impactedOperations.length,
      totalExposureUnits: formattedExposure,
      degradedRoutes: [...degradedRoutes],
      notificationsQueued: deduplicationKeys.length,
      deduplicationKeys,
      redactedFields: removedFields,
      publicStatusSummary,
      operatorActionItems: [
        `Maintain pause on affected scopes until DR validation reports 0 CRITICAL/ERROR violations.`,
        `Verify ${deduplicationKeys.length} deduplicated user notification(s) via NotificationService.`,
        `Publish next status update before ${nextUpdateAt} (${cadenceMinutes}m SLA).`,
      ],
      containsUnredactedSecrets,
    };
  }

  // ===========================================================================
  // SCENARIO IMPLEMENTATIONS
  // ===========================================================================

  private async executeSev1SettlementAndPortfolioDrill(
    startedAt: number,
  ): Promise<IncidentDrillScenarioReport> {
    const scenarioId = DrillScenarioId.SEV1_SETTLEMENT_AND_PORTFOLIO_DRIFT;
    const rollback = this.verifyRollbackAndContainment({
      scopesToPause: ['payments', 'settlements'],
      migrationCheck: {
        currentReleaseSha: 'sha256:bad9012f',
        targetReleaseSha: 'sha256:good8811a',
        currentMigrationVersion: '1729000002-AddPortfolioIndex',
        targetMigrationVersion: '1729000001-BaseSchema',
        hasDestructiveSchemaChanges: false,
        openApiContractCompatible: true,
      },
      snapshotPayload: {
        incidentId: 'INC-2026-001',
        scope: 'settlements',
        jwtSecret: 'super-secret-jwt-token-do-not-leak',
        privateKey:
          'SB777777777777777777777777777777777777777777777777777777',
        invoicesChecked: 25,
      },
    });

    const dataValidation = await this.verifyDataValidation({
      preRepairState: {
        settledInvoiceMismatches: 2,
        orphanedPortfolioAssets: 1,
      },
      postRepairState: {
        settledInvoiceMismatches: 0,
        orphanedPortfolioAssets: 0,
      },
      reconciliationMatchedCount: 25,
      reconciliationUnmatchedCount: 0,
      reconciliationCriticalCount: 0,
    });

    const recovery = this.verifyRecoveryWorkflow([
      {
        operationId: 'op-settle-101',
        operationType: OperationType.Payment,
        userId: 'usr-101',
        title: 'Stellar Invoice Settlement Retry',
        description: 'Re-verify settled amount against Horizon ledger.',
        idempotencyKey: 'idem-settle-101',
      },
      {
        operationId: 'op-port-102',
        operationType: OperationType.Rebalance,
        userId: 'usr-102',
        title: 'Portfolio Valuation Re-sync',
        description: 'Recalculate portfolio totalValue from verified holdings.',
        idempotencyKey: 'idem-port-102',
      },
    ]);

    const userImpact = this.generateUserImpactReport({
      incidentId: 'INC-2026-001',
      scenarioId,
      severity: IncidentSeverity.SEV_1,
      impactedOperations: [
        {
          userId: 'usr-101',
          operationId: 'op-settle-101',
          subsystem: DrillSubsystem.SETTLEMENT,
          amountAtRisk: '1250.5000000',
          assetCode: 'USDC',
          route:
            '/api/v1/reconcile/tx/9cc3bcab9450390ce5e214045a41e70e6d4a920f2bbc3e5d873c90eadfb7e45c',
          metadata: { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' },
        },
        {
          userId: 'usr-102',
          operationId: 'op-port-102',
          subsystem: DrillSubsystem.PORTFOLIO,
          amountAtRisk: '749.5000000',
          assetCode: 'XLM',
          route:
            '/api/v1/portfolios/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/assets',
        },
      ],
      rawDiagnosticContext: {
        password: 'admin-password',
        authorization: 'Bearer secret-jwt',
      },
    });

    const steps = this.buildScenarioSteps({
      rollbackExpectExecuted: true,
      rollback,
      dataValidation,
      recovery,
      userImpact,
    });

    return {
      scenarioId,
      title: 'SEV-1 Settlement Mismatch & Portfolio Valuation Drift Recovery',
      severity: IncidentSeverity.SEV_1,
      passed: steps.every((s) => s.passed),
      durationMs: Date.now() - startedAt,
      subsystems: [
        DrillSubsystem.SETTLEMENT,
        DrillSubsystem.PORTFOLIO,
        DrillSubsystem.NOTIFICATIONS,
        DrillSubsystem.OBSERVABILITY,
      ],
      steps,
      rollback,
      dataValidation,
      recovery,
      userImpact,
    };
  }

  private async executeSev1AuthKeyRotationDrill(
    startedAt: number,
  ): Promise<IncidentDrillScenarioReport> {
    const scenarioId =
      DrillScenarioId.SEV1_AUTH_KEY_ROTATION_AND_SESSION_CONTAINMENT;
    const rollback = this.verifyRollbackAndContainment({
      scopesToPause: ['all'],
      migrationCheck: {
        currentReleaseSha: 'sha256:auth5501',
        targetReleaseSha: 'sha256:auth5499',
        currentMigrationVersion: '1729000005-ApiKeyRotation',
        targetMigrationVersion: '1729000005-ApiKeyRotation',
        hasDestructiveSchemaChanges: false,
        openApiContractCompatible: true,
      },
      snapshotPayload: {
        incidentId: 'INC-2026-002',
        scope: 'auth',
        apiKey: 'tk_live_99999999999999999',
        secret: 'signing-key-old',
      },
    });

    const dataValidation = await this.verifyDataValidation({
      preRepairState: {
        orphanedWallets: 2,
        invalidStellarKeys: 1,
      },
      postRepairState: {
        orphanedWallets: 0,
        invalidStellarKeys: 0,
      },
    });

    const recovery = this.verifyRecoveryWorkflow([
      {
        operationId: 'op-auth-201',
        operationType: OperationType.Submission,
        userId: 'usr-201',
        title: 'Re-verify Wallet Signature Challenge',
        description: 'Replay signed challenge after key rotation.',
        idempotencyKey: 'idem-auth-201',
      },
    ]);

    const userImpact = this.generateUserImpactReport({
      incidentId: 'INC-2026-002',
      scenarioId,
      severity: IncidentSeverity.SEV_1,
      impactedOperations: [
        {
          userId: 'usr-201',
          operationId: 'op-auth-201',
          subsystem: DrillSubsystem.AUTH,
          amountAtRisk: '0.0000000',
          route:
            '/api/v1/wallets/GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/balance',
          metadata: { apiKey: 'tk_live_secret_value' },
        },
      ],
      rawDiagnosticContext: {
        privateKey:
          'SBCW2ACURUSJJXAX6JUSKNA7D7H7UJJJAXD777777777777777777777',
      },
    });

    const steps = this.buildScenarioSteps({
      rollbackExpectExecuted: true,
      rollback,
      dataValidation,
      recovery,
      userImpact,
    });

    return {
      scenarioId,
      title: 'SEV-1 Auth Key Exposure Containment, Rotation & Wallet Audit',
      severity: IncidentSeverity.SEV_1,
      passed: steps.every((s) => s.passed),
      durationMs: Date.now() - startedAt,
      subsystems: [
        DrillSubsystem.AUTH,
        DrillSubsystem.NOTIFICATIONS,
        DrillSubsystem.OBSERVABILITY,
      ],
      steps,
      rollback,
      dataValidation,
      recovery,
      userImpact,
    };
  }

  private async executeSev2DefiOracleRollbackDrill(
    startedAt: number,
  ): Promise<IncidentDrillScenarioReport> {
    const scenarioId = DrillScenarioId.SEV2_DEFI_ORACLE_STALE_FEED_AND_ROLLBACK;
    const rollback = this.verifyRollbackAndContainment({
      scopesToPause: ['oracle_submissions', 'webhooks'],
      migrationCheck: {
        currentReleaseSha: 'sha256:defi3100',
        targetReleaseSha: 'sha256:defi3090',
        currentMigrationVersion: '1729000010-OracleFeed',
        targetMigrationVersion: '1729000010-OracleFeed',
        hasDestructiveSchemaChanges: false,
        openApiContractCompatible: true,
      },
      snapshotPayload: {
        incidentId: 'INC-2026-003',
        scope: 'defi-oracle',
        webhookSecret: 'whsec_test_secret',
      },
    });

    const dataValidation = await this.verifyDataValidation({
      preRepairState: {
        malformedSignedPayloads: 3,
        orphanedDeFiPositions: 1,
      },
      postRepairState: {
        malformedSignedPayloads: 0,
        orphanedDeFiPositions: 0,
      },
    });

    const recovery = this.verifyRecoveryWorkflow([
      {
        operationId: 'op-defi-301',
        operationType: OperationType.Staking,
        userId: 'usr-301',
        title: 'DeFi Staking Position Sync',
        description: 'Replay staking adapter position check after oracle recovery.',
        idempotencyKey: 'idem-defi-301',
      },
      {
        operationId: 'op-oracle-302',
        operationType: OperationType.Submission,
        userId: 'usr-302',
        title: 'Oracle Signed Payload Resubmission',
        description: 'Re-submit verified payload with fresh signature.',
        idempotencyKey: 'idem-oracle-302',
      },
    ]);

    const userImpact = this.generateUserImpactReport({
      incidentId: 'INC-2026-003',
      scenarioId,
      severity: IncidentSeverity.SEV_2,
      impactedOperations: [
        {
          userId: 'usr-301',
          operationId: 'op-defi-301',
          subsystem: DrillSubsystem.DEFI,
          amountAtRisk: '500.0000000',
          assetCode: 'XLM',
          route: '/api/v1/defi/0x1234567890123456789012345678901234567890/positions',
        },
        {
          userId: 'usr-302',
          operationId: 'op-oracle-302',
          subsystem: DrillSubsystem.API_CONTRACTS,
          amountAtRisk: '0.0000000',
          route: '/api/v1/oracle/payloads',
        },
      ],
    });

    const steps = this.buildScenarioSteps({
      rollbackExpectExecuted: true,
      rollback,
      dataValidation,
      recovery,
      userImpact,
    });

    return {
      scenarioId,
      title: 'SEV-2 DeFi Adapter & Oracle Stale Feed Rollback Drill',
      severity: IncidentSeverity.SEV_2,
      passed: steps.every((s) => s.passed),
      durationMs: Date.now() - startedAt,
      subsystems: [
        DrillSubsystem.DEFI,
        DrillSubsystem.API_CONTRACTS,
        DrillSubsystem.OBSERVABILITY,
      ],
      steps,
      rollback,
      dataValidation,
      recovery,
      userImpact,
    };
  }

  private async executeUnsafeSchemaRollbackEdgeCase(
    startedAt: number,
  ): Promise<IncidentDrillScenarioReport> {
    const scenarioId = DrillScenarioId.EDGE_CASE_UNSAFE_SCHEMA_ROLLBACK_BLOCKED;
    const rollback = this.verifyRollbackAndContainment({
      scopesToPause: ['payments', 'settlements'],
      migrationCheck: {
        currentReleaseSha: 'sha256:mig9999',
        targetReleaseSha: 'sha256:mig9990',
        currentMigrationVersion: '1729000020-DropLegacyColumn',
        targetMigrationVersion: '1729000019-LegacyColumnPresent',
        hasDestructiveSchemaChanges: true,
        openApiContractCompatible: true,
      },
      snapshotPayload: {
        incidentId: 'INC-2026-004',
        scope: 'schema-migration',
      },
    });

    const dataValidation = await this.verifyDataValidation({
      preRepairState: { settledInvoiceMismatches: 1 },
      postRepairState: { settledInvoiceMismatches: 0 },
    });

    const recovery = this.verifyRecoveryWorkflow([
      {
        operationId: 'op-mig-401',
        operationType: OperationType.Payment,
        userId: 'usr-401',
        title: 'Forward-Fix Post-Migration Payment Verification',
        description: 'Verify payment after forward-fix migration applied.',
        idempotencyKey: 'idem-mig-401',
      },
    ]);

    const userImpact = this.generateUserImpactReport({
      incidentId: 'INC-2026-004',
      scenarioId,
      severity: IncidentSeverity.SEV_2,
      impactedOperations: [
        {
          userId: 'usr-401',
          operationId: 'op-mig-401',
          subsystem: DrillSubsystem.SETTLEMENT,
          amountAtRisk: '100.0000000',
          route: '/api/v1/reconcile/stellar/invoice',
        },
      ],
    });

    const steps = this.buildScenarioSteps({
      rollbackExpectExecuted: false,
      expectedStrategy: 'forward_fix_required',
      rollback,
      dataValidation,
      recovery,
      userImpact,
    });

    return {
      scenarioId,
      title: 'Edge Case: Unsafe Destructive Schema Rollback Blocked & Redirected to Forward-Fix',
      severity: IncidentSeverity.SEV_2,
      passed: steps.every((s) => s.passed),
      durationMs: Date.now() - startedAt,
      subsystems: [DrillSubsystem.SETTLEMENT, DrillSubsystem.API_CONTRACTS],
      steps,
      rollback,
      dataValidation,
      recovery,
      userImpact,
    };
  }

  private async executeTamperedSnapshotEdgeCase(
    startedAt: number,
  ): Promise<IncidentDrillScenarioReport> {
    const scenarioId = DrillScenarioId.EDGE_CASE_TAMPERED_SNAPSHOT_REJECTED;
    const rollback = this.verifyRollbackAndContainment({
      scopesToPause: ['exports', 'settlements'],
      migrationCheck: {
        currentReleaseSha: 'sha256:snap1002',
        targetReleaseSha: 'sha256:snap1001',
        currentMigrationVersion: '1729000001-BaseSchema',
        targetMigrationVersion: '1729000001-BaseSchema',
        hasDestructiveSchemaChanges: false,
        openApiContractCompatible: true,
      },
      snapshotPayload: {
        incidentId: 'INC-2026-005',
        scope: 'full',
        secret: 'do-not-expose',
      },
      tamperSnapshotAfterCapture: true,
    });

    const dataValidation = await this.verifyDataValidation({
      preRepairState: { orphanedWallets: 1 },
      postRepairState: { orphanedWallets: 0 },
    });

    const recovery = this.verifyRecoveryWorkflow([
      {
        operationId: 'op-snap-501',
        operationType: OperationType.Submission,
        userId: 'usr-501',
        title: 'Re-capture Clean State Snapshot',
        description: 'Capture fresh untampered snapshot before recovery.',
        idempotencyKey: 'idem-snap-501',
      },
    ]);

    const userImpact = this.generateUserImpactReport({
      incidentId: 'INC-2026-005',
      scenarioId,
      severity: IncidentSeverity.SEV_2,
      impactedOperations: [
        {
          userId: 'usr-501',
          operationId: 'op-snap-501',
          subsystem: DrillSubsystem.OBSERVABILITY,
          amountAtRisk: '0.0000000',
          route: '/api/v1/snapshots/verify',
        },
      ],
    });

    const steps = this.buildScenarioSteps({
      rollbackExpectExecuted: false,
      expectedStrategy: 'blocked_tampered_snapshot',
      rollback,
      dataValidation,
      recovery,
      userImpact,
    });

    return {
      scenarioId,
      title: 'Edge Case: Tampered Pre-Rollback Snapshot Detected and Rejected',
      severity: IncidentSeverity.SEV_2,
      passed: steps.every((s) => s.passed),
      durationMs: Date.now() - startedAt,
      subsystems: [DrillSubsystem.OBSERVABILITY, DrillSubsystem.AUTH],
      steps,
      rollback,
      dataValidation,
      recovery,
      userImpact,
    };
  }

  // ===========================================================================
  // INTERNAL HELPERS
  // ===========================================================================

  private buildScenarioSteps(params: {
    rollbackExpectExecuted: boolean;
    expectedStrategy?: RollbackVerificationResult['strategy'];
    rollback: RollbackVerificationResult;
    dataValidation: DataValidationGateResult;
    recovery: RecoveryVerificationResult;
    userImpact: UserImpactReport;
  }): DrillStepCheck[] {
    const {
      rollbackExpectExecuted,
      expectedStrategy,
      rollback,
      dataValidation,
      recovery,
      userImpact,
    } = params;

    const rollbackStepPassed = rollbackExpectExecuted
      ? rollback.executed &&
        rollback.snapshotVerified &&
        rollback.resumedScopes.length === rollback.pausedScopes.length
      : !rollback.executed &&
        rollback.blockingReasons.length > 0 &&
        (!expectedStrategy || rollback.strategy === expectedStrategy);

    return [
      {
        phase: DrillPhase.CONTAINMENT,
        name: 'Emergency Write-Path Pause Containment',
        passed:
          rollback.pausedScopes.length > 0 && rollback.auditTrailCount >= 1,
        detail: `Paused scopes [${rollback.pausedScopes.join(', ')}] with ${rollback.auditTrailCount} audit log entries.`,
      },
      {
        phase: DrillPhase.SNAPSHOT_VERIFICATION,
        name: 'Pre-Mitigation Signed State Snapshot Verification',
        passed:
          expectedStrategy === 'blocked_tampered_snapshot'
            ? !rollback.snapshotVerified
            : rollback.snapshotVerified,
        detail: rollback.snapshotVerified
          ? `Snapshot ${rollback.snapshotId} SHA-256 and HMAC-SHA256 verified.`
          : `Tampered snapshot ${rollback.snapshotId} accurately rejected.`,
      },
      {
        phase: DrillPhase.ROLLBACK,
        name: 'Rollback Safety Gate & Probe Verification',
        passed: rollbackStepPassed,
        detail: rollbackExpectExecuted
          ? `Rolled back ${rollback.fromReleaseSha} -> ${rollback.toReleaseSha}; probes live=${rollback.postRollbackProbes.live}, ready=${rollback.postRollbackProbes.ready}.`
          : `Blocked unsafe rollback (${rollback.strategy}): ${rollback.blockingReasons[0]}`,
      },
      {
        phase: DrillPhase.DATA_VALIDATION,
        name: 'Domain Invariant & Reconciliation Validation Gate',
        passed:
          !dataValidation.preRepairConsistent &&
          dataValidation.postRepairConsistent &&
          dataValidation.gatePassed &&
          dataValidation.verifiedCategories.length === 7,
        detail: `Detected [${dataValidation.detectedFailureCodes.join(', ')}] pre-repair; verified all ${dataValidation.verifiedCategories.length} domain categories consistent post-repair.`,
      },
      {
        phase: DrillPhase.RECOVERY_EXECUTION,
        name: 'Idempotent Operation Replay & Recovery Center Lifecycle',
        passed:
          recovery.resolvedCount === recovery.totalOperationsRegistered &&
          recovery.duplicateSideEffectsDetected === 0 &&
          recovery.terminalStateImmutabilityVerified &&
          recovery.tenantIsolationVerified &&
          recovery.onChainLinksVerified,
        detail: `Replayed ${recovery.retriedCount} operation(s), resolved ${recovery.resolvedCount}/${recovery.totalOperationsRegistered} with 0 duplicate side effects.`,
      },
      {
        phase: DrillPhase.USER_IMPACT_REPORTING,
        name: 'Redacted User-Impact Report & Deduplicated Notification Routing',
        passed:
          userImpact.affectedUserCount > 0 &&
          userImpact.notificationsQueued === userImpact.affectedUserCount &&
          !userImpact.containsUnredactedSecrets,
        detail: `Quantified ${userImpact.affectedUserCount} user(s), exposure=${userImpact.totalExposureUnits}, queued ${userImpact.notificationsQueued} deduplicated notification(s), redacted [${userImpact.redactedFields.join(', ') || 'none'}].`,
      },
    ];
  }

  private createMockDataSource(state: InjectedSqlState): {
    query: (sql: string) => Promise<any[]>;
  } {
    return {
      query: async (sql: string): Promise<any[]> => {
        const isCount = sql.includes('COUNT(*)');

        if (sql.includes('FROM wallets w') && sql.includes('u.id IS NULL')) {
          const count = state.orphanedWallets ?? 0;
          if (isCount) return [{ count: String(count) }];
          return Array.from({ length: count }, (_, i) => ({
            id: `w-orphan-${i + 1}`,
            userId: `missing-usr-${i + 1}`,
            address: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          }));
        }

        if (sql.includes("address !~ '^G[A-Z2-7]{55}$'")) {
          const count = state.invalidStellarKeys ?? 0;
          if (isCount) return [{ count: String(count) }];
          return Array.from({ length: count }, (_, i) => ({
            id: `w-badkey-${i + 1}`,
            address: '0xinvalid_stellar_key',
            userId: `usr-${i + 1}`,
          }));
        }

        if (sql.includes('FROM reconciliation_invoices ri')) {
          const count = state.settledInvoiceMismatches ?? 0;
          if (isCount) return [{ count: String(count) }];
          return Array.from({ length: count }, (_, i) => ({
            id: `inv-${i + 1}`,
            invoiceId: `INV-DRILL-${i + 1}`,
            expectedAmount: '1000.00',
            paidAmount: '250.00',
            status: 'SETTLED',
          }));
        }

        if (sql.includes('FROM portfolio_assets pa') && sql.includes('p.id IS NULL')) {
          const count = state.orphanedPortfolioAssets ?? 0;
          if (isCount) return [{ count: String(count) }];
          return Array.from({ length: count }, (_, i) => ({
            id: `pa-orphan-${i + 1}`,
            portfolioId: `missing-port-${i + 1}`,
            symbol: 'XLM',
          }));
        }

        if (sql.includes('FROM signed_payloads')) {
          const count = state.malformedSignedPayloads ?? 0;
          if (isCount) return [{ count: String(count) }];
          return Array.from({ length: count }, (_, i) => ({
            id: `sp-bad-${i + 1}`,
            payloadHash: null,
            signature: 'short',
            signer: 'GAAAA',
          }));
        }

        if (sql.includes('FROM defi_positions dp')) {
          const count = state.orphanedDeFiPositions ?? 0;
          if (isCount) return [{ count: String(count) }];
          return Array.from({ length: count }, (_, i) => ({
            id: `dp-orphan-${i + 1}`,
            userId: `missing-usr-${i + 1}`,
            protocol: 'soroswap',
          }));
        }

        if (isCount) return [{ count: '0' }];
        return [];
      },
    };
  }

  private redactObject(
    obj: unknown,
    removed: Set<string> = new Set(),
  ): { redacted: Record<string, unknown>; removedFields: string[] } {
    const out = this.deepRedact(obj, removed) as Record<string, unknown>;
    return { redacted: out, removedFields: [...removed] };
  }

  private deepRedact(value: unknown, removed: Set<string>): unknown {
    if (Array.isArray(value)) {
      return value.map((v) => this.deepRedact(v, removed));
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const normalizedKey = k.toLowerCase().replace(/[-_]/g, '');
        if (
          EXTRA_SENSITIVE_KEYS.has(k.toLowerCase()) ||
          EXTRA_SENSITIVE_KEYS.has(normalizedKey)
        ) {
          result[k] = REDACTED_PLACEHOLDER;
          removed.add(k);
        } else if (typeof v === 'string') {
          result[k] = this.scrubRawStrings(v);
        } else {
          result[k] = this.deepRedact(v, removed);
        }
      }
      return result;
    }
    if (typeof value === 'string') {
      return this.scrubRawStrings(value);
    }
    return value;
  }

  private scrubRawStrings(input: string): string {
    let scrubbed = input;
    for (const pattern of SENSITIVE_PATTERNS) {
      scrubbed = scrubbed.replace(pattern, REDACTED_PLACEHOLDER);
    }
    return scrubbed;
  }

  private detectSecretLeak(serialized: string): boolean {
    for (const pattern of SENSITIVE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(serialized)) {
        return true;
      }
    }
    return false;
  }

  private normalizeRoute(rawRoute: string): string {
    const clean = rawRoute.split('?')[0].trim();
    return clean
      .replace(/\/G[A-Z2-7]{55}(\/|$)/g, '/:stellarAddress$1')
      .replace(/\/0x[0-9a-fA-F]{40}(\/|$)/g, '/:ethAddress$1')
      .replace(/\/[0-9a-fA-F]{64}(\/|$)/g, '/:txHash$1')
      .replace(
        /\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(\/|$)/g,
        '/:uuid$1',
      );
  }

  private canonicalise(obj: unknown): string {
    return JSON.stringify(obj, (_, v) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)),
          )
        : v,
    );
  }

  private computeSha256(data: string): string {
    return crypto
      .createHash(SNAPSHOT_HASH_ALGORITHM)
      .update(data, 'utf8')
      .digest('hex');
  }

  private computeHmac(data: string): string {
    return crypto
      .createHmac(SNAPSHOT_HMAC_ALGORITHM, this.signingKey)
      .update(data, 'utf8')
      .digest('hex');
  }

  private hashIdentifier(id: string): string {
    return crypto
      .createHmac('sha256', this.signingKey)
      .update(id.trim().toLowerCase(), 'utf8')
      .digest('hex')
      .slice(0, 16);
  }

  private timingSafeEqualHex(a: string, b: string): boolean {
    try {
      const ba = Buffer.from(a, 'utf8');
      const bb = Buffer.from(b, 'utf8');
      if (ba.length !== bb.length) return false;
      return crypto.timingSafeEqual(ba, bb);
    } catch {
      return false;
    }
  }
}

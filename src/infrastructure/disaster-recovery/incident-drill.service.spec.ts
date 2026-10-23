import { Test, TestingModule } from '@nestjs/testing';
import { IncidentDrillService } from './incident-drill.service';
import {
  DrillPhase,
  DrillScenarioId,
  DrillSubsystem,
  IncidentSeverity,
} from './incident-drill.types';
import { OperationType } from '../../common/contract/types/trellis-contract.types';

describe('IncidentDrillService', () => {
  let service: IncidentDrillService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IncidentDrillService],
    }).compile();

    service = module.get<IncidentDrillService>(IncidentDrillService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('runAllDrillScenarios', () => {
    it('should execute all 5 incident drill scenarios and pass every verification step', async () => {
      const suiteReport = await service.runAllDrillScenarios();

      expect(suiteReport.allPassed).toBe(true);
      expect(suiteReport.totalScenarios).toBe(5);
      expect(suiteReport.passedScenarios).toBe(5);
      expect(suiteReport.failedScenarios).toBe(0);
      expect(suiteReport.totalSteps).toBe(30);
      expect(suiteReport.passedSteps).toBe(30);

      for (const scenario of suiteReport.scenarios) {
        expect(scenario.passed).toBe(true);
        for (const step of scenario.steps) {
          expect(step.passed).toBe(true);
        }
      }
    });
  });

  describe('verifyRollbackAndContainment', () => {
    it('should verify safe binary rollback when snapshot is intact and schema is compatible', () => {
      const result = service.verifyRollbackAndContainment({
        scopesToPause: ['payments', 'settlements'],
        migrationCheck: {
          currentReleaseSha: 'sha256:bad002',
          targetReleaseSha: 'sha256:good001',
          currentMigrationVersion: '1729000001-Base',
          targetMigrationVersion: '1729000001-Base',
          hasDestructiveSchemaChanges: false,
          openApiContractCompatible: true,
        },
        snapshotPayload: {
          scope: 'settlements',
          secret: 'should-be-redacted',
        },
      });

      expect(result.allowed).toBe(true);
      expect(result.executed).toBe(true);
      expect(result.strategy).toBe('binary_rollback');
      expect(result.snapshotVerified).toBe(true);
      expect(result.pausedScopes).toEqual(['payments', 'settlements']);
      expect(result.resumedScopes).toEqual(['payments', 'settlements']);
      expect(result.auditTrailCount).toBe(4);
      expect(result.postRollbackProbes.live).toBe(true);
      expect(result.postRollbackProbes.ready).toBe(true);
      expect(result.postRollbackProbes.startup).toBe(true);
    });

    it('should block binary rollback when destructive schema changes are present', () => {
      const result = service.verifyRollbackAndContainment({
        scopesToPause: ['payments'],
        migrationCheck: {
          currentReleaseSha: 'sha256:bad002',
          targetReleaseSha: 'sha256:good001',
          currentMigrationVersion: '1729000002-DropLegacyColumn',
          targetMigrationVersion: '1729000001-Base',
          hasDestructiveSchemaChanges: true,
          openApiContractCompatible: true,
        },
        snapshotPayload: { scope: 'payments' },
      });

      expect(result.allowed).toBe(false);
      expect(result.executed).toBe(false);
      expect(result.strategy).toBe('forward_fix_required');
      expect(result.resumedScopes).toEqual([]);
      expect(result.blockingReasons[0]).toContain(
        'Destructive schema migration',
      );
    });

    it('should block rollback when target release uses mutable tag "latest"', () => {
      const result = service.verifyRollbackAndContainment({
        scopesToPause: ['all'],
        migrationCheck: {
          currentReleaseSha: 'sha256:bad002',
          targetReleaseSha: 'latest',
          currentMigrationVersion: '1729000001-Base',
          targetMigrationVersion: '1729000001-Base',
          hasDestructiveSchemaChanges: false,
          openApiContractCompatible: true,
        },
        snapshotPayload: { scope: 'all' },
      });

      expect(result.allowed).toBe(false);
      expect(result.executed).toBe(false);
      expect(result.blockingReasons[0]).toContain('Mutable tag');
    });

    it('should reject rollback when pre-mitigation snapshot has been tampered with', () => {
      const result = service.verifyRollbackAndContainment({
        scopesToPause: ['exports'],
        migrationCheck: {
          currentReleaseSha: 'sha256:bad002',
          targetReleaseSha: 'sha256:good001',
          currentMigrationVersion: '1729000001-Base',
          targetMigrationVersion: '1729000001-Base',
          hasDestructiveSchemaChanges: false,
          openApiContractCompatible: true,
        },
        snapshotPayload: { scope: 'exports', recordCount: 10 },
        tamperSnapshotAfterCapture: true,
      });

      expect(result.allowed).toBe(false);
      expect(result.executed).toBe(false);
      expect(result.snapshotVerified).toBe(false);
      expect(result.strategy).toBe('blocked_tampered_snapshot');
    });
  });

  describe('verifyDataValidation', () => {
    it('should detect pre-repair domain invariant failures and pass gate once repaired', async () => {
      const result = await service.verifyDataValidation({
        preRepairState: {
          orphanedWallets: 2,
          settledInvoiceMismatches: 1,
          malformedSignedPayloads: 3,
        },
        postRepairState: {
          orphanedWallets: 0,
          settledInvoiceMismatches: 0,
          malformedSignedPayloads: 0,
        },
        reconciliationMatchedCount: 18,
        reconciliationUnmatchedCount: 0,
        reconciliationCriticalCount: 0,
      });

      expect(result.preRepairConsistent).toBe(false);
      expect(result.preRepairCriticalCount).toBe(3);
      expect(result.detectedFailureCodes).toEqual(
        expect.arrayContaining([
          'AUTH_ORPHANED_WALLETS',
          'RECONCILIATION_INVOICE_SETTLEMENT_CONSISTENCY',
          'ORACLE_MALFORMED_SIGNED_PAYLOADS',
        ]),
      );
      expect(result.postRepairConsistent).toBe(true);
      expect(result.gatePassed).toBe(true);
      expect(result.verifiedCategories.length).toBe(7);
    });

    it('should fail the data validation gate if post-repair critical violations remain', async () => {
      const result = await service.verifyDataValidation({
        preRepairState: { orphanedDeFiPositions: 2 },
        postRepairState: { orphanedDeFiPositions: 1 },
      });

      expect(result.postRepairConsistent).toBe(false);
      expect(result.gatePassed).toBe(false);
      expect(result.postRepairCriticalCount).toBe(1);
    });
  });

  describe('verifyRecoveryWorkflow', () => {
    it('should execute idempotent retries without duplicate side effects and clear actions on resolution', () => {
      const result = service.verifyRecoveryWorkflow([
        {
          operationId: 'op-1',
          operationType: OperationType.Payment,
          userId: 'user-a',
          title: 'Payment Recovery',
          description: 'Retry payment settlement',
          idempotencyKey: 'idem-op-1',
        },
        {
          operationId: 'op-2',
          operationType: OperationType.Staking,
          userId: 'user-b',
          title: 'Staking Recovery',
          description: 'Retry staking operation',
          idempotencyKey: 'idem-op-2',
        },
      ]);

      expect(result.totalOperationsRegistered).toBe(2);
      expect(result.retriedCount).toBe(2);
      expect(result.resolvedCount).toBe(2);
      expect(result.duplicateSideEffectsDetected).toBe(0);
      expect(result.terminalStateImmutabilityVerified).toBe(true);
      expect(result.tenantIsolationVerified).toBe(true);
      expect(result.accessChecks).toEqual([
        {
          entryId: 'rec-op-1',
          ownerAccessAllowed: true,
          crossTenantAccessDenied: true,
        },
        {
          entryId: 'rec-op-2',
          ownerAccessAllowed: true,
          crossTenantAccessDenied: true,
        },
      ]);
      expect(result.onChainLinksVerified).toBe(true);
      expect(result.entries.every((e) => e.finalState === 'resolved')).toBe(
        true,
      );
      expect(result.entries.every((e) => !e.hasResidualActions)).toBe(true);
    });
  });

  describe('generateUserImpactReport', () => {
    it('should accurately compute blast radius, normalize high-cardinality routes, and redact secrets', () => {
      const fixedNow = new Date('2026-10-16T08:00:00.000Z');
      const report = service.generateUserImpactReport({
        incidentId: 'INC-900',
        scenarioId: DrillScenarioId.SEV1_SETTLEMENT_AND_PORTFOLIO_DRIFT,
        severity: IncidentSeverity.SEV_1,
        now: fixedNow,
        impactedOperations: [
          {
            userId: 'user-1',
            operationId: 'op-1',
            subsystem: DrillSubsystem.SETTLEMENT,
            amountAtRisk: '250.2500000',
            route:
              '/api/v1/reconcile/tx/9cc3bcab9450390ce5e214045a41e70e6d4a920f2bbc3e5d873c90eadfb7e45c',
            metadata: {
              jwtSecret: 'raw-jwt-secret',
              privateKey:
                'SBCW2ACURUSJJXAX6JUSKNA7D7H7UJJJAXD777777777777777777777',
            },
          },
          {
            userId: 'user-1',
            operationId: 'op-2',
            subsystem: DrillSubsystem.PORTFOLIO,
            amountAtRisk: '49.7500000',
            route:
              '/api/v1/portfolios/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/assets',
          },
          {
            userId: 'user-2',
            operationId: 'op-3',
            subsystem: DrillSubsystem.DEFI,
            amountAtRisk: '100.0000000',
            route:
              '/api/v1/defi/0x1234567890123456789012345678901234567890/positions',
          },
        ],
        rawDiagnosticContext: {
          password: 'db-password',
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.sig',
        },
      });

      expect(report.affectedUserCount).toBe(2);
      expect(report.affectedOperationCount).toBe(3);
      expect(report.totalExposureUnits).toBe('400.0000000');
      expect(report.updateCadenceMinutes).toBe(30);
      expect(report.nextUpdateAt).toBe('2026-10-16T08:30:00.000Z');
      expect(report.notificationsQueued).toBe(2);
      expect(report.deduplicationKeys.length).toBe(2);
      expect(report.degradedRoutes).toEqual([
        '/api/v1/reconcile/tx/:txHash',
        '/api/v1/portfolios/:uuid/assets',
        '/api/v1/defi/:ethAddress/positions',
      ]);
      expect(report.redactedFields).toEqual(
        expect.arrayContaining([
          'password',
          'token',
          'jwtSecret',
          'privateKey',
        ]),
      );
      expect(report.containsUnredactedSecrets).toBe(false);
    });
  });
});

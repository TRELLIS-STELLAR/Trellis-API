import { InvariantCategory, InvariantSeverity } from './disaster-recovery.types';
import { OperationType, RecoveryState } from '../../common/contract/types/trellis-contract.types';

export enum IncidentSeverity {
  SEV_1 = 'SEV-1',
  SEV_2 = 'SEV-2',
  SEV_3 = 'SEV-3',
  SEV_4 = 'SEV-4',
}

export enum DrillSubsystem {
  AUTH = 'auth',
  PORTFOLIO = 'portfolio',
  DEFI = 'defi',
  NOTIFICATIONS = 'notifications',
  OBSERVABILITY = 'observability',
  API_CONTRACTS = 'api_contracts',
  SETTLEMENT = 'settlement',
}

export enum DrillPhase {
  CONTAINMENT = 'CONTAINMENT',
  SNAPSHOT_VERIFICATION = 'SNAPSHOT_VERIFICATION',
  ROLLBACK = 'ROLLBACK',
  DATA_VALIDATION = 'DATA_VALIDATION',
  RECOVERY_EXECUTION = 'RECOVERY_EXECUTION',
  USER_IMPACT_REPORTING = 'USER_IMPACT_REPORTING',
  POST_INCIDENT_CLOSURE = 'POST_INCIDENT_CLOSURE',
}

export enum DrillScenarioId {
  SEV1_SETTLEMENT_AND_PORTFOLIO_DRIFT = 'SEV1_SETTLEMENT_AND_PORTFOLIO_DRIFT',
  SEV1_AUTH_KEY_ROTATION_AND_SESSION_CONTAINMENT = 'SEV1_AUTH_KEY_ROTATION_AND_SESSION_CONTAINMENT',
  SEV2_DEFI_ORACLE_STALE_FEED_AND_ROLLBACK = 'SEV2_DEFI_ORACLE_STALE_FEED_AND_ROLLBACK',
  EDGE_CASE_UNSAFE_SCHEMA_ROLLBACK_BLOCKED = 'EDGE_CASE_UNSAFE_SCHEMA_ROLLBACK_BLOCKED',
  EDGE_CASE_TAMPERED_SNAPSHOT_REJECTED = 'EDGE_CASE_TAMPERED_SNAPSHOT_REJECTED',
}

export interface MigrationRollbackCheckInput {
  currentReleaseSha: string;
  targetReleaseSha: string;
  currentMigrationVersion: string;
  targetMigrationVersion: string;
  hasDestructiveSchemaChanges: boolean;
  openApiContractCompatible: boolean;
}

export interface ProbeStatusSnapshot {
  live: boolean;
  ready: boolean;
  startup: boolean;
  metricsAvailable: boolean;
  errorRatePercent: number;
  p95LatencyMs: number;
  queueDepth: number;
}

export interface RollbackVerificationResult {
  allowed: boolean;
  executed: boolean;
  strategy: 'binary_rollback' | 'forward_fix_required' | 'point_in_time_restore_required' | 'blocked_tampered_snapshot';
  fromReleaseSha: string;
  toReleaseSha: string;
  snapshotId: string;
  snapshotVerified: boolean;
  pausedScopes: string[];
  resumedScopes: string[];
  postRollbackProbes: ProbeStatusSnapshot;
  blockingReasons: string[];
  auditTrailCount: number;
}

export interface RecoveryOperationInput {
  operationId: string;
  operationType: OperationType;
  userId: string;
  title: string;
  description: string;
  idempotencyKey: string;
}

export interface RecoveryVerificationResult {
  totalOperationsRegistered: number;
  retriedCount: number;
  resolvedCount: number;
  duplicateSideEffectsDetected: number;
  terminalStateImmutabilityVerified: boolean;
  tenantIsolationVerified: boolean;
  onChainLinksVerified: boolean;
  entries: Array<{
    id: string;
    operationId: string;
    userId: string;
    finalState: RecoveryState;
    hasResidualActions: boolean;
  }>;
}

export interface DataValidationGateResult {
  gatePassed: boolean;
  preRepairConsistent: boolean;
  postRepairConsistent: boolean;
  preRepairCriticalCount: number;
  preRepairErrorCount: number;
  postRepairCriticalCount: number;
  postRepairErrorCount: number;
  reconciliationCriticalCount: number;
  reconciliationMatchedTransactions: number;
  reconciliationUnmatchedTransactions: number;
  verifiedCategories: InvariantCategory[];
  detectedFailureCodes: string[];
}

export interface ImpactedOperationRecord {
  userId: string;
  operationId: string;
  subsystem: DrillSubsystem;
  amountAtRisk?: string;
  assetCode?: string;
  route?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface UserImpactReport {
  incidentId: string;
  scenarioId: DrillScenarioId;
  severity: IncidentSeverity;
  generatedAt: string;
  nextUpdateAt: string;
  updateCadenceMinutes: number;
  affectedSubsystems: DrillSubsystem[];
  affectedUserCount: number;
  affectedOperationCount: number;
  totalExposureUnits: string;
  degradedRoutes: string[];
  notificationsQueued: number;
  deduplicationKeys: string[];
  redactedFields: string[];
  publicStatusSummary: string;
  operatorActionItems: string[];
  containsUnredactedSecrets: boolean;
}

export interface DrillStepCheck {
  phase: DrillPhase;
  name: string;
  passed: boolean;
  detail: string;
  remediation?: string;
}

export interface IncidentDrillScenarioReport {
  scenarioId: DrillScenarioId;
  title: string;
  severity: IncidentSeverity;
  passed: boolean;
  durationMs: number;
  subsystems: DrillSubsystem[];
  steps: DrillStepCheck[];
  rollback: RollbackVerificationResult;
  dataValidation: DataValidationGateResult;
  recovery: RecoveryVerificationResult;
  userImpact: UserImpactReport;
}

export interface IncidentDrillSuiteReport {
  executedAt: string;
  allPassed: boolean;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  totalSteps: number;
  passedSteps: number;
  durationMs: number;
  scenarios: IncidentDrillScenarioReport[];
}

export interface InjectedSqlState {
  orphanedWallets?: number;
  invalidStellarKeys?: number;
  settledInvoiceMismatches?: number;
  orphanedPortfolioAssets?: number;
  malformedSignedPayloads?: number;
  orphanedDeFiPositions?: number;
}

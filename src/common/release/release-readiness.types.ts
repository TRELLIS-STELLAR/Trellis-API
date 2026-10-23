/**
 * Types and contracts for Trellis API Release Readiness Verification.
 *
 * Covers:
 * - Migration safety and reversibility
 * - Smoke testing with retry boundaries
 * - Zero-downtime rollback safety and backward compatibility
 * - Authorization and audit logging
 */

export interface MigrationFileSpec {
  filename: string;
  hasDownMethod: boolean;
  hasExclusiveLock: boolean;
  createsIndexConcurrently: boolean;
  hasUnsafeNotNullAdd: boolean;
  hasDestructiveDrop: boolean;
  issues: string[];
  warnings: string[];
}

export interface MigrationReadinessReport {
  isReady: boolean;
  checkedCount: number;
  reversibleCount: number;
  lockingSafeCount: number;
  issues: string[];
  warnings: string[];
  recommendations: string[];
  fileSpecs: MigrationFileSpec[];
}

export interface SmokeProbe {
  name: string;
  endpoint?: string;
  method?: "GET" | "POST" | "HEAD";
  timeoutMs?: number;
  probeFn?: () => Promise<{ ok: boolean; status?: number; error?: string }>;
  required?: boolean;
}

export interface SmokeTestOptions {
  maxAttempts?: number;
  backoffMs?: number;
  timeoutMs?: number;
  onRetry?: (probeName: string, attempt: number, err?: string) => void;
}

export interface SmokeProbeResult {
  name: string;
  status: "PASSED" | "FAILED" | "WARN";
  attempts: number;
  durationMs: number;
  statusCode?: number;
  error?: string;
  detail: string;
}

export interface SmokeTestReport {
  allPassed: boolean;
  totalProbes: number;
  passedProbes: number;
  failedProbes: number;
  warnedProbes: number;
  totalDurationMs: number;
  results: SmokeProbeResult[];
}

export interface SchemaColumnSpec {
  table: string;
  column: string;
  isNew: boolean;
  isNullable: boolean;
  hasDefault: boolean;
  isDropped?: boolean;
  isRenamed?: boolean;
}

export interface RollbackReadinessReport {
  safeForZeroDowntimeRollback: boolean;
  backwardCompatible: boolean;
  breakingChanges: string[];
  warnings: string[];
  rollbackGuidance: string[];
}

export interface ReleaseAuditEntry {
  action: "CREATE" | "CHECK_UPDATE" | "WAIVE" | "APPROVE" | "AUTOMATED_VERIFY";
  actor: string;
  timestamp: Date;
  details: string;
  previousStatus?: string;
  newStatus?: string;
}

export interface AutomatedVerificationPayload {
  migrations?: Array<{ filename: string; content: string }>;
  smokeProbes?: SmokeProbe[];
  schemaChanges?: SchemaColumnSpec[];
  options?: SmokeTestOptions;
}

export interface ReleaseReadinessEvaluation {
  prNumber: string;
  overallReady: boolean;
  overallStatus: "READY" | "NEEDS_ATTENTION" | "BLOCKED";
  migrationReport?: MigrationReadinessReport;
  smokeTestReport?: SmokeTestReport;
  rollbackReport?: RollbackReadinessReport;
  evaluatedAt: Date;
  blockingReasons: string[];
}

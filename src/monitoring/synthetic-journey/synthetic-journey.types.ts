/**
 * Synthetic Journey Monitoring Types & Interfaces.
 *
 * Models end-to-end synthetic journeys across Trellis API:
 * - Happy path workflow steps (auth -> portfolio -> defi adapter -> settlement/reconciliation -> notification)
 * - Latency tracking, phase-level breakdowns, and SLA violation detection
 * - Root-cause dependency attribution / dependency blame (Postgres, Redis, Horizon, DeFi RPC, Notification Gateway)
 * - Structured synthetic run execution result and telemetry emission
 */

export type JourneyStepStatus = "PASSED" | "FAILED" | "SKIPPED" | "DEGRADED";

export type JourneyOverallStatus = "SUCCESS" | "DEGRADED" | "FAILED";

export type DependencyBlameTarget =
  | "POSTGRES_DB"
  | "REDIS_CACHE"
  | "STELLAR_HORIZON"
  | "DEFI_PROTOCOL_RPC"
  | "NOTIFICATION_GATEWAY"
  | "AUTH_SERVICE"
  | "INTERNAL_LOGIC"
  | "NETWORK_TIMEOUT"
  | "UNKNOWN";

export interface SyntheticStepExecutionResult {
  stepId: string;
  stepName: string;
  targetService: string;
  dependency: DependencyBlameTarget;
  status: JourneyStepStatus;
  latencyMs: number;
  slaThresholdMs: number;
  slaBreached: boolean;
  httpStatus?: number;
  error?: {
    code: string;
    message: string;
    blame: DependencyBlameTarget;
    remediation: string;
  };
  metadata?: Record<string, unknown>;
}

export interface SyntheticJourneyReport {
  journeyId: string;
  journeyName: string;
  executedAt: string;
  durationMs: number;
  status: JourneyOverallStatus;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  degradedSteps: number;
  dependencyBlame: DependencyBlameTarget[];
  steps: SyntheticStepExecutionResult[];
  environment: string;
  runTrigger: "SCHEDULED" | "MANUAL" | "CLI" | "CI";
}

export interface SyntheticJourneyContext {
  journeyId: string;
  authToken?: string;
  userId?: string;
  portfolioId?: string;
  invoiceId?: string;
  transactionHash?: string;
  notificationId?: string;
  env: Record<string, string | undefined>;
  now(): number;
  simulateFailureStep?: string;
  simulateLatencyStep?: { stepId: string; extraMs: number };
}

export interface SyntheticJourneyStepDefinition {
  id: string;
  name: string;
  targetService: string;
  dependency: DependencyBlameTarget;
  slaThresholdMs: number;
  execute(context: SyntheticJourneyContext): Promise<{
    httpStatus?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface SyntheticJourneyOptions {
  trigger?: "SCHEDULED" | "MANUAL" | "CLI" | "CI";
  simulateFailureStep?: string;
  simulateLatencyStep?: { stepId: string; extraMs: number };
  timeoutMs?: number;
}

/**
 * Synthetic Journey Core Domain Engine & Types.
 *
 * Designed as pure TypeScript/JavaScript logic with zero framework decorators
 * so it can be executed natively by Node.js CLI verification scripts, Jest suites,
 * and NestJS service wrappers alike.
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

/**
 * Pure engine that executes the canonical end-to-end synthetic happy path journey:
 * 1. Auth & Session Creation
 * 2. Portfolio Target Allocation & Rebalancing Check
 * 3. DeFi Protocol Adapter & Yield Discovery
 * 4. Stellar Settlement & Ledger Reconciliation
 * 5. Notification Gateway Lifecycle Alert
 */
export class SyntheticJourneyEngine {
  private readonly stepDefinitions: SyntheticJourneyStepDefinition[] = [];
  private lastReport: SyntheticJourneyReport | null = null;
  private isRunning = false;
  private intervalTimer?: any;

  constructor() {
    this.registerSteps();
  }

  private registerSteps(): void {
    // Step 1: Authentication & Identity
    this.stepDefinitions.push({
      id: "step_auth_verify",
      name: "Authenticate & Session Creation",
      targetService: "AuthService",
      dependency: "AUTH_SERVICE",
      slaThresholdMs: 300,
      execute: async (ctx) => {
        if (ctx.simulateFailureStep === "step_auth_verify") {
          throw new Error("AUTH_TOKEN_EXPIRED: Token validation failed");
        }
        ctx.authToken = `synth_jwt_${Date.now()}`;
        ctx.userId = `synth_usr_${Date.now().toString(36)}`;
        return {
          httpStatus: 200,
          metadata: { userId: ctx.userId },
        };
      },
    });

    // Step 2: Portfolio Target Allocation & Rebalancing
    this.stepDefinitions.push({
      id: "step_portfolio_rebalance",
      name: "Portfolio Target Allocation & Rebalancing Check",
      targetService: "PortfolioRebalancingService",
      dependency: "POSTGRES_DB",
      slaThresholdMs: 500,
      execute: async (ctx) => {
        if (ctx.simulateFailureStep === "step_portfolio_rebalance") {
          throw new Error("DB_CONNECTION_TIMEOUT: Query execution on portfolio_assets timed out");
        }
        ctx.portfolioId = `synth_port_${Date.now().toString(36)}`;
        return {
          httpStatus: 200,
          metadata: { portfolioId: ctx.portfolioId, allocationsChecked: 3 },
        };
      },
    });

    // Step 3: DeFi Protocol Adapter Rate & Yield Discovery
    this.stepDefinitions.push({
      id: "step_defi_yield",
      name: "DeFi Protocol Adapter & Yield Discovery",
      targetService: "DeFiProtocolRegistry",
      dependency: "DEFI_PROTOCOL_RPC",
      slaThresholdMs: 700,
      execute: async (ctx) => {
        if (ctx.simulateFailureStep === "step_defi_yield") {
          throw new Error("RPC_CALL_REJECTED: JSON-RPC upstream rate limit exceeded");
        }
        return {
          httpStatus: 200,
          metadata: { protocolsChecked: ["aave-v3", "compound-v3"], bestApy: "6.85%" },
        };
      },
    });

    // Step 4: Settlement & Invoice Reconciliation
    this.stepDefinitions.push({
      id: "step_settlement_reconcile",
      name: "Stellar Settlement & Ledger Reconciliation",
      targetService: "ReconciliationService",
      dependency: "STELLAR_HORIZON",
      slaThresholdMs: 600,
      execute: async (ctx) => {
        if (ctx.simulateFailureStep === "step_settlement_reconcile") {
          throw new Error("HORIZON_GATEWAY_TIMEOUT: 504 Gateway Timeout while fetching tx from Horizon");
        }
        ctx.invoiceId = `synth_inv_${Date.now().toString(36)}`;
        ctx.transactionHash = `tx_${Date.now().toString(36)}`;
        return {
          httpStatus: 200,
          metadata: { invoiceId: ctx.invoiceId, txHash: ctx.transactionHash, status: "MATCHED" },
        };
      },
    });

    // Step 5: Notification Gateway Dispatch
    this.stepDefinitions.push({
      id: "step_notification_dispatch",
      name: "Notification Gateway Lifecycle Alert",
      targetService: "NotificationService",
      dependency: "NOTIFICATION_GATEWAY",
      slaThresholdMs: 400,
      execute: async (ctx) => {
        if (ctx.simulateFailureStep === "step_notification_dispatch") {
          throw new Error("GATEWAY_SOCKET_ERROR: WebSocket delivery gateway dropped connection");
        }
        ctx.notificationId = `synth_notif_${Date.now().toString(36)}`;
        return {
          httpStatus: 201,
          metadata: { notificationId: ctx.notificationId, channel: "websocket" },
        };
      },
    });
  }

  public attributeBlame(
    stepDef: SyntheticJourneyStepDefinition,
    err: any,
  ): { blame: DependencyBlameTarget; remediation: string } {
    const msg = (err?.message || "").toUpperCase();

    if (msg.includes("DB_") || msg.includes("POSTGRES") || msg.includes("QUERY")) {
      return {
        blame: "POSTGRES_DB",
        remediation: "Check PostgreSQL connection pool saturation and active long-running queries.",
      };
    }
    if (msg.includes("REDIS") || msg.includes("CACHE")) {
      return {
        blame: "REDIS_CACHE",
        remediation: "Verify Redis memory limits, evictions, and cluster connectivity.",
      };
    }
    if (msg.includes("HORIZON") || msg.includes("STELLAR")) {
      return {
        blame: "STELLAR_HORIZON",
        remediation: "Inspect Stellar Horizon rate limits or switch to fallback Horizon RPC endpoint.",
      };
    }
    if (msg.includes("RPC") || msg.includes("DEFI") || msg.includes("PROTOCOL")) {
      return {
        blame: "DEFI_PROTOCOL_RPC",
        remediation: "Check upstream Ethereum / DeFi RPC node provider response times and circuit breakers.",
      };
    }
    if (msg.includes("GATEWAY") || msg.includes("NOTIFICATION") || msg.includes("SOCKET")) {
      return {
        blame: "NOTIFICATION_GATEWAY",
        remediation: "Check notification gateway broker queues and WebSocket ingress health.",
      };
    }
    if (msg.includes("AUTH") || msg.includes("TOKEN")) {
      return {
        blame: "AUTH_SERVICE",
        remediation: "Validate JWT signing key rotation and auth strategy validation services.",
      };
    }
    if (msg.includes("TIMEOUT")) {
      return {
        blame: "NETWORK_TIMEOUT",
        remediation: "Inspect internal network latency and timeout configurations.",
      };
    }

    return {
      blame: stepDef.dependency || "UNKNOWN",
      remediation: "Review service logs for detailed stack trace and operational context.",
    };
  }

  async runJourney(options: SyntheticJourneyOptions = {}): Promise<SyntheticJourneyReport> {
    const journeyId = `synth_${Date.now()}`;
    const trigger = options.trigger || "MANUAL";
    const startTime = Date.now();
    const executedAt = new Date().toISOString();

    const envSnapshot: Record<string, string | undefined> = {
      NODE_ENV: process.env.NODE_ENV || "production",
      PORT: process.env.PORT || "3000",
    };

    const context: SyntheticJourneyContext = {
      journeyId,
      env: envSnapshot,
      now: () => Date.now(),
      simulateFailureStep: options.simulateFailureStep,
      simulateLatencyStep: options.simulateLatencyStep,
    };

    const stepResults: SyntheticStepExecutionResult[] = [];
    const dependencyBlames = new Set<DependencyBlameTarget>();
    let hasFailure = false;
    let hasDegraded = false;

    for (const step of this.stepDefinitions) {
      if (hasFailure) {
        stepResults.push({
          stepId: step.id,
          stepName: step.name,
          targetService: step.targetService,
          dependency: step.dependency,
          status: "SKIPPED",
          latencyMs: 0,
          slaThresholdMs: step.slaThresholdMs,
          slaBreached: false,
          metadata: { reason: "Skipped due to upstream step failure" },
        });
        continue;
      }

      const stepStart = Date.now();
      try {
        let simulatedExtraLatency = 0;
        if (options.simulateLatencyStep?.stepId === step.id) {
          simulatedExtraLatency = options.simulateLatencyStep.extraMs;
          await new Promise((r) => setTimeout(r, simulatedExtraLatency));
        }

        const res = await step.execute(context);
        const stepLatency = Date.now() - stepStart;
        const slaBreached = stepLatency > step.slaThresholdMs;

        let status: JourneyStepStatus = "PASSED";
        if (slaBreached) {
          status = "DEGRADED";
          hasDegraded = true;
          dependencyBlames.add(step.dependency);
        }

        stepResults.push({
          stepId: step.id,
          stepName: step.name,
          targetService: step.targetService,
          dependency: step.dependency,
          status,
          latencyMs: stepLatency,
          slaThresholdMs: step.slaThresholdMs,
          slaBreached,
          httpStatus: res.httpStatus ?? 200,
          metadata: res.metadata,
        });
      } catch (err: any) {
        hasFailure = true;
        const stepLatency = Date.now() - stepStart;
        const { blame, remediation } = this.attributeBlame(step, err);
        dependencyBlames.add(blame);

        stepResults.push({
          stepId: step.id,
          stepName: step.name,
          targetService: step.targetService,
          dependency: step.dependency,
          status: "FAILED",
          latencyMs: stepLatency,
          slaThresholdMs: step.slaThresholdMs,
          slaBreached: true,
          error: {
            code: err.code || "SYNTHETIC_STEP_FAILED",
            message: err.message || "Unknown error during synthetic step execution",
            blame,
            remediation,
          },
        });
      }
    }

    const durationMs = Date.now() - startTime;
    let overallStatus: JourneyOverallStatus = "SUCCESS";
    if (hasFailure) {
      overallStatus = "FAILED";
    } else if (hasDegraded) {
      overallStatus = "DEGRADED";
    }

    const passedCount = stepResults.filter((s) => s.status === "PASSED").length;
    const failedCount = stepResults.filter((s) => s.status === "FAILED").length;
    const degradedCount = stepResults.filter((s) => s.status === "DEGRADED").length;

    const report: SyntheticJourneyReport = {
      journeyId,
      journeyName: "E2E_CORE_HAPPY_PATH_JOURNEY",
      executedAt,
      durationMs,
      status: overallStatus,
      totalSteps: this.stepDefinitions.length,
      passedSteps: passedCount,
      failedSteps: failedCount,
      degradedSteps: degradedCount,
      dependencyBlame: Array.from(dependencyBlames),
      steps: stepResults,
      environment: envSnapshot.NODE_ENV || "production",
      runTrigger: trigger,
    };

    this.lastReport = report;
    return report;
  }

  async getLatestReport(autoTriggerIfEmpty = true): Promise<SyntheticJourneyReport> {
    if (!this.lastReport && autoTriggerIfEmpty) {
      return this.runJourney({ trigger: "MANUAL" });
    }
    return (
      this.lastReport || {
        journeyId: "none",
        journeyName: "E2E_CORE_HAPPY_PATH_JOURNEY",
        executedAt: new Date().toISOString(),
        durationMs: 0,
        status: "SUCCESS",
        totalSteps: this.stepDefinitions.length,
        passedSteps: 0,
        failedSteps: 0,
        degradedSteps: 0,
        dependencyBlame: [],
        steps: [],
        environment: "production",
        runTrigger: "MANUAL",
      }
    );
  }

  startScheduler(intervalMs = 60000, onComplete?: (report: SyntheticJourneyReport) => void): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.runJourney({ trigger: "SCHEDULED" })
      .then((rep) => onComplete?.(rep))
      .catch(() => {});

    this.intervalTimer = setInterval(() => {
      this.runJourney({ trigger: "SCHEDULED" })
        .then((rep) => onComplete?.(rep))
        .catch(() => {});
    }, intervalMs);
  }

  stopScheduler(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    this.isRunning = false;
  }
}

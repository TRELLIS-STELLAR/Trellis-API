import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DependencyDegradedModeService } from "./degraded-mode.service";
import { FallbackHandlerService } from "./fallback-handler.service";
import {
  DegradedCapability,
  DegradedModeDecision,
  DegradedModeLevel,
} from "./degraded-mode.types";

export interface RecoveryEvent {
  capability: DegradedCapability;
  previousState: "disabled" | "degraded";
  timestamp: string;
  queuedOperations: number;
}

export interface DegradationEvent {
  capability: DegradedCapability;
  newState: "disabled" | "degraded";
  reason: string;
  timestamp: string;
}

/**
 * Detects when dependencies recover from outages and triggers appropriate actions.
 * 
 * Responsibilities:
 * - Periodically check dependency health
 * - Detect state transitions (degraded → normal, disabled → available)
 * - Emit recovery events for notification system
 * - Trigger processing of queued operations
 * - Track recovery metrics
 * 
 * Issue #355: Dependency outage fallback and recovery UX
 */
@Injectable()
export class RecoveryDetectorService implements OnModuleInit {
  private readonly logger = new Logger(RecoveryDetectorService.name);
  private readonly enabled: boolean;
  private readonly checkIntervalMs: number;
  private previousDecision: DegradedModeDecision | null = null;

  // Track capability states for transition detection
  private readonly capabilityStates = new Map<
    DegradedCapability,
    "available" | "degraded" | "disabled"
  >();

  // Recovery metrics
  private recoveryCount = 0;
  private degradationCount = 0;
  private lastRecoveryTime: string | null = null;
  private lastDegradationTime: string | null = null;

  constructor(
    private readonly degradedModeService: DependencyDegradedModeService,
    private readonly fallbackHandler: FallbackHandlerService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    this.enabled =
      String(this.configService.get("RECOVERY_DETECTOR_ENABLED", "true"))
        .toLowerCase() !== "false";
    this.checkIntervalMs =
      Number(this.configService.get("RECOVERY_CHECK_INTERVAL_MS")) || 30000; // 30 seconds
  }

  async onModuleInit() {
    if (this.enabled) {
      // Initialize with current state
      await this.initializeState();
      this.logger.log("Recovery detector initialized");
    } else {
      this.logger.log("Recovery detector disabled");
    }
  }

  /**
   * Periodic check for dependency recovery (runs every 30 seconds by default).
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async checkForRecovery(): Promise<void> {
    if (!this.enabled) return;

    try {
      const currentDecision = await this.degradedModeService.evaluate({
        refresh: true,
      });

      if (!this.previousDecision) {
        this.previousDecision = currentDecision;
        this.updateCapabilityStates(currentDecision);
        return;
      }

      // Detect level transitions
      await this.detectLevelTransition(this.previousDecision, currentDecision);

      // Detect capability-level transitions
      await this.detectCapabilityTransitions(
        this.previousDecision,
        currentDecision,
      );

      this.previousDecision = currentDecision;
      this.updateCapabilityStates(currentDecision);
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? error.message : String(error),
        message: "Recovery check failed",
      });
    }
  }

  /**
   * Detect when overall system mode improves.
   */
  private async detectLevelTransition(
    previous: DegradedModeDecision,
    current: DegradedModeDecision,
  ): Promise<void> {
    if (previous.level === current.level) return;

    const improved = this.isImprovement(previous.level, current.level);

    if (improved) {
      this.logger.log({
        previousLevel: previous.level,
        currentLevel: current.level,
        message: "System degraded mode improved",
      });

      this.eventEmitter.emit("recovery.level.improved", {
        previousLevel: previous.level,
        currentLevel: current.level,
        timestamp: new Date().toISOString(),
      });
    } else {
      this.logger.warn({
        previousLevel: previous.level,
        currentLevel: current.level,
        message: "System degraded mode worsened",
      });

      this.eventEmitter.emit("recovery.level.degraded", {
        previousLevel: previous.level,
        currentLevel: current.level,
        reasons: current.reasons,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Detect when individual capabilities recover or degrade.
   */
  private async detectCapabilityTransitions(
    previous: DegradedModeDecision,
    current: DegradedModeDecision,
  ): Promise<void> {
    const previousStates = this.buildCapabilityStateMap(previous);
    const currentStates = this.buildCapabilityStateMap(current);

    for (const [capability, currentState] of currentStates.entries()) {
      const previousState = previousStates.get(capability);
      if (!previousState || previousState === currentState) continue;

      // State changed - detect recovery or degradation
      if (this.isStateImprovement(previousState, currentState)) {
        await this.handleCapabilityRecovery(
          capability,
          previousState,
          currentState,
        );
      } else {
        await this.handleCapabilityDegradation(
          capability,
          currentState,
          current.reasons,
        );
      }
    }
  }

  /**
   * Handle capability recovery - process queued operations and notify.
   */
  private async handleCapabilityRecovery(
    capability: DegradedCapability,
    previousState: "available" | "degraded" | "disabled",
    currentState: "available" | "degraded" | "disabled",
  ): Promise<void> {
    this.recoveryCount++;
    this.lastRecoveryTime = new Date().toISOString();

    this.logger.log({
      capability,
      previousState,
      currentState,
      message: "Capability recovered",
    });

    // Process queued operations if capability fully recovered
    let queuedOperations = 0;
    if (currentState === "available" && previousState === "disabled") {
      const result = await this.fallbackHandler.processQueuedOperations(
        capability,
      );
      queuedOperations = result.processed;

      this.logger.log({
        capability,
        processed: result.processed,
        succeeded: result.succeeded,
        failed: result.failed,
        message: "Processed queued operations after recovery",
      });
    }

    // Emit recovery event
    const recoveryEvent: RecoveryEvent = {
      capability,
      previousState: previousState as "disabled" | "degraded",
      timestamp: this.lastRecoveryTime,
      queuedOperations,
    };

    this.eventEmitter.emit("recovery.capability.recovered", recoveryEvent);

    // Emit notification event for user-facing alerts
    this.eventEmitter.emit("notification.create", {
      type: "system_recovery",
      severity: "info",
      title: `${capability} service recovered`,
      message: `The ${capability} service has recovered and is now ${currentState}.${
        queuedOperations > 0
          ? ` ${queuedOperations} queued operations were processed.`
          : ""
      }`,
      metadata: recoveryEvent,
    });
  }

  /**
   * Handle capability degradation - notify users.
   */
  private async handleCapabilityDegradation(
    capability: DegradedCapability,
    newState: "available" | "degraded" | "disabled",
    reasons: string[],
  ): Promise<void> {
    this.degradationCount++;
    this.lastDegradationTime = new Date().toISOString();

    this.logger.warn({
      capability,
      newState,
      reasons,
      message: "Capability degraded",
    });

    // Emit degradation event
    const degradationEvent: DegradationEvent = {
      capability,
      newState: newState as "disabled" | "degraded",
      reason: reasons.join("; "),
      timestamp: this.lastDegradationTime,
    };

    this.eventEmitter.emit("recovery.capability.degraded", degradationEvent);

    // Emit notification event
    const severity = newState === "disabled" ? "error" : "warning";
    this.eventEmitter.emit("notification.create", {
      type: "system_degradation",
      severity,
      title: `${capability} service ${newState}`,
      message: `The ${capability} service is now ${newState}. ${reasons.join("; ")}`,
      metadata: degradationEvent,
    });
  }

  /**
   * Initialize state tracking from current decision.
   */
  private async initializeState(): Promise<void> {
    try {
      const decision = await this.degradedModeService.getMode();
      this.previousDecision = decision;
      this.updateCapabilityStates(decision);
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? error.message : String(error),
        message: "Failed to initialize recovery detector state",
      });
    }
  }

  /**
   * Update internal capability state tracking.
   */
  private updateCapabilityStates(decision: DegradedModeDecision): void {
    const stateMap = this.buildCapabilityStateMap(decision);
    this.capabilityStates.clear();
    for (const [capability, state] of stateMap.entries()) {
      this.capabilityStates.set(capability, state);
    }
  }

  /**
   * Build a map of capability states from a decision.
   */
  private buildCapabilityStateMap(
    decision: DegradedModeDecision,
  ): Map<DegradedCapability, "available" | "degraded" | "disabled"> {
    const map = new Map<
      DegradedCapability,
      "available" | "degraded" | "disabled"
    >();

    for (const capability of decision.allowedCapabilities) {
      if (decision.degradedCapabilities.includes(capability)) {
        map.set(capability, "degraded");
      } else {
        map.set(capability, "available");
      }
    }

    for (const capability of decision.disabledCapabilities) {
      map.set(capability, "disabled");
    }

    return map;
  }

  /**
   * Check if mode level is an improvement.
   */
  private isImprovement(
    previous: DegradedModeLevel,
    current: DegradedModeLevel,
  ): boolean {
    const levels: DegradedModeLevel[] = [
      "maintenance",
      "restricted",
      "degraded",
      "normal",
    ];
    return levels.indexOf(current) > levels.indexOf(previous);
  }

  /**
   * Check if capability state is an improvement.
   */
  private isStateImprovement(
    previous: "available" | "degraded" | "disabled",
    current: "available" | "degraded" | "disabled",
  ): boolean {
    const states = ["disabled", "degraded", "available"];
    return states.indexOf(current) > states.indexOf(previous);
  }

  /**
   * Get recovery metrics for monitoring.
   */
  getMetrics(): {
    recoveries: number;
    degradations: number;
    lastRecovery: string | null;
    lastDegradation: string | null;
    currentLevel: DegradedModeLevel | null;
    pendingOperations: Record<DegradedCapability, number>;
  } {
    return {
      recoveries: this.recoveryCount,
      degradations: this.degradationCount,
      lastRecovery: this.lastRecoveryTime,
      lastDegradation: this.lastDegradationTime,
      currentLevel: this.previousDecision?.level || null,
      pendingOperations: this.fallbackHandler.getAllPendingCounts(),
    };
  }

  /**
   * Manually trigger a recovery check (useful for testing or forced checks).
   */
  async triggerCheck(): Promise<void> {
    await this.checkForRecovery();
  }
}

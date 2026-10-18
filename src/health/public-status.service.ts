import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { HealthService } from "./health.service";
import { DependencyHealthService } from "../dependency-health/dependency-health.service";
import { PauseControlService } from "../infrastructure/pause-control/pause-control.service";
import {
  ActivePauseRecordInput,
  ApiRequestGateContext,
  ApiRequestGateDecision,
  BackgroundJobGateContext,
  BackgroundJobGateDecision,
  computeSystemStatusSnapshot,
  DependencyReportSnapshotInput,
  evaluateApiRequestGate,
  evaluateBackgroundJobGate,
  evaluateUiStatusContract,
  MaintenanceWindowInput,
  ManualDegradationInput,
  OperatorSystemStatusView,
  PublicComponentId,
  PublicSystemState,
  PublicSystemStatusView,
  ReadinessSnapshotInput,
  sanitizePublicReason,
  sanitizeStatusText,
  StateTransitionEntry,
  UiStatusBannerContract,
} from "./public-status.model";

const MAX_HISTORY_ENTRIES = 50;

@Injectable()
export class PublicStatusService implements OnModuleInit {
  private readonly logger = new Logger(PublicStatusService.name);
  private maintenanceWindow: MaintenanceWindowInput | null = null;
  private readonly manualDegradations = new Map<
    PublicComponentId,
    ManualDegradationInput
  >();
  private readonly stateHistory: StateTransitionEntry[] = [];
  private lastKnownState: PublicSystemState = "operational";

  constructor(
    @Optional() private readonly healthService?: HealthService,
    @Optional()
    private readonly dependencyHealthService?: DependencyHealthService,
    @Optional() private readonly pauseControlService?: PauseControlService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.registerPauseListeners();
  }

  /**
   * Subscribes to PauseControlService lifecycle events so state transitions
   * triggered by pause activation, resumption, or expiry immediately propagate
   * across UI, API, and background worker paths.
   */
  private registerPauseListeners(): void {
    if (!this.eventEmitter || typeof this.eventEmitter.on !== "function") {
      return;
    }

    this.eventEmitter.on(
      "pause.activated",
      async (payload: { scope?: string; reason?: string; actorId?: string }) => {
        await this.syncStateTransition(
          "pause_activated",
          payload?.actorId ?? "system",
          payload?.reason ?? `Pause activated on scope ${payload?.scope ?? "unknown"}`,
        );
      },
    );

    this.eventEmitter.on(
      "pause.resumed",
      async (payload: { scope?: string; reason?: string; actorId?: string }) => {
        await this.syncStateTransition(
          "pause_resumed",
          payload?.actorId ?? "system",
          payload?.reason ?? `Pause resumed on scope ${payload?.scope ?? "unknown"}`,
        );
      },
    );

    this.eventEmitter.on(
      "pause.expired",
      async (payload: { scope?: string }) => {
        await this.syncStateTransition(
          "pause_expired",
          "system",
          `Pause auto-expired on scope ${payload?.scope ?? "unknown"}`,
        );
      },
    );
  }

  /**
   * Returns the public-safe status view for users, status pages, and UI banners.
   * Never exposes secrets, configuration keys, internal targets, or operator IDs.
   */
  async getPublicStatus(
    options: { now?: Date } = {},
  ): Promise<PublicSystemStatusView> {
    const snapshot = await this.buildSnapshot({
      refreshDependencies: false,
      now: options.now,
    });
    return snapshot.publicStatus;
  }

  /**
   * Returns the enriched operator status view for ADMIN / MAINTAINER roles,
   * including sanitized dependency diagnostics, active pause metadata,
   * background worker policy, state transition history, and rollback steps.
   */
  async getOperatorStatus(
    options: { refreshDependencies?: boolean; now?: Date } = {},
  ): Promise<OperatorSystemStatusView> {
    const snapshot = await this.buildSnapshot({
      refreshDependencies: options.refreshDependencies ?? false,
      now: options.now,
    });
    return snapshot.operatorStatus;
  }

  /**
   * Returns the UI status banner, feature capabilities, and WebSocket event
   * contract for frontend and dashboard consumers.
   */
  async getUiBannerContract(
    options: { now?: Date } = {},
  ): Promise<UiStatusBannerContract> {
    const publicStatus = await this.getPublicStatus(options);
    return evaluateUiStatusContract(publicStatus);
  }

  /**
   * Evaluates an API request against the current public status model.
   */
  async evaluateApiRequest(
    context: ApiRequestGateContext,
    options: { now?: Date } = {},
  ): Promise<ApiRequestGateDecision> {
    const publicStatus = await this.getPublicStatus(options);
    return evaluateApiRequestGate(publicStatus, context);
  }

  /**
   * Evaluates a background worker job against the current public status model.
   */
  async evaluateBackgroundJob(
    context: BackgroundJobGateContext,
    options: { now?: Date } = {},
  ): Promise<BackgroundJobGateDecision> {
    const publicStatus = await this.getPublicStatus(options);
    return evaluateBackgroundJobGate(publicStatus, context);
  }

  /**
   * Operator action: activates a planned or emergency maintenance window.
   */
  async activateMaintenance(
    input: {
      reason: string;
      scheduledStartAt?: string;
      estimatedEndAt?: string;
      affectedScopes?: string[];
    },
    actorId = "operator",
    actorRole = "ADMIN",
    now: Date = new Date(),
  ): Promise<OperatorSystemStatusView> {
    this.maintenanceWindow = {
      active: true,
      reason: input.reason,
      scheduledStartAt: input.scheduledStartAt ?? now.toISOString(),
      estimatedEndAt: input.estimatedEndAt ?? null,
      activatedBy: actorId,
      activatedByRole: actorRole,
      activatedAt: now.toISOString(),
      affectedScopes:
        input.affectedScopes && input.affectedScopes.length > 0
          ? input.affectedScopes
          : ["all"],
    };

    await this.syncStateTransition(
      "maintenance_enabled",
      actorId,
      input.reason,
      now,
    );

    this.logger.warn(
      `Maintenance mode activated by ${actorId}: ${sanitizeStatusText(input.reason)}`,
    );

    return this.getOperatorStatus({ now });
  }

  /**
   * Operator action: clears the active maintenance window and resumes normal
   * or underlying state evaluation.
   */
  async clearMaintenance(
    reason: string,
    actorId = "operator",
    _actorRole = "ADMIN",
    now: Date = new Date(),
  ): Promise<OperatorSystemStatusView> {
    this.maintenanceWindow = null;

    await this.syncStateTransition(
      "maintenance_cleared",
      actorId,
      reason,
      now,
    );

    this.logger.log(
      `Maintenance mode cleared by ${actorId}: ${sanitizeStatusText(reason)}`,
    );

    return this.getOperatorStatus({ now });
  }

  /**
   * Operator action: declares a partial degradation on a specific component.
   */
  async declareComponentDegradation(
    input: {
      componentId: PublicComponentId;
      reason: string;
      estimatedRecoveryAt?: string;
    },
    actorId = "operator",
    now: Date = new Date(),
  ): Promise<OperatorSystemStatusView> {
    this.manualDegradations.set(input.componentId, {
      componentId: input.componentId,
      reason: input.reason,
      declaredBy: actorId,
      declaredAt: now.toISOString(),
      estimatedRecoveryAt: input.estimatedRecoveryAt ?? null,
    });

    await this.syncStateTransition(
      "degradation_declared",
      actorId,
      `${input.componentId}: ${input.reason}`,
      now,
    );

    return this.getOperatorStatus({ now });
  }

  /**
   * Operator action: clears a previously declared component degradation.
   */
  async clearComponentDegradation(
    componentId: PublicComponentId,
    reason = "Component recovered",
    actorId = "operator",
    now: Date = new Date(),
  ): Promise<OperatorSystemStatusView> {
    this.manualDegradations.delete(componentId);

    await this.syncStateTransition(
      "degradation_cleared",
      actorId,
      `${componentId}: ${reason}`,
      now,
    );

    return this.getOperatorStatus({ now });
  }

  /**
   * Returns the bounded history of state transitions.
   */
  getStateHistory(): StateTransitionEntry[] {
    return [...this.stateHistory];
  }

  /**
   * Evaluates current state, records a transition if the state changed (or if
   * an explicit operator trigger occurred), and emits `status.state_changed`.
   */
  async syncStateTransition(
    trigger: StateTransitionEntry["trigger"],
    actorId = "system",
    note = "",
    now: Date = new Date(),
  ): Promise<PublicSystemStatusView> {
    const previousState = this.lastKnownState;
    const { publicStatus } = await this.buildSnapshot({
      refreshDependencies: false,
      now,
    });
    const currentState = publicStatus.state;

    const entry: StateTransitionEntry = {
      id: `st_${now.getTime()}_${this.stateHistory.length + 1}`,
      fromState: previousState,
      toState: currentState,
      trigger,
      changedAt: now.toISOString(),
      actorId: sanitizeStatusText(actorId, { stripInternalHosts: false }),
      publicSummary: sanitizePublicReason(
        publicStatus.summary,
        currentState,
        process.env as Record<string, string | undefined>,
      ),
      operatorNote: sanitizeStatusText(note, {
        stripInternalHosts: false,
        env: process.env as Record<string, string | undefined>,
      }),
    };

    this.stateHistory.unshift(entry);
    if (this.stateHistory.length > MAX_HISTORY_ENTRIES) {
      this.stateHistory.length = MAX_HISTORY_ENTRIES;
    }

    this.lastKnownState = currentState;

    if (this.eventEmitter && typeof this.eventEmitter.emit === "function") {
      const uiContract = evaluateUiStatusContract(publicStatus);
      this.eventEmitter.emit("status.state_changed", {
        previousState,
        currentState,
        trigger,
        changedAt: entry.changedAt,
        publicStatus,
        uiContract,
      });
    }

    return publicStatus;
  }

  private async buildSnapshot(options: {
    refreshDependencies: boolean;
    now?: Date;
  }): Promise<{
    publicStatus: PublicSystemStatusView;
    operatorStatus: OperatorSystemStatusView;
  }> {
    const [activePauses, readiness, dependencyReport] = await Promise.all([
      this.loadActivePauses(),
      this.loadReadiness(),
      this.loadDependencyReport(options.refreshDependencies),
    ]);

    const snapshot = computeSystemStatusSnapshot({
      activePauses,
      maintenanceWindow: this.maintenanceWindow,
      manualDegradations: Array.from(this.manualDegradations.values()),
      readiness,
      dependencyReport,
      stateHistory: this.stateHistory,
      env: process.env as Record<string, string | undefined>,
      now: options.now,
    });

    this.lastKnownState = snapshot.publicStatus.state;
    return snapshot;
  }

  private async loadActivePauses(): Promise<ActivePauseRecordInput[]> {
    if (!this.pauseControlService) return [];
    try {
      const pauses = await this.pauseControlService.getActivePauses();
      return Array.isArray(pauses) ? pauses : [];
    } catch (err: any) {
      this.logger.warn(
        `Failed to query PauseControlService: ${sanitizeStatusText(err?.message)}`,
      );
      return [];
    }
  }

  private async loadReadiness(): Promise<ReadinessSnapshotInput | null> {
    if (!this.healthService) return null;
    try {
      return await this.healthService.getReadiness();
    } catch {
      return {
        status: "degraded",
        components: {
          database: { status: "down", message: "Readiness probe failed" },
        },
      };
    }
  }

  private async loadDependencyReport(
    refresh: boolean,
  ): Promise<DependencyReportSnapshotInput | null> {
    if (!this.dependencyHealthService) return null;
    try {
      return await this.dependencyHealthService.run({
        networkProbes: false,
        refresh,
      });
    } catch {
      return {
        status: "degraded",
        checks: [],
      };
    }
  }
}

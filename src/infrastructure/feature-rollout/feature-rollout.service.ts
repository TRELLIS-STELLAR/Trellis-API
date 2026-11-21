import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { createHash } from "crypto";
import {
  AdminConfigAuditService,
  AdminConfigActor,
} from "../audit/admin-config/admin-config-audit.service";
import { SensitiveAction } from "../audit/sensitive-actions/sensitive-action.enum";

export interface FeatureDefinition {
  key: string;
  description: string;
  enabled: boolean;
  rolloutPercentage: number; // 0 - 100
  allowlistedUsers?: string[];
  allowlistedRoles?: string[];
  maxErrorThreshold?: number;
  emergencyDisabled?: boolean;
  emergencyReason?: string;
  emergencyDisabledBy?: string;
  emergencyDisabledAt?: Date;
}

export interface FeatureEvaluationContext {
  userId?: string;
  role?: string;
  environment?: string;
}

export interface FeatureEvaluationResult {
  enabled: boolean;
  reason:
    | "emergency_disabled"
    | "globally_disabled"
    | "allowlisted_user"
    | "allowlisted_role"
    | "percentage_rollout_included"
    | "percentage_rollout_excluded"
    | "default_off";
}

@Injectable()
export class FeatureRolloutService {
  private readonly logger = new Logger(FeatureRolloutService.name);
  private readonly features = new Map<string, FeatureDefinition>();
  private readonly consecutiveErrors = new Map<string, number>();

  constructor(
    @Optional() private readonly adminConfigAudit?: AdminConfigAuditService,
  ) {}

  /**
   * Register or update a feature configuration in memory directly.
   */
  registerFeature(feature: FeatureDefinition): void {
    this.features.set(feature.key, {
      ...feature,
      rolloutPercentage: Math.min(100, Math.max(0, feature.rolloutPercentage)),
      allowlistedUsers: feature.allowlistedUsers ?? [],
      allowlistedRoles: feature.allowlistedRoles ?? [],
      emergencyDisabled: feature.emergencyDisabled ?? false,
    });
    this.consecutiveErrors.set(feature.key, 0);
  }

  /**
   * Register or update a feature with fail-closed audit evidence (#425).
   */
  async registerFeatureWithEvidence(
    feature: FeatureDefinition,
    actor: AdminConfigActor,
    reason: string,
    metadata: Record<string, unknown> = {},
  ): Promise<FeatureDefinition> {
    const key = feature.key;
    const applyChange = async () => {
      this.registerFeature(feature);
      return this.features.get(key)!;
    };

    if (!this.adminConfigAudit) {
      return applyChange();
    }

    return this.adminConfigAudit.applyWithEvidence({
      action: SensitiveAction.FEATURE_FLAG_CHANGED,
      actor,
      allowedRoles: ["ADMIN", "MAINTAINER"],
      resourceType: "feature-flag",
      resourceId: key,
      reason,
      metadata: { operation: "register", ...metadata },
      snapshot: () => this.snapshotFeature(key),
      apply: applyChange,
      revert: (before) => this.revertFeature(key, before),
    });
  }

  /**
   * Update an existing feature rollout with fail-closed audit evidence (#425).
   */
  async updateFeatureWithEvidence(
    key: string,
    patch: Partial<FeatureDefinition>,
    actor: AdminConfigActor,
    reason: string,
    metadata: Record<string, unknown> = {},
  ): Promise<FeatureDefinition> {
    const applyChange = async () => {
      const existing = this.features.get(key);
      if (!existing) {
        throw new NotFoundException(`Feature '${key}' not registered`);
      }
      const updated: FeatureDefinition = {
        ...existing,
        ...patch,
        key, // key immutable
        rolloutPercentage:
          patch.rolloutPercentage !== undefined
            ? Math.min(100, Math.max(0, patch.rolloutPercentage))
            : existing.rolloutPercentage,
        allowlistedUsers: patch.allowlistedUsers ?? existing.allowlistedUsers ?? [],
        allowlistedRoles: patch.allowlistedRoles ?? existing.allowlistedRoles ?? [],
      };
      this.features.set(key, updated);
      return updated;
    };

    if (!this.adminConfigAudit) {
      return applyChange();
    }

    return this.adminConfigAudit.applyWithEvidence({
      action: SensitiveAction.FEATURE_FLAG_CHANGED,
      actor,
      allowedRoles: ["ADMIN", "MAINTAINER"],
      resourceType: "feature-flag",
      resourceId: key,
      reason,
      metadata: { operation: "update", ...metadata },
      snapshot: () => this.snapshotFeature(key),
      apply: applyChange,
      revert: (before) => this.revertFeature(key, before),
    });
  }

  /**
   * Evaluate if a feature is enabled for a given user context.
   */
  isEnabled(key: string, context?: FeatureEvaluationContext): FeatureEvaluationResult {
    const feature = this.features.get(key);
    if (!feature) {
      throw new NotFoundException(`Feature '${key}' not registered`);
    }

    // 1. Emergency Kill-Switch Guardrail
    if (feature.emergencyDisabled) {
      return { enabled: false, reason: "emergency_disabled" };
    }

    // 2. Master Global Switch
    if (!feature.enabled) {
      return { enabled: false, reason: "globally_disabled" };
    }

    // 3. User Allowlist
    if (context?.userId && feature.allowlistedUsers?.includes(context.userId)) {
      return { enabled: true, reason: "allowlisted_user" };
    }

    // 4. Role Allowlist
    if (context?.role && feature.allowlistedRoles?.includes(context.role)) {
      return { enabled: true, reason: "allowlisted_role" };
    }

    // 5. Percentage Rollout with Deterministic Hash
    if (context?.userId && feature.rolloutPercentage !== undefined) {
      if (feature.rolloutPercentage === 100) {
        return { enabled: true, reason: "percentage_rollout_included" };
      }
      if (feature.rolloutPercentage === 0) {
        return { enabled: false, reason: "percentage_rollout_excluded" };
      }
      const hash = this.computeRolloutHash(feature.key, context.userId);
      if (hash < feature.rolloutPercentage) {
        return { enabled: true, reason: "percentage_rollout_included" };
      }
      return { enabled: false, reason: "percentage_rollout_excluded" };
    }

    if (feature.rolloutPercentage === 100) {
      return { enabled: true, reason: "percentage_rollout_included" };
    }

    return { enabled: false, reason: "default_off" };
  }

  /**
   * Emergency Disablement: Immediate kill switch for a feature flag.
   */
  emergencyDisable(key: string, reason: string, actor: string): void {
    const feature = this.features.get(key);
    if (!feature) {
      throw new NotFoundException(`Feature '${key}' not registered`);
    }

    feature.emergencyDisabled = true;
    feature.enabled = false;
    feature.emergencyReason = reason;
    feature.emergencyDisabledBy = actor;
    feature.emergencyDisabledAt = new Date();

    this.logger.error(
      `EMERGENCY DISABLEMENT: Feature '${key}' disabled by ${actor}. Reason: ${reason}`,
    );
  }

  /**
   * Emergency Disablement with fail-closed audit evidence (#425).
   */
  async emergencyDisableWithEvidence(
    key: string,
    reason: string,
    actor: AdminConfigActor,
    metadata: Record<string, unknown> = {},
  ): Promise<FeatureDefinition> {
    const applyChange = async () => {
      const feature = this.features.get(key);
      if (!feature) {
        throw new NotFoundException(`Feature '${key}' not registered`);
      }
      this.emergencyDisable(key, reason, actor.id);
      return this.features.get(key)!;
    };

    if (!this.adminConfigAudit) {
      return applyChange();
    }

    return this.adminConfigAudit.applyWithEvidence({
      action: SensitiveAction.FEATURE_FLAG_CHANGED,
      actor,
      allowedRoles: ["ADMIN", "MAINTAINER"],
      resourceType: "feature-flag",
      resourceId: key,
      reason,
      metadata: { operation: "emergency_disable", ...metadata },
      snapshot: () => this.snapshotFeature(key),
      apply: applyChange,
      revert: (before) => this.revertFeature(key, before),
    });
  }

  /**
   * Lift emergency disablement and place into controlled canary rollout (e.g. 5%).
   */
  liftEmergencyDisable(
    key: string,
    actor: string,
    canaryPercentage = 5,
  ): void {
    const feature = this.features.get(key);
    if (!feature) {
      throw new NotFoundException(`Feature '${key}' not registered`);
    }

    feature.emergencyDisabled = false;
    feature.enabled = true;
    feature.rolloutPercentage = Math.min(100, Math.max(0, canaryPercentage));
    feature.emergencyReason = undefined;
    this.consecutiveErrors.set(key, 0);

    this.logger.warn(
      `Emergency disablement lifted for '${key}' by ${actor}. Resumed with canary rollout at ${canaryPercentage}%.`,
    );
  }

  /**
   * Lift emergency disablement with fail-closed audit evidence (#425).
   */
  async liftEmergencyDisableWithEvidence(
    key: string,
    actor: AdminConfigActor,
    canaryPercentage = 5,
    reason = "Lift emergency disable",
    metadata: Record<string, unknown> = {},
  ): Promise<FeatureDefinition> {
    const applyChange = async () => {
      const feature = this.features.get(key);
      if (!feature) {
        throw new NotFoundException(`Feature '${key}' not registered`);
      }
      this.liftEmergencyDisable(key, actor.id, canaryPercentage);
      return this.features.get(key)!;
    };

    if (!this.adminConfigAudit) {
      return applyChange();
    }

    return this.adminConfigAudit.applyWithEvidence({
      action: SensitiveAction.FEATURE_FLAG_CHANGED,
      actor,
      allowedRoles: ["ADMIN", "MAINTAINER"],
      resourceType: "feature-flag",
      resourceId: key,
      reason,
      metadata: { operation: "lift_emergency_disable", canaryPercentage, ...metadata },
      snapshot: () => this.snapshotFeature(key),
      apply: applyChange,
      revert: (before) => this.revertFeature(key, before),
    });
  }

  /**
   * Automated Error Rate Guardrail:
   * Record an error occurring in a rolled-out feature.
   * If threshold is exceeded, triggers automated emergency disablement.
   */
  recordError(key: string, error?: Error): void {
    const feature = this.features.get(key);
    if (!feature || feature.emergencyDisabled) return;

    const count = (this.consecutiveErrors.get(key) ?? 0) + 1;
    this.consecutiveErrors.set(key, count);

    const threshold = feature.maxErrorThreshold ?? 5;
    if (count >= threshold) {
      this.emergencyDisable(
        key,
        `Automated circuit break: Exceeded max consecutive error threshold (${count}/${threshold}). Last error: ${error?.message ?? "unknown"}`,
        "SYSTEM_GUARDRAIL",
      );
    }
  }

  /**
   * Record successful execution of a feature to reset consecutive error counter.
   */
  recordSuccess(key: string): void {
    this.consecutiveErrors.set(key, 0);
  }

  private snapshotFeature(key: string): FeatureDefinition | null {
    const item = this.features.get(key);
    if (!item) return null;
    return {
      ...item,
      allowlistedUsers: item.allowlistedUsers ? [...item.allowlistedUsers] : [],
      allowlistedRoles: item.allowlistedRoles ? [...item.allowlistedRoles] : [],
      emergencyDisabledAt: item.emergencyDisabledAt
        ? new Date(item.emergencyDisabledAt.getTime())
        : undefined,
    };
  }

  private revertFeature(key: string, before: FeatureDefinition | null): void {
    if (before === null) {
      this.features.delete(key);
    } else {
      this.features.set(key, { ...before });
    }
  }

  /**
   * Deterministic 0-99 hash of (featureKey + userId).
   */
  private computeRolloutHash(featureKey: string, userId: string): number {
    const hashHex = createHash("sha256")
      .update(`${featureKey}:${userId}`)
      .digest("hex");
    const intVal = parseInt(hashHex.substring(0, 8), 16);
    return intVal % 100;
  }

  getFeature(key: string): FeatureDefinition | undefined {
    return this.features.get(key);
  }

  getAllFeatures(): FeatureDefinition[] {
    return Array.from(this.features.values());
  }
}

import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { SensitiveActionAuditService } from "../sensitive-actions/sensitive-action-audit.service";
import { SensitiveAction } from "../sensitive-actions/sensitive-action.enum";
import {
  AuditActorType,
  SensitiveActionStatus,
} from "../entities/sensitive-action-event.entity";

/** Optional provider token for {@link AdminConfigAuditOptions}. */
export const ADMIN_CONFIG_AUDIT_OPTIONS = "ADMIN_CONFIG_AUDIT_OPTIONS";

/** Roles allowed to change administrative configuration. */
export const ADMIN_CONFIG_ROLES = ["ADMIN", "MAINTAINER"] as const;

export interface AdminConfigActor {
  id: string;
  role?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AdminConfigChange<TState, TResult> {
  /** Catalogued sensitive action describing the change. */
  action: SensitiveAction;
  actor: AdminConfigActor;
  /** Roles that may perform this change. Defaults to {@link ADMIN_CONFIG_ROLES}. */
  allowedRoles?: readonly string[];
  resourceType: string;
  resourceId: string;
  reason: string;
  /** Snapshot of the configuration before the change. Must be serializable. */
  snapshot: () => TState | Promise<TState>;
  /** Performs the change. */
  apply: () => Promise<TResult>;
  /**
   * Restores `before`. Called only when the change was applied but its
   * evidence could not be recorded, so an unaudited change never persists.
   */
  revert: (before: TState) => Promise<void> | void;
  /** Extra non-secret context (operation name, request id, ...). */
  metadata?: Record<string, unknown>;
}

export interface AdminConfigAuditOptions {
  /** Attempts to write the evidence before giving up and reverting. */
  maxAttempts?: number;
  /** Base backoff between attempts; doubles each time. */
  baseDelayMs?: number;
}

/**
 * Audit evidence for administrative configuration changes (#280).
 *
 * Wraps a configuration change so that it either takes effect *with* a
 * tamper-evident evidence record, or does not take effect at all:
 *
 * 1. **Authorization (defence in depth).** The actor must carry an allowed
 *    role, even if the route guards were bypassed (a background job, a new
 *    caller). A refused attempt is itself recorded as a `failed` event.
 * 2. **Before/after evidence.** The prior configuration is snapshotted, the
 *    change applied, and a hash-chained `SensitiveActionEvent` is appended with
 *    actor, role, IP, reason and both states (sanitized by the audit service).
 * 3. **Retry.** Writing the evidence is retried with backoff: concurrent
 *    writers can race on the chain head and a database blip is transient.
 * 4. **Fail closed.** If the evidence still cannot be written, the change is
 *    reverted to the snapshot and the caller gets a 503 — an administrative
 *    change without evidence is treated as a failed change.
 * 5. **Failed changes are evidence too.** When `apply` throws, a `failed`
 *    event is recorded (best effort) and the original error is rethrown.
 *
 * Request-level retries (the client resending the same request) are handled
 * by the global `Idempotency-Key` interceptor on the admin routes, so a retried
 * request neither applies the change twice nor records duplicate evidence.
 */
@Injectable()
export class AdminConfigAuditService {
  private readonly logger = new Logger(AdminConfigAuditService.name);
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(
    private readonly audit: SensitiveActionAuditService,
    @Optional()
    @Inject(ADMIN_CONFIG_AUDIT_OPTIONS)
    options: AdminConfigAuditOptions | null = null,
  ) {
    options = options ?? {};
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? 50);
  }

  async applyWithEvidence<TState, TResult>(
    change: AdminConfigChange<TState, TResult>,
  ): Promise<TResult> {
    const allowed = change.allowedRoles ?? ADMIN_CONFIG_ROLES;
    const role = change.actor.role?.toUpperCase() ?? null;

    if (!change.actor.id || !role || !allowed.includes(role)) {
      await this.recordBestEffort(change, {
        status: SensitiveActionStatus.FAILED,
        before: null,
        after: null,
        outcome: "unauthorized",
      });
      throw new ForbiddenException(
        "Insufficient role to change administrative configuration",
      );
    }

    const before = await change.snapshot();

    let result: TResult;
    try {
      result = await change.apply();
    } catch (error) {
      await this.recordBestEffort(change, {
        status: SensitiveActionStatus.FAILED,
        before,
        after: null,
        outcome: "apply_failed",
        error: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }

    const after = await change.snapshot();

    try {
      await this.recordWithRetry(change, {
        status: SensitiveActionStatus.SUCCEEDED,
        before,
        after,
        outcome: "applied",
      });
    } catch (error) {
      this.logger.error(
        `audit evidence for ${change.action} on ${change.resourceType}/${change.resourceId} ` +
          `could not be recorded; reverting: ${(error as Error)?.message ?? error}`,
      );
      try {
        await change.revert(before);
      } catch (revertError) {
        // Both the evidence and the rollback failed: the change is live and
        // unaudited. Surface loudly; operators must reconcile by hand.
        this.logger.error(
          `CRITICAL: revert of unaudited ${change.action} on ${change.resourceType}/` +
            `${change.resourceId} failed: ${(revertError as Error)?.message ?? revertError}`,
        );
        throw new ServiceUnavailableException(
          "Configuration change could not be audited or rolled back; manual reconciliation required",
        );
      }
      throw new ServiceUnavailableException(
        "Configuration change was rolled back because its audit evidence could not be recorded",
      );
    }

    return result;
  }

  private async recordWithRetry<TState, TResult>(
    change: AdminConfigChange<TState, TResult>,
    evidence: EvidenceFields,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.record(change, evidence, attempt);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxAttempts && this.baseDelayMs > 0) {
          await this.delay(this.baseDelayMs * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError;
  }

  private async recordBestEffort<TState, TResult>(
    change: AdminConfigChange<TState, TResult>,
    evidence: EvidenceFields,
  ): Promise<void> {
    try {
      await this.record(change, evidence, 1);
    } catch (error) {
      this.logger.error(
        `could not record ${evidence.outcome} evidence for ${change.action}: ` +
          `${(error as Error)?.message ?? error}`,
      );
    }
  }

  private record<TState, TResult>(
    change: AdminConfigChange<TState, TResult>,
    evidence: EvidenceFields,
    attempt: number,
  ) {
    return this.audit.recordSensitiveAction({
      action: change.action,
      actorId: change.actor.id || "unknown",
      actorType: AuditActorType.MAINTAINER,
      actorRole: change.actor.role ?? undefined,
      resourceType: change.resourceType,
      resourceId: change.resourceId,
      reason: change.reason,
      beforeState: toState(evidence.before),
      afterState: toState(evidence.after),
      metadata: {
        ...change.metadata,
        outcome: evidence.outcome,
        ...(evidence.error ? { error: evidence.error } : {}),
        ...(attempt > 1 ? { recordAttempt: attempt } : {}),
      },
      status: evidence.status,
      ipAddress: change.actor.ipAddress ?? undefined,
      userAgent: change.actor.userAgent ?? undefined,
    });
  }

  /** Backoff seam for tests. */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

interface EvidenceFields {
  status: SensitiveActionStatus;
  before: unknown;
  after: unknown;
  outcome: "applied" | "apply_failed" | "unauthorized";
  error?: string;
}

function toState(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }
  return { value: JSON.parse(JSON.stringify(value)) };
}

import { Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PauseScope } from "./entities/pause-scope.entity";
import { PauseAuditLog } from "./entities/pause-audit-log.entity";
import { PausableScope } from "./dto/activate-pause.dto";
import { AdminConfigAuditService } from "../audit/admin-config/admin-config-audit.service";
import { SensitiveAction } from "../audit/sensitive-actions/sensitive-action.enum";

export interface ActivatePauseOpts {
  scope: PausableScope;
  reason: string;
  actorId: string;
  actorRole: string;
  environment?: string;
  expiresAt?: Date;
  /** Request context recorded with the audit evidence (#280). */
  ipAddress?: string;
  userAgent?: string;
}

/** Serializable view of a pause row used as before/after audit evidence. */
interface PauseSnapshot {
  pause: {
    id: string;
    scope: string;
    active: boolean;
    reason: string;
    activatedBy: string;
    activatedByRole: string | null;
    environment: string | null;
    expiresAt: string | null;
    resumedBy: string | null;
    resumedByRole: string | null;
    resumeReason: string | null;
    resumedAt: string | null;
  } | null;
}

const ROLLBACK_REASON = "Rolled back: audit evidence could not be recorded";

@Injectable()
export class PauseControlService {
  private readonly logger = new Logger(PauseControlService.name);

  constructor(
    @InjectRepository(PauseScope)
    private readonly pauseRepo: Repository<PauseScope>,
    @InjectRepository(PauseAuditLog)
    private readonly auditRepo: Repository<PauseAuditLog>,
    private readonly eventEmitter: EventEmitter2,
    @Optional() private readonly adminConfigAudit?: AdminConfigAuditService,
  ) {}

  /**
   * Activates (or updates) a pause. With the admin audit service wired in, the
   * change is recorded as tamper-evident `config.emergency-pause.toggled`
   * evidence and rolled back if that evidence cannot be written (#280).
   */
  async activatePause(opts: ActivatePauseOpts): Promise<PauseScope> {
    if (!this.adminConfigAudit) return this.applyActivatePause(opts);

    return this.adminConfigAudit.applyWithEvidence({
      action: SensitiveAction.EMERGENCY_PAUSE_TOGGLED,
      actor: {
        id: opts.actorId,
        role: opts.actorRole,
        ipAddress: opts.ipAddress ?? null,
        userAgent: opts.userAgent ?? null,
      },
      allowedRoles: ["ADMIN"],
      resourceType: "pause-scope",
      resourceId: opts.scope,
      reason: opts.reason,
      metadata: {
        operation: "activate",
        environment: opts.environment ?? null,
      },
      snapshot: () => this.snapshotActive(opts.scope),
      apply: () => this.applyActivatePause(opts),
      revert: (before) => this.revertActivation(opts.scope, before),
    });
  }

  /**
   * Resumes a paused scope. Returns `null` (and records nothing) when there is
   * no active pause, since no configuration changed.
   */
  async resumePause(
    scope: PausableScope,
    reason: string,
    actorId: string,
    actorRole: string,
    context: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<PauseScope | null> {
    if (!this.adminConfigAudit) {
      return this.applyResumePause(scope, reason, actorId, actorRole);
    }

    const active = await this.pauseRepo.findOne({
      where: { scope, active: true },
    });
    if (!active) return null;

    return this.adminConfigAudit.applyWithEvidence({
      action: SensitiveAction.EMERGENCY_PAUSE_TOGGLED,
      actor: {
        id: actorId,
        role: actorRole,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      },
      allowedRoles: ["ADMIN"],
      resourceType: "pause-scope",
      resourceId: scope,
      reason,
      metadata: { operation: "resume" },
      snapshot: () => this.snapshotActive(scope, active.id),
      apply: () => this.applyResumePause(scope, reason, actorId, actorRole),
      revert: (before) => this.revertResume(scope, before),
    });
  }

  private async applyActivatePause(
    opts: ActivatePauseOpts,
  ): Promise<PauseScope> {
    // Check if already paused - update if so
    const existing = await this.pauseRepo.findOne({
      where: { scope: opts.scope, active: true },
    });

    if (existing) {
      existing.reason = opts.reason;
      existing.activatedBy = opts.actorId;
      existing.activatedByRole = opts.actorRole;
      existing.expiresAt = opts.expiresAt ?? null;
      existing.environment = opts.environment ?? null;
      const updated = await this.pauseRepo.save(existing);

      await this.createAuditEntry(
        updated.id,
        "activate",
        opts.actorId,
        opts.actorRole,
        opts.reason,
        { updated: true },
      );

      this.eventEmitter.emit("pause.activated", {
        scope: opts.scope,
        reason: opts.reason,
        actorId: opts.actorId,
      });

      this.logger.warn(`Pause scope '${opts.scope}' updated by ${opts.actorId}`);
      return updated;
    }

    const pause = this.pauseRepo.create({
      scope: opts.scope,
      reason: opts.reason,
      activatedBy: opts.actorId,
      activatedByRole: opts.actorRole,
      environment: opts.environment ?? null,
      expiresAt: opts.expiresAt ?? null,
      active: true,
    });
    const saved = await this.pauseRepo.save(pause);

    await this.createAuditEntry(
      saved.id,
      "activate",
      opts.actorId,
      opts.actorRole,
      opts.reason,
    );

    this.eventEmitter.emit("pause.activated", {
      scope: opts.scope,
      reason: opts.reason,
      actorId: opts.actorId,
    });

    this.logger.warn(
      `Pause activated: scope=${opts.scope} by=${opts.actorId} reason="${opts.reason}"`,
    );
    return saved;
  }

  private async applyResumePause(
    scope: PausableScope,
    reason: string,
    actorId: string,
    actorRole: string,
  ): Promise<PauseScope | null> {
    const pause = await this.pauseRepo.findOne({
      where: { scope, active: true },
    });
    if (!pause) return null;

    pause.active = false;
    pause.resumedBy = actorId;
    pause.resumedByRole = actorRole;
    pause.resumeReason = reason;
    pause.resumedAt = new Date();
    const saved = await this.pauseRepo.save(pause);

    await this.createAuditEntry(
      saved.id,
      "resume",
      actorId,
      actorRole,
      reason,
    );

    this.eventEmitter.emit("pause.resumed", {
      scope,
      reason,
      actorId,
    });

    this.logger.log(
      `Pause resumed: scope=${scope} by=${actorId} reason="${reason}"`,
    );
    return saved;
  }

  async isOperationPaused(scope: string): Promise<{
    paused: boolean;
    reason?: string;
    expiresAt?: Date;
  }> {
    // Check for exact scope or 'all' scope
    const pauses = await this.pauseRepo.find({
      where: [
        { scope, active: true },
        { scope: PausableScope.ALL, active: true },
      ],
    });

    for (const pause of pauses) {
      // Handle auto-expiry
      if (pause.expiresAt && pause.expiresAt <= new Date()) {
        pause.active = false;
        pause.resumeReason = "Auto-expired";
        pause.resumedAt = new Date();
        await this.pauseRepo.save(pause);
        await this.createAuditEntry(
          pause.id,
          "expire",
          "system",
          "system",
          "Auto-expired",
        );
        this.eventEmitter.emit("pause.expired", { scope: pause.scope });
        continue;
      }

      return {
        paused: true,
        reason: pause.reason,
        expiresAt: pause.expiresAt ?? undefined,
      };
    }

    return { paused: false };
  }

  async getActivePauses(): Promise<PauseScope[]> {
    const pauses = await this.pauseRepo.find({ where: { active: true } });

    // Filter out expired ones
    const active: PauseScope[] = [];
    for (const pause of pauses) {
      if (pause.expiresAt && pause.expiresAt <= new Date()) {
        pause.active = false;
        pause.resumeReason = "Auto-expired";
        pause.resumedAt = new Date();
        await this.pauseRepo.save(pause);
        await this.createAuditEntry(
          pause.id,
          "expire",
          "system",
          "system",
          "Auto-expired",
        );
      } else {
        active.push(pause);
      }
    }
    return active;
  }

  async getPauseHistory(
    scope?: string,
    limit = 50,
  ): Promise<PauseScope[]> {
    const qb = this.pauseRepo
      .createQueryBuilder("p")
      .orderBy("p.activatedAt", "DESC")
      .take(limit);

    if (scope) {
      qb.where("p.scope = :scope", { scope });
    }

    return qb.getMany();
  }

  async getAuditLog(
    pauseScopeId?: string,
    limit = 100,
  ): Promise<PauseAuditLog[]> {
    const qb = this.auditRepo
      .createQueryBuilder("a")
      .orderBy("a.createdAt", "DESC")
      .take(limit);

    if (pauseScopeId) {
      qb.where("a.pauseScopeId = :pauseScopeId", { pauseScopeId });
    }

    return qb.getMany();
  }

  /**
   * Snapshot of the pause for `scope`: the active row, or — when `id` is given
   * — that specific row whatever its state (used to capture a resume's after).
   */
  private async snapshotActive(
    scope: string,
    id?: string,
  ): Promise<PauseSnapshot> {
    const row = id
      ? await this.pauseRepo.findOne({ where: { id } as any })
      : await this.pauseRepo.findOne({ where: { scope, active: true } });
    if (!row) return { pause: null };
    const iso = (value: Date | string | null | undefined) =>
      value ? new Date(value).toISOString() : null;
    return {
      pause: {
        id: row.id,
        scope: row.scope,
        active: row.active,
        reason: row.reason,
        activatedBy: row.activatedBy,
        activatedByRole: row.activatedByRole ?? null,
        environment: row.environment ?? null,
        expiresAt: iso(row.expiresAt),
        resumedBy: row.resumedBy ?? null,
        resumedByRole: row.resumedByRole ?? null,
        resumeReason: row.resumeReason ?? null,
        resumedAt: iso(row.resumedAt),
      },
    };
  }

  /** Undoes an activation whose audit evidence could not be recorded. */
  private async revertActivation(
    scope: string,
    before: PauseSnapshot,
  ): Promise<void> {
    const current = await this.pauseRepo.findOne({
      where: { scope, active: true },
    });
    if (!current) return;

    if (before.pause) {
      // It was an update of an existing pause: put the previous settings back.
      Object.assign(current, {
        reason: before.pause.reason,
        activatedBy: before.pause.activatedBy,
        activatedByRole: before.pause.activatedByRole,
        environment: before.pause.environment,
        expiresAt: before.pause.expiresAt
          ? new Date(before.pause.expiresAt)
          : null,
      });
      await this.pauseRepo.save(current);
      await this.createAuditEntry(
        current.id,
        "rollback",
        "system",
        "system",
        ROLLBACK_REASON,
      );
      this.eventEmitter.emit("pause.activated", {
        scope,
        reason: before.pause.reason,
        actorId: "system",
      });
      return;
    }

    // It was a new pause: lift it again.
    current.active = false;
    current.resumedBy = "system";
    current.resumedByRole = "system";
    current.resumeReason = ROLLBACK_REASON;
    current.resumedAt = new Date();
    await this.pauseRepo.save(current);
    await this.createAuditEntry(
      current.id,
      "rollback",
      "system",
      "system",
      ROLLBACK_REASON,
    );
    this.eventEmitter.emit("pause.resumed", {
      scope,
      reason: ROLLBACK_REASON,
      actorId: "system",
    });
  }

  /** Undoes a resume whose audit evidence could not be recorded. */
  private async revertResume(
    scope: string,
    before: PauseSnapshot,
  ): Promise<void> {
    if (!before.pause) return;
    const row = await this.pauseRepo.findOne({
      where: { id: before.pause.id } as any,
    });
    if (!row) return;
    Object.assign(row, {
      active: true,
      resumedBy: null,
      resumedByRole: null,
      resumeReason: null,
      resumedAt: null,
    });
    await this.pauseRepo.save(row);
    await this.createAuditEntry(
      row.id,
      "rollback",
      "system",
      "system",
      ROLLBACK_REASON,
    );
    this.eventEmitter.emit("pause.activated", {
      scope,
      reason: before.pause.reason,
      actorId: "system",
    });
  }

  private async createAuditEntry(
    pauseScopeId: string,
    action: string,
    actorId: string,
    actorRole: string,
    reason: string,
    metadata?: Record<string, any>,
  ): Promise<PauseAuditLog> {
    const entry = this.auditRepo.create({
      pauseScopeId,
      action,
      actorId,
      actorRole,
      reason,
      metadata: metadata ?? null,
    });
    return this.auditRepo.save(entry);
  }
}

import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { Role, normalizeRole } from "../../common/guard/roles.enum";

export enum BounceReason {
  HARD_BOUNCE = "hard_bounce",
  SOFT_BOUNCE = "soft_bounce",
  SPAM_COMPLAINT = "spam_complaint",
  MANUAL_SUPPRESSION = "manual_suppression",
  UNSUBSCRIBE = "unsubscribe",
}

export interface SuppressionRecord {
  email: string;
  reason: BounceReason;
  source: string;
  createdAt: Date;
  expiresAt: Date | null;
  bounceCount: number;
  lastBounceDetail?: string;
  suppressed: boolean;
  unsuppressedAt?: Date | null;
  unsuppressedBy?: string | null;
}

export interface SuppressionCheckResult {
  suppressed: boolean;
  reason?: BounceReason;
  record?: SuppressionRecord;
  detail?: string;
}

export interface ActorContext {
  id: string;
  roles: string[];
}

export interface BounceSuppressionOptions {
  softBounceThreshold?: number;
  softBounceTtlMs?: number;
}

const DEFAULT_SOFT_BOUNCE_THRESHOLD = 3;
const DEFAULT_SOFT_BOUNCE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

@Injectable()
export class BounceSuppressionService {
  private readonly logger = new Logger(BounceSuppressionService.name);
  private readonly suppressions = new Map<string, SuppressionRecord>();
  private readonly softBounceThreshold: number;
  private readonly softBounceTtlMs: number;

  constructor(options?: BounceSuppressionOptions) {
    this.softBounceThreshold =
      options?.softBounceThreshold ?? DEFAULT_SOFT_BOUNCE_THRESHOLD;
    this.softBounceTtlMs =
      options?.softBounceTtlMs ?? DEFAULT_SOFT_BOUNCE_TTL_MS;
  }

  private normalizeEmail(email: string): string {
    if (!email || typeof email !== "string" || !email.includes("@")) {
      throw new BadRequestException(`Invalid email address: "${email}"`);
    }
    return email.trim().toLowerCase();
  }

  /**
   * Checks whether an email address is currently suppressed.
   * Automatically expires time-bounded soft bounce suppressions.
   */
  async isSuppressed(email: string): Promise<SuppressionCheckResult> {
    const norm = this.normalizeEmail(email);
    const record = this.suppressions.get(norm);

    if (!record || !record.suppressed) {
      return { suppressed: false };
    }

    // Check expiration for temporary suppressions (e.g. soft bounce threshold)
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
      record.suppressed = false;
      record.bounceCount = 0;
      this.logger.log(
        `Temporary suppression for "${norm}" expired and was lifted automatically`,
      );
      return { suppressed: false };
    }

    return {
      suppressed: true,
      reason: record.reason,
      record,
      detail: record.lastBounceDetail,
    };
  }

  /**
   * Records a bounce event from email delivery providers.
   * Hard bounces and spam complaints trigger immediate permanent suppression.
   * Soft bounces increment the failure counter; reaching threshold suppresses temporarily.
   */
  async recordBounce(
    email: string,
    reason: BounceReason,
    detail = "Delivery failed",
    source = "system",
  ): Promise<SuppressionRecord> {
    const norm = this.normalizeEmail(email);
    const existing = this.suppressions.get(norm);

    let bounceCount = (existing?.bounceCount ?? 0) + 1;
    let isSuppressed = false;
    let expiresAt: Date | null = null;

    if (
      reason === BounceReason.HARD_BOUNCE ||
      reason === BounceReason.SPAM_COMPLAINT ||
      reason === BounceReason.MANUAL_SUPPRESSION ||
      reason === BounceReason.UNSUBSCRIBE
    ) {
      isSuppressed = true;
      expiresAt = null; // Permanent
    } else if (reason === BounceReason.SOFT_BOUNCE) {
      if (bounceCount >= this.softBounceThreshold) {
        isSuppressed = true;
        expiresAt = new Date(Date.now() + this.softBounceTtlMs);
      }
    }

    const record: SuppressionRecord = {
      email: norm,
      reason,
      source,
      createdAt: existing?.createdAt ?? new Date(),
      expiresAt,
      bounceCount,
      lastBounceDetail: detail,
      suppressed: isSuppressed,
    };

    this.suppressions.set(norm, record);

    if (isSuppressed) {
      this.logger.warn(
        `Email "${norm}" suppressed (reason: ${reason}, bounceCount: ${bounceCount}, source: ${source})`,
      );
    }

    return record;
  }

  /**
   * Records a successful delivery, resetting the soft bounce failure counter.
   */
  async recordDeliverySuccess(email: string): Promise<void> {
    const norm = this.normalizeEmail(email);
    const record = this.suppressions.get(norm);
    if (record && !record.suppressed && record.bounceCount > 0) {
      record.bounceCount = 0;
      this.logger.debug(
        `Delivery succeeded for "${norm}"; soft bounce counter reset to 0`,
      );
    }
  }

  /**
   * Manually adds an email to the suppression list.
   * Requires ADMIN or SUPPORT role.
   */
  async manualSuppress(
    email: string,
    reason: BounceReason,
    actor: ActorContext,
    options?: { detail?: string; expiresAt?: Date | null },
  ): Promise<SuppressionRecord> {
    this.assertAuthorizedActor(actor);
    const norm = this.normalizeEmail(email);

    const record: SuppressionRecord = {
      email: norm,
      reason,
      source: `manual:${actor.id}`,
      createdAt: new Date(),
      expiresAt: options?.expiresAt ?? null,
      bounceCount: 1,
      lastBounceDetail: options?.detail || "Manually suppressed by operator",
      suppressed: true,
    };

    this.suppressions.set(norm, record);
    this.logger.log(`Manual suppression applied to "${norm}" by actor ${actor.id}`);
    return record;
  }

  /**
   * Removes an email from the bounce suppression list (recovery/rollback path).
   * Requires ADMIN or SUPPORT role.
   */
  async removeSuppression(
    email: string,
    actor: ActorContext,
    reason = "Operator manual unsuppression",
  ): Promise<boolean> {
    this.assertAuthorizedActor(actor);
    const norm = this.normalizeEmail(email);
    const record = this.suppressions.get(norm);

    if (!record || !record.suppressed) {
      return false;
    }

    record.suppressed = false;
    record.bounceCount = 0;
    record.unsuppressedAt = new Date();
    record.unsuppressedBy = actor.id;
    record.lastBounceDetail = `Unsuppressed by ${actor.id}: ${reason}`;

    this.logger.log(
      `Suppression lifted for "${norm}" by actor ${actor.id}. Reason: ${reason}`,
    );
    return true;
  }

  /**
   * Lists all suppressions, optionally filtered.
   */
  async listSuppressions(filter?: {
    reason?: BounceReason;
    activeOnly?: boolean;
  }): Promise<SuppressionRecord[]> {
    const now = Date.now();
    return Array.from(this.suppressions.values()).filter((rec) => {
      if (filter?.reason && rec.reason !== filter.reason) {
        return false;
      }
      if (filter?.activeOnly) {
        if (!rec.suppressed) return false;
        if (rec.expiresAt && rec.expiresAt.getTime() <= now) return false;
      }
      return true;
    });
  }

  /**
   * Purges expired suppressions from memory.
   */
  async clearExpiredSuppressions(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;
    for (const [email, record] of this.suppressions.entries()) {
      if (record.expiresAt && record.expiresAt.getTime() <= now) {
        if (record.suppressed) {
          record.suppressed = false;
          record.bounceCount = 0;
          cleaned++;
        }
      }
    }
    return cleaned;
  }

  private assertAuthorizedActor(actor: ActorContext): void {
    if (!actor || !actor.roles || !Array.isArray(actor.roles)) {
      throw new ForbiddenException(
        "Missing actor context or roles for suppression management",
      );
    }
    const roles = actor.roles.map((r) => normalizeRole(r));
    const isAuthorized =
      roles.includes(Role.ADMIN) || roles.some((r) => r.toUpperCase() === "SUPPORT");
    if (!isAuthorized) {
      throw new ForbiddenException(
        "Only ADMIN or SUPPORT roles can manage bounce suppressions",
      );
    }
  }
}

import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
  Logger,
  Optional,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as crypto from "crypto";
import { User } from "../user/entities/user.entity";
import { Role } from "../../common/guard/roles.enum";
import { AuditLogService } from "../../infrastructure/audit/audit-log.service";
import { AuditLogAction } from "../../infrastructure/audit/entities/audit-log.entity";
import { SensitiveActionAuditService } from "../../infrastructure/audit/sensitive-actions/sensitive-action-audit.service";
import { SensitiveAction } from "../../infrastructure/audit/sensitive-actions/sensitive-action.enum";
import { AuditActorType } from "../../infrastructure/audit/entities/sensitive-action-event.entity";
import { TokenBlacklistService } from "./token-blacklist.service";
import { NotificationService } from "../../notifications/services/notification.service";
import {
  NotificationCategory,
  NotificationPriority,
} from "../../notifications/entities/notification.entity";
import {
  SupportAccessScope,
  ActiveSupportSession,
  SupportSessionNotice,
  DEFAULT_IMPERSONATION_DURATION_MINUTES,
  MIN_IMPERSONATION_DURATION_MINUTES,
  MAX_IMPERSONATION_DURATION_MINUTES,
} from "./impersonation.types";

export interface StartImpersonationOptions {
  reason?: string;
  ticketId?: string;
  durationMinutes?: number;
  scopes?: SupportAccessScope[];
}

export interface StopImpersonationOptions {
  reason?: string;
  jti?: string;
}

@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);

  // In-memory active support session store for immediate status & notices
  private readonly activeSessions = new Map<string, ActiveSupportSession>();
  private readonly tokenJtiToTargetUser = new Map<string, string>();

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
    private readonly sensitiveAuditService: SensitiveActionAuditService,
    @Optional()
    private readonly tokenBlacklistService?: TokenBlacklistService,
    @Optional()
    private readonly notificationService?: NotificationService,
  ) {}

  /**
   * Start a time-bounded, scoped support impersonation session.
   * Enforces admin-only authorization, non-admin target restriction, mandatory immutable audit
   * trail recording, scoped token generation, and transparent user notification notices.
   */
  async startImpersonation(
    adminId: string,
    targetUserId: string,
    ipAddress: string,
    userAgent?: string,
    options?: StartImpersonationOptions,
  ) {
    const adminUser = await this.userRepository.findOne({
      where: { id: adminId },
    });
    if (!adminUser) {
      throw new UnauthorizedException("Admin user not found");
    }

    if (adminUser.role !== Role.ADMIN) {
      throw new ForbiddenException("Only admins can impersonate users");
    }

    const targetUser = await this.userRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException("Target user not found");
    }

    if (targetUser.role === Role.ADMIN) {
      throw new ForbiddenException("Cannot impersonate another admin");
    }

    // Bounded duration in minutes (enforced between 5m and 240m)
    const rawDuration =
      options?.durationMinutes ?? DEFAULT_IMPERSONATION_DURATION_MINUTES;
    const durationMinutes = Math.max(
      MIN_IMPERSONATION_DURATION_MINUTES,
      Math.min(rawDuration, MAX_IMPERSONATION_DURATION_MINUTES),
    );

    // Granted scopes (defaults to read-only access)
    const scopes =
      options?.scopes && options.scopes.length > 0
        ? options.scopes
        : [SupportAccessScope.READ_ONLY];

    const ticketId = options?.ticketId?.trim() || undefined;
    const reason =
      options?.reason?.trim() ||
      `Support maintenance access requested for user ${targetUser.id}`;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMinutes * 60 * 1000);
    const jti = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    // 1. IMMUTABLE AUDIT TRAIL RECORDING (Cannot be bypassed)
    // If immutable audit logging fails, execution aborts and NO token is issued (fail-closed).
    await this.sensitiveAuditService.recordSensitiveAction({
      action: SensitiveAction.IMPERSONATION_STARTED,
      actorId: adminId,
      actorType: AuditActorType.MAINTAINER,
      actorRole: adminUser.role,
      resourceType: "User",
      resourceId: targetUserId,
      reason,
      metadata: {
        targetUserId,
        adminId,
        adminEmail: adminUser.email,
        scopes,
        durationMinutes,
        expiresAt: expiresAt.toISOString(),
        ticketId: ticketId || null,
        jti,
        sessionId,
      },
      ipAddress,
      userAgent,
    });

    // 2. Operational audit log for general query compatibility
    try {
      await this.auditLogService.record({
        userId: adminId,
        action: AuditLogAction.ACCESS,
        resourceType: "User",
        resourceId: targetUserId,
        ipAddress,
        userAgent,
        details: `Admin ${adminUser.email} started support impersonation for user ${targetUser.email || targetUser.id}`,
        metadata: {
          targetUserId,
          adminId,
          scopes,
          expiresAt: expiresAt.toISOString(),
          ticketId,
          jti,
        },
      });
    } catch (auditErr) {
      this.logger.warn(
        `Operational audit log record failed (immutable audit succeeded): ${auditErr?.message || auditErr}`,
      );
    }

    // 3. User-safe notice generation (no admin PII / secrets leaked)
    const userNotice = `An authorized support session has been initiated on your account (Scopes: ${scopes.join(", ")}). Access expires automatically at ${expiresAt.toISOString()}.${ticketId ? ` Reference ticket: ${ticketId}.` : ""}`;

    // 4. Dispatch notification to the target user
    if (this.notificationService) {
      try {
        await this.notificationService.send({
          userId: targetUserId,
          category: NotificationCategory.SECURITY,
          priority: NotificationPriority.HIGH,
          title: "Security Notice: Support Access Session Initiated",
          body: userNotice,
          metadata: {
            supportSession: true,
            scopes,
            expiresAt: expiresAt.toISOString(),
            ticketId: ticketId || null,
          },
        });
      } catch (notifyErr) {
        this.logger.warn(
          `User notice notification dispatch failed: ${notifyErr?.message || notifyErr}`,
        );
      }
    }

    // 5. Generate time-bounded, scoped JWT token
    const payload = {
      sub: targetUser.id,
      email: targetUser.email,
      username: targetUser.username,
      role: targetUser.role,
      impersonatorId: adminUser.id,
      twoFactorVerified: true, // Bypass 2FA for maintainer support session
      jti,
      supportScopes: scopes,
      expiresAt: expiresAt.toISOString(),
      ticketId,
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: `${durationMinutes}m`,
      jwtid: jti,
    });

    // 6. Record active session in in-memory registry
    const sessionData: ActiveSupportSession = {
      sessionId,
      jti,
      targetUserId,
      adminId,
      scopes,
      reason,
      ticketId,
      startedAt: now,
      expiresAt,
    };
    this.activeSessions.set(targetUserId, sessionData);
    this.tokenJtiToTargetUser.set(jti, targetUserId);

    return {
      accessToken,
      user: {
        id: targetUser.id,
        email: targetUser.email,
        role: targetUser.role,
        isImpersonated: true,
      },
      session: {
        scopes,
        expiresAt: expiresAt.toISOString(),
        durationMinutes,
        ticketId: ticketId || null,
        userNotice,
      },
    };
  }

  /**
   * Stop an impersonation session.
   * Revokes the token jti via TokenBlacklistService, removes active session record,
   * records the termination event in the immutable audit trail, and notifies the target user.
   */
  async stopImpersonation(
    adminId: string,
    targetUserId: string,
    ipAddress: string,
    userAgent?: string,
    options?: StopImpersonationOptions,
  ) {
    const activeSession = this.activeSessions.get(targetUserId);
    const jti = options?.jti || activeSession?.jti;

    // Invalidate token in distributed blacklist if jti is present
    if (jti && this.tokenBlacklistService) {
      const expiryMs = activeSession
        ? activeSession.expiresAt.getTime()
        : Date.now() + 3600000;
      await this.tokenBlacklistService.revoke(jti, expiryMs);
    }

    if (jti) {
      this.tokenJtiToTargetUser.delete(jti);
    }
    this.activeSessions.delete(targetUserId);

    const reason = options?.reason?.trim() || "Support access session ended";

    // 1. IMMUTABLE AUDIT TRAIL RECORDING
    await this.sensitiveAuditService.recordSensitiveAction({
      action: SensitiveAction.IMPERSONATION_STOPPED,
      actorId: adminId,
      actorType: AuditActorType.MAINTAINER,
      resourceType: "User",
      resourceId: targetUserId,
      reason,
      metadata: {
        targetUserId,
        adminId,
        jti: jti || null,
      },
      ipAddress,
      userAgent,
    });

    // 2. Operational audit log
    try {
      await this.auditLogService.record({
        userId: adminId,
        action: AuditLogAction.ACCESS,
        resourceType: "User",
        resourceId: targetUserId,
        ipAddress,
        userAgent,
        details: `Admin stopped support impersonation for user ${targetUserId}`,
        metadata: { targetUserId, adminId, jti },
      });
    } catch (auditErr) {
      this.logger.warn(
        `Operational audit log record failed (immutable audit succeeded): ${auditErr?.message || auditErr}`,
      );
    }

    // 3. User-safe notification
    if (this.notificationService) {
      try {
        await this.notificationService.send({
          userId: targetUserId,
          category: NotificationCategory.SECURITY,
          priority: NotificationPriority.NORMAL,
          title: "Security Notice: Support Access Session Ended",
          body: "The maintainer support session on your account has ended.",
          metadata: {
            supportSessionEnded: true,
            endedAt: new Date().toISOString(),
          },
        });
      } catch (notifyErr) {
        this.logger.warn(
          `User notice notification dispatch failed: ${notifyErr?.message || notifyErr}`,
        );
      }
    }

    return {
      success: true,
      message: "Support access session stopped and logged to immutable audit trail",
    };
  }

  /**
   * Returns a user-safe notice of active support access on the account.
   * Strips administrative identities, internal tokens, and IP addresses to protect privacy.
   */
  getActiveNotice(userId: string): SupportSessionNotice {
    const session = this.activeSessions.get(userId);
    if (!session) {
      return {
        hasActiveSupportAccess: false,
        notice: null,
        session: null,
      };
    }

    const now = new Date();
    if (now >= session.expiresAt || session.revokedAt) {
      this.activeSessions.delete(userId);
      if (session.jti) {
        this.tokenJtiToTargetUser.delete(session.jti);
      }
      return {
        hasActiveSupportAccess: false,
        notice: null,
        session: null,
      };
    }

    return {
      hasActiveSupportAccess: true,
      notice: `An authorized support session is active on your account with scopes: ${session.scopes.join(", ")}. Access expires at ${session.expiresAt.toISOString()}.`,
      session: {
        scopes: session.scopes,
        startedAt: session.startedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        ticketId: session.ticketId || null,
      },
    };
  }
}

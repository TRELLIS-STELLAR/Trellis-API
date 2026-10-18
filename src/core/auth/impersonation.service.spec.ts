import { Test, TestingModule } from "@nestjs/testing";
import { ImpersonationService } from "./impersonation.service";
import { JwtService } from "@nestjs/jwt";
import { getRepositoryToken } from "@nestjs/typeorm";
import { User } from "../user/entities/user.entity";
import { AuditLogService } from "../../infrastructure/audit/audit-log.service";
import { SensitiveActionAuditService } from "../../infrastructure/audit/sensitive-actions/sensitive-action-audit.service";
import { TokenBlacklistService } from "./token-blacklist.service";
import { NotificationService } from "../../notifications/services/notification.service";
import { Role } from "../../common/guard/roles.enum";
import {
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { SensitiveAction } from "../../infrastructure/audit/sensitive-actions/sensitive-action.enum";
import { AuditActorType } from "../../infrastructure/audit/entities/sensitive-action-event.entity";
import { SupportAccessScope } from "./impersonation.types";
import { NotificationCategory, NotificationPriority } from "../../notifications/entities/notification.entity";

describe("ImpersonationService", () => {
  let service: ImpersonationService;
  let jwtService: jest.Mocked<JwtService>;
  let auditLogService: jest.Mocked<AuditLogService>;
  let sensitiveAuditService: jest.Mocked<SensitiveActionAuditService>;
  let tokenBlacklistService: jest.Mocked<TokenBlacklistService>;
  let notificationService: jest.Mocked<NotificationService>;
  let mockUserRepository: any;

  beforeEach(async () => {
    mockUserRepository = {
      findOne: jest.fn(),
    };
    jwtService = {
      sign: jest.fn(),
    } as any;
    auditLogService = {
      record: jest.fn().mockResolvedValue({} as any),
    } as any;
    sensitiveAuditService = {
      recordSensitiveAction: jest.fn().mockResolvedValue({} as any),
    } as any;
    tokenBlacklistService = {
      revoke: jest.fn().mockResolvedValue(undefined),
      isRevoked: jest.fn().mockResolvedValue(false),
    } as any;
    notificationService = {
      send: jest.fn().mockResolvedValue({} as any),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: JwtService,
          useValue: jwtService,
        },
        {
          provide: AuditLogService,
          useValue: auditLogService,
        },
        {
          provide: SensitiveActionAuditService,
          useValue: sensitiveAuditService,
        },
        {
          provide: TokenBlacklistService,
          useValue: tokenBlacklistService,
        },
        {
          provide: NotificationService,
          useValue: notificationService,
        },
      ],
    }).compile();

    service = module.get<ImpersonationService>(ImpersonationService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("startImpersonation", () => {
    it("should throw UnauthorizedException if admin not found", async () => {
      mockUserRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.startImpersonation("admin1", "target1", "127.0.0.1"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should throw ForbiddenException if user is not admin", async () => {
      mockUserRepository.findOne.mockResolvedValueOnce({ role: Role.USER });
      await expect(
        service.startImpersonation("admin1", "target1", "127.0.0.1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should throw NotFoundException if target not found", async () => {
      mockUserRepository.findOne.mockResolvedValueOnce({
        id: "admin1",
        role: Role.ADMIN,
      });
      mockUserRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.startImpersonation("admin1", "target1", "127.0.0.1"),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw ForbiddenException if target is admin", async () => {
      mockUserRepository.findOne.mockResolvedValueOnce({
        id: "admin1",
        role: Role.ADMIN,
      });
      mockUserRepository.findOne.mockResolvedValueOnce({
        id: "target1",
        role: Role.ADMIN,
      });
      await expect(
        service.startImpersonation("admin1", "target1", "127.0.0.1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should start impersonation successfully with default read-only scope and 60m duration", async () => {
      const admin = { id: "admin1", email: "admin@t.com", role: Role.ADMIN };
      const target = {
        id: "target1",
        email: "target@t.com",
        username: "target",
        role: Role.USER,
      };

      mockUserRepository.findOne.mockResolvedValueOnce(admin);
      mockUserRepository.findOne.mockResolvedValueOnce(target);
      jwtService.sign.mockReturnValue("test-token");

      const result = await service.startImpersonation(
        "admin1",
        "target1",
        "127.0.0.1",
      );

      // Verify JWT sign called with 60m default duration and scoped claims
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: target.id,
          impersonatorId: admin.id,
          supportScopes: [SupportAccessScope.READ_ONLY],
          jti: expect.any(String),
          expiresAt: expect.any(String),
        }),
        expect.objectContaining({ expiresIn: "60m", jwtid: expect.any(String) }),
      );

      // Verify immutable audit trail record was created
      expect(sensitiveAuditService.recordSensitiveAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: SensitiveAction.IMPERSONATION_STARTED,
          actorId: admin.id,
          actorType: AuditActorType.MAINTAINER,
          resourceType: "User",
          resourceId: target.id,
          reason: expect.any(String),
          metadata: expect.objectContaining({
            targetUserId: target.id,
            adminId: admin.id,
            scopes: [SupportAccessScope.READ_ONLY],
            durationMinutes: 60,
          }),
        }),
      );

      // Verify operational audit log also called
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: target.id,
        }),
      );

      // Verify user-safe notification was sent
      expect(notificationService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: target.id,
          category: NotificationCategory.SECURITY,
          priority: NotificationPriority.HIGH,
          title: expect.stringContaining("Support Access"),
        }),
      );

      expect(result.accessToken).toBe("test-token");
      expect(result.user.isImpersonated).toBe(true);
      expect(result.session.scopes).toEqual([SupportAccessScope.READ_ONLY]);
      expect(result.session.durationMinutes).toBe(60);
      expect(result.session.userNotice).toBeDefined();
    });

    it("should enforce custom time bounds and custom scopes", async () => {
      const admin = { id: "admin1", email: "admin@t.com", role: Role.ADMIN };
      const target = {
        id: "target1",
        email: "target@t.com",
        username: "target",
        role: Role.USER,
      };

      mockUserRepository.findOne.mockResolvedValueOnce(admin);
      mockUserRepository.findOne.mockResolvedValueOnce(target);
      jwtService.sign.mockReturnValue("scoped-token");

      const result = await service.startImpersonation(
        "admin1",
        "target1",
        "127.0.0.1",
        "TestAgent",
        {
          durationMinutes: 30,
          scopes: [SupportAccessScope.PORTFOLIO_READ],
          reason: "Diagnosing portfolio valuation sync",
          ticketId: "TICKET-42",
        },
      );

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: target.id,
          supportScopes: [SupportAccessScope.PORTFOLIO_READ],
          ticketId: "TICKET-42",
        }),
        expect.objectContaining({ expiresIn: "30m" }),
      );

      expect(sensitiveAuditService.recordSensitiveAction).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "Diagnosing portfolio valuation sync",
          metadata: expect.objectContaining({
            ticketId: "TICKET-42",
            durationMinutes: 30,
            scopes: [SupportAccessScope.PORTFOLIO_READ],
          }),
        }),
      );

      expect(result.session.durationMinutes).toBe(30);
      expect(result.session.scopes).toEqual([SupportAccessScope.PORTFOLIO_READ]);
      expect(result.session.ticketId).toBe("TICKET-42");
    });

    it("cannot bypass audit logging: fails closed if immutable audit logging throws", async () => {
      const admin = { id: "admin1", email: "admin@t.com", role: Role.ADMIN };
      const target = {
        id: "target1",
        email: "target@t.com",
        username: "target",
        role: Role.USER,
      };

      mockUserRepository.findOne.mockResolvedValueOnce(admin);
      mockUserRepository.findOne.mockResolvedValueOnce(target);
      sensitiveAuditService.recordSensitiveAction.mockRejectedValueOnce(
        new Error("Audit database append-only failure: hash mismatch"),
      );

      await expect(
        service.startImpersonation("admin1", "target1", "127.0.0.1"),
      ).rejects.toThrow("Audit database append-only failure");

      // Verify NO token was signed or issued
      expect(jwtService.sign).not.toHaveBeenCalled();
    });
  });

  describe("stopImpersonation", () => {
    it("should revoke token, record termination in immutable audit trail, and notify user", async () => {
      const admin = { id: "admin1", email: "admin@t.com", role: Role.ADMIN };
      const target = {
        id: "target1",
        email: "target@t.com",
        username: "target",
        role: Role.USER,
      };

      mockUserRepository.findOne.mockResolvedValueOnce(admin);
      mockUserRepository.findOne.mockResolvedValueOnce(target);
      jwtService.sign.mockReturnValue("token-1");

      // Start first so we have an active session
      await service.startImpersonation("admin1", "target1", "127.0.0.1");

      const stopResult = await service.stopImpersonation(
        "admin1",
        "target1",
        "127.0.0.1",
        "Mozilla",
        { reason: "Customer issue resolved" },
      );

      expect(tokenBlacklistService.revoke).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Number),
      );

      expect(sensitiveAuditService.recordSensitiveAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: SensitiveAction.IMPERSONATION_STOPPED,
          actorId: "admin1",
          resourceId: "target1",
          reason: "Customer issue resolved",
        }),
      );

      expect(notificationService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "target1",
          title: expect.stringContaining("Ended"),
        }),
      );

      expect(stopResult.success).toBe(true);
    });
  });

  describe("getActiveNotice", () => {
    it("should return hasActiveSupportAccess=false when no session is active", () => {
      const notice = service.getActiveNotice("user-unknown");
      expect(notice.hasActiveSupportAccess).toBe(false);
      expect(notice.notice).toBeNull();
      expect(notice.session).toBeNull();
    });

    it("should expose user-safe notice without leaking admin credentials or IP", async () => {
      const admin = { id: "admin1", email: "secret-admin@company.internal", role: Role.ADMIN };
      const target = {
        id: "target1",
        email: "target@example.com",
        username: "target",
        role: Role.USER,
      };

      mockUserRepository.findOne.mockResolvedValueOnce(admin);
      mockUserRepository.findOne.mockResolvedValueOnce(target);
      jwtService.sign.mockReturnValue("active-token");

      await service.startImpersonation(
        "admin1",
        "target1",
        "10.0.0.1",
        "SecretBrowser",
        {
          ticketId: "TICKET-99",
          scopes: [SupportAccessScope.PORTFOLIO_READ],
        },
      );

      const notice = service.getActiveNotice("target1");
      expect(notice.hasActiveSupportAccess).toBe(true);
      expect(notice.notice).toBeDefined();
      // Verify admin secrets/identities are NOT exposed in user-safe notice
      expect(notice.notice).not.toContain("secret-admin@company.internal");
      expect(notice.notice).not.toContain("10.0.0.1");
      expect(notice.session?.scopes).toEqual([SupportAccessScope.PORTFOLIO_READ]);
      expect(notice.session?.ticketId).toBe("TICKET-99");
    });
  });
});

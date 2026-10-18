jest.mock("./guards/admin-two-factor.guard", () => ({
  AdminTwoFactorGuard: class {},
}));
jest.mock("./guards/jwt-auth.guard", () => ({
  JwtAuthGuard: class {},
}));
jest.mock("../../common/guard/roles.guard", () => ({
  RolesGuard: class {},
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ImpersonationController } from "./impersonation.controller";
import { ImpersonationService } from "./impersonation.service";
import { Role } from "../../common/guard/roles.enum";
import { SupportAccessScope } from "./impersonation.types";

describe("ImpersonationController", () => {
  let controller: ImpersonationController;
  let service: jest.Mocked<ImpersonationService>;

  beforeEach(async () => {
    service = {
      startImpersonation: jest.fn(),
      stopImpersonation: jest.fn(),
      getActiveNotice: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ImpersonationController],
      providers: [
        {
          provide: ImpersonationService,
          useValue: service,
        },
      ],
    }).compile();

    controller = module.get<ImpersonationController>(ImpersonationController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("startImpersonation", () => {
    it("should delegate to ImpersonationService with request context and options", async () => {
      const mockResult = {
        accessToken: "jwt-token",
        user: { id: "user-1", email: "user@t.com", role: Role.USER, isImpersonated: true },
        session: {
          scopes: [SupportAccessScope.READ_ONLY],
          expiresAt: new Date().toISOString(),
          durationMinutes: 60,
          ticketId: "TICKET-1",
          userNotice: "Support notice",
        },
      };
      service.startImpersonation.mockResolvedValueOnce(mockResult as any);

      const req = {
        user: { sub: "admin-1", role: Role.ADMIN },
        ip: "127.0.0.1",
        headers: { "user-agent": "test-agent" },
      };
      const dto = {
        targetUserId: "user-1",
        reason: "Investigating trade failure",
        ticketId: "TICKET-1",
        durationMinutes: 60,
        scopes: [SupportAccessScope.READ_ONLY],
      };

      const result = await controller.startImpersonation(req, dto);
      expect(result).toEqual(mockResult);
      expect(service.startImpersonation).toHaveBeenCalledWith(
        "admin-1",
        "user-1",
        "127.0.0.1",
        "test-agent",
        {
          reason: "Investigating trade failure",
          ticketId: "TICKET-1",
          durationMinutes: 60,
          scopes: [SupportAccessScope.READ_ONLY],
        },
      );
    });
  });

  describe("stopImpersonation", () => {
    it("should delegate stopImpersonation with admin id, target user id, and jti", async () => {
      service.stopImpersonation.mockResolvedValueOnce({ success: true, message: "Stopped" } as any);

      const req = {
        user: { impersonatorId: "admin-1", jti: "token-jti-1" },
        ip: "127.0.0.1",
        headers: { "user-agent": "test-agent" },
      };
      const dto = {
        targetUserId: "user-1",
        reason: "Resolved",
      };

      const result = await controller.stopImpersonation(req, dto);
      expect(result).toEqual({ success: true, message: "Stopped" });
      expect(service.stopImpersonation).toHaveBeenCalledWith(
        "admin-1",
        "user-1",
        "127.0.0.1",
        "test-agent",
        {
          reason: "Resolved",
          jti: "token-jti-1",
        },
      );
    });
  });

  describe("getActiveNotice", () => {
    it("should return user-safe notice for the authenticated user", async () => {
      const notice = {
        hasActiveSupportAccess: true,
        notice: "Support session is active",
        session: {
          scopes: [SupportAccessScope.READ_ONLY],
          startedAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          ticketId: "TICKET-1",
        },
      };
      service.getActiveNotice.mockReturnValueOnce(notice);

      const req = { user: { sub: "user-1" } };
      const result = await controller.getActiveNotice(req);
      expect(result).toEqual(notice);
      expect(service.getActiveNotice).toHaveBeenCalledWith("user-1");
    });
  });
});

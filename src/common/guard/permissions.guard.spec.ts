import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PermissionsGuard } from "./permissions.guard";
import { PERMISSIONS_KEY } from "./permissions.decorator";
import { Permission, Role } from "./roles.enum";

describe("PermissionsGuard", () => {
  let guard: PermissionsGuard;
  let reflector: Reflector;

  const createMockContext = (user?: any): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new PermissionsGuard(reflector);
  });

  describe("when no permissions are required", () => {
    it("allows access when no metadata is set", () => {
      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
      const context = createMockContext({ address: "0x123", role: Role.USER });
      expect(guard.canActivate(context)).toBe(true);
    });

    it("allows access when permissions array is empty", () => {
      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue([]);
      const context = createMockContext({ address: "0x123", role: Role.USER });
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe("when permissions are required", () => {
    it("throws UnauthorizedException if no user is on request", () => {
      jest
        .spyOn(reflector, "getAllAndOverride")
        .mockReturnValue([Permission.TRADE_EXECUTE]);
      const context = createMockContext(undefined);
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it("authorizes user whose role has the required permission", () => {
      jest
        .spyOn(reflector, "getAllAndOverride")
        .mockReturnValue([Permission.PORTFOLIO_OPTIMIZE]);
      const context = createMockContext({
        address: "0x123",
        role: Role.OPERATOR,
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it("denies user whose role lacks the required permission", () => {
      jest
        .spyOn(reflector, "getAllAndOverride")
        .mockReturnValue([Permission.ROLE_ASSIGN]);
      const context = createMockContext({
        address: "0x123",
        role: Role.USER,
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it("authorizes ADMIN automatically for any permission", () => {
      jest
        .spyOn(reflector, "getAllAndOverride")
        .mockReturnValue([
          Permission.ROLE_ASSIGN,
          Permission.SYSTEM_MAINTENANCE,
          Permission.TRADE_EXECUTE,
        ]);
      const context = createMockContext({
        address: "0x123",
        role: Role.ADMIN,
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it("authorizes user with explicit user.permissions claim", () => {
      jest
        .spyOn(reflector, "getAllAndOverride")
        .mockReturnValue([Permission.RECONCILIATION_RUN]);
      const context = createMockContext({
        address: "0x123",
        role: Role.USER,
        permissions: [Permission.RECONCILIATION_RUN],
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it("denies when user has some but not all required permissions", () => {
      jest
        .spyOn(reflector, "getAllAndOverride")
        .mockReturnValue([
          Permission.PORTFOLIO_READ,
          Permission.ROLE_ASSIGN,
        ]);
      const context = createMockContext({
        address: "0x123",
        role: Role.OPERATOR, // has PORTFOLIO_READ but lacks ROLE_ASSIGN
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it("authorizes MAINTAINER for reconciliation and module management", () => {
      jest
        .spyOn(reflector, "getAllAndOverride")
        .mockReturnValue([
          Permission.RECONCILIATION_RUN,
          Permission.MODULE_MANAGE,
        ]);
      const context = createMockContext({
        address: "0x123",
        role: Role.MAINTAINER,
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it("authorizes SERVICE_ACTOR for oracle submit and service sync", () => {
      jest
        .spyOn(reflector, "getAllAndOverride")
        .mockReturnValue([
          Permission.ORACLE_SUBMIT,
          Permission.SERVICE_SYNC,
        ]);
      const context = createMockContext({
        address: "0x123",
        role: Role.SERVICE_ACTOR,
      });
      expect(guard.canActivate(context)).toBe(true);
    });
  });
});

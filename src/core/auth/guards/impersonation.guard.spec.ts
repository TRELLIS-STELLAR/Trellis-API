import { ImpersonationGuard } from "./impersonation.guard";
import { Reflector } from "@nestjs/core";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { ALLOW_IMPERSONATION_KEY } from "../decorators/allow-impersonation.decorator";
import { REQUIRE_SUPPORT_SCOPE_KEY } from "../decorators/require-support-scope.decorator";
import { SupportAccessScope } from "../impersonation.types";

describe("ImpersonationGuard", () => {
  let guard: ImpersonationGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;
    guard = new ImpersonationGuard(reflector);
  });

  const createMockContext = (
    method: string,
    user?: any,
    resHeaders: Record<string, string> = {},
  ) => {
    const response = {
      setHeader: jest.fn((k: string, v: string) => {
        resHeaders[k] = v;
      }),
    };
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          user,
        }),
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  };

  it("should allow if ALLOW_IMPERSONATION_KEY is true", () => {
    reflector.getAllAndOverride.mockImplementation((key) => {
      if (key === ALLOW_IMPERSONATION_KEY) return true;
      return undefined;
    });
    const context = createMockContext("POST", { impersonatorId: "admin1" });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("should allow if user is not impersonating", () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const context = createMockContext("POST", { id: "user1" });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("should allow safe methods during impersonation", () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const context = createMockContext("GET", {
      impersonatorId: "admin1",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("should block dangerous methods during impersonation", () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const context = createMockContext("POST", {
      impersonatorId: "admin1",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it("should throw ForbiddenException if support session has expired", () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const pastDate = new Date(Date.now() - 5000).toISOString();
    const context = createMockContext("GET", {
      impersonatorId: "admin1",
      expiresAt: pastDate,
    });
    expect(() => guard.canActivate(context)).toThrow(
      /Support access session has expired/,
    );
  });

  it("should enforce required support scopes and block if unauthorized", () => {
    reflector.getAllAndOverride.mockImplementation((key) => {
      if (key === REQUIRE_SUPPORT_SCOPE_KEY) {
        return [SupportAccessScope.DEFI_READ];
      }
      return undefined;
    });

    // Session only has PORTFOLIO_READ
    const context = createMockContext("GET", {
      impersonatorId: "admin1",
      supportScopes: [SupportAccessScope.PORTFOLIO_READ],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    expect(() => guard.canActivate(context)).toThrow(
      /Insufficient support scope/,
    );
  });

  it("should allow if session possesses the required scope", () => {
    reflector.getAllAndOverride.mockImplementation((key) => {
      if (key === REQUIRE_SUPPORT_SCOPE_KEY) {
        return [SupportAccessScope.PORTFOLIO_READ];
      }
      return undefined;
    });

    const context = createMockContext("GET", {
      impersonatorId: "admin1",
      supportScopes: [SupportAccessScope.PORTFOLIO_READ],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("should allow if session possesses FULL support scope", () => {
    reflector.getAllAndOverride.mockImplementation((key) => {
      if (key === REQUIRE_SUPPORT_SCOPE_KEY) {
        return [SupportAccessScope.DEFI_READ, SupportAccessScope.PORTFOLIO_READ];
      }
      return undefined;
    });

    const context = createMockContext("GET", {
      impersonatorId: "admin1",
      supportScopes: [SupportAccessScope.FULL],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("should set X-Support-Session response header during impersonation", () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const headers: Record<string, string> = {};
    const expiry = new Date(Date.now() + 60000).toISOString();
    const context = createMockContext(
      "GET",
      {
        impersonatorId: "admin1",
        supportScopes: [SupportAccessScope.READ_ONLY],
        expiresAt: expiry,
      },
      headers,
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(headers["X-Support-Session"]).toContain("active");
    expect(headers["X-Support-Session"]).toContain(SupportAccessScope.READ_ONLY);
  });
});

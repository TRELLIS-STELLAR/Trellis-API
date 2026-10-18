import { StrategyAuthGuard } from "./strategy-auth.guard";
import { PERMISSIONS_KEY } from "src/common/guard/permissions.decorator";
import { ALLOWED_STRATEGIES_KEY } from "src/core/auth/decorators/allowed-strategies.decorator";
import { PermissionsGuard } from "src/common/guard/permissions.guard";

describe("API key scope enforcement", () => {
  let guard: StrategyAuthGuard;
  let api: any;
  let request: any;
  let required: string[];
  let allowed: string[];
  let payload: any;
  let registry: any;
  const context: any = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  };
  beforeEach(() => {
    payload = {
      type: "api-key",
      sub: "owner",
      role: "ADMIN",
      permissions: ["read"],
      apiKeyId: "key-id",
    };
    api = {
      isEnabled: true,
      authenticate: jest.fn().mockResolvedValue({ token: "key-token" }),
      validateToken: jest.fn(async () => payload),
    };
    registry = {
      get: () => api,
      getAll: () => [{ validateToken: async () => payload }],
    };
    request = { headers: { "x-api-key": "secret" }, method: "GET" };
    required = undefined;
    allowed = undefined;
    guard = new StrategyAuthGuard(
      registry,
      {} as any,
      {
        getAllAndOverride: (key) =>
          key === PERMISSIONS_KEY
            ? required
            : key === ALLOWED_STRATEGIES_KEY
              ? allowed
              : false,
      } as any,
    );
  });
  it("authenticates X-API-Key and grants a scoped read", async () => {
    expect(await guard.canActivate(context)).toBe(true);
    expect(request.user.id).toBe("owner");
    expect(request.user.permissions).toBeUndefined();
  });
  it("denies writes to a read-only key even for an admin owner", async () => {
    request.method = "POST";
    await expect(guard.canActivate(context)).rejects.toThrow(
      "insufficient scopes",
    );
  });
  it("requires every explicit endpoint permission", async () => {
    required = ["oracle:submit", "oracle:verify"];
    payload.permissions = ["oracle:submit"];
    await expect(guard.canActivate(context)).rejects.toThrow(
      "insufficient scopes",
    );
    payload.permissions.push("oracle:verify");
    expect(await guard.canActivate(context)).toBe(true);
  });
  it("rechecks API key JWTs even when another strategy accepts the shared JWT", async () => {
    request.headers = { authorization: "Bearer revoked-token" };
    api.validateToken.mockResolvedValue(null);
    await expect(guard.canActivate(context)).rejects.toThrow(
      "Authentication failed",
    );
    expect(api.validateToken).toHaveBeenCalledWith("revoked-token");
  });
  it("does not turn a user-selected scope into an elevated permission grant", async () => {
    payload.role = "USER";
    payload.permissions = ["oracle:submit"];
    required = ["oracle:submit"];
    await guard.canActivate(context);
    const permissions = new PermissionsGuard({
      getAllAndOverride: () => required,
    } as any);
    expect(() => permissions.canActivate(context)).toThrow(
      "Insufficient permissions",
    );
  });
  it("prevents API keys from managing or creating API keys", async () => {
    allowed = ["traditional", "oauth", "wallet"];
    await expect(guard.canActivate(context)).rejects.toThrow(
      "Authentication failed",
    );
  });
});

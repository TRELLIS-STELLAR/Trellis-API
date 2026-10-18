import { ExecutionContext, HttpException, HttpStatus } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { QuotaGuard, QuotaRedisClient } from "./quota.guard";
import { ErrorCode } from "src/common/errors/error-codes";

function createContext(options?: {
  user?: {
    id?: string;
    sub?: string;
    address?: string;
    role?: string;
    tier?: string;
    type?: string;
    apiKey?: string;
  };
  ip?: string;
  originalUrl?: string;
  headers?: Record<string, string>;
}): {
  context: ExecutionContext;
  response: { header: jest.Mock; setHeader: jest.Mock };
} {
  const request = {
    ip: options?.ip ?? "127.0.0.1",
    headers: options?.headers ?? {},
    originalUrl: options?.originalUrl ?? "/api/test",
    route: { path: "/api/test" },
    authType: options?.user?.type,
    user: options?.user,
  };

  const response = {
    header: jest.fn(),
    setHeader: jest.fn(),
  };

  const context = {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, response };
}

function createRedis(initial = 0): {
  client: QuotaRedisClient;
  store: Map<string, number>;
  expires: jest.Mock;
} {
  const store = new Map<string, number>();
  const expires = jest.fn().mockResolvedValue(1);
  const client: QuotaRedisClient = {
    incr: jest.fn(async (key: string) => {
      const next = (store.get(key) ?? initial) + 1;
      store.set(key, next);
      return next;
    }),
    get: jest.fn(async (key: string) => {
      const value = store.get(key);
      return value === undefined ? null : String(value);
    }),
    expire: expires,
  };

  return { client, store, expires };
}

describe("QuotaGuard", () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
  });

  it("allows requests and emits rate-limit headers for the default tier", async () => {
    const guard = new QuotaGuard(reflector);
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
    const { context, response } = createContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(response.header).toHaveBeenCalledWith("X-RateLimit-Limit", 100);
    expect(response.header).toHaveBeenCalledWith("X-RateLimit-Remaining", 99);
    expect(response.header).toHaveBeenCalledWith("X-RateLimit-Tier", "free");
  });

  it("uses the authenticated user tier when one is available", async () => {
    const guard = new QuotaGuard(reflector);
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
    const { context, response } = createContext({
      user: { id: "user-1", role: "admin" },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(response.header).toHaveBeenCalledWith(
      "X-RateLimit-Tier",
      "enterprise",
    );
  });

  it("rejects requests after the configured limit is reached", async () => {
    const guard = new QuotaGuard(reflector);
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue({
      level: "auth",
      limit: 1,
      windowMs: 60_000,
    });

    const { context } = createContext({
      user: { id: "user-2", role: "user" },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    try {
      await guard.canActivate(context);
      throw new Error("Expected rate limit rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  });

  it("increments the monthly Redis counter and emits quota headers", async () => {
    const { client, store, expires } = createRedis();
    const guard = new QuotaGuard(reflector, client);
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
    const { context, response } = createContext({
      user: { id: "user-3", apiKey: "key-1", tier: "free" },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    const monthKey = Array.from(store.keys())[0];
    expect(monthKey).toMatch(/^quota:key-1:\d{}-\d{}$/);
    expect(store.get(monthKey)).toBe(1);
    expect(expires).toHaveBeenCalled();
    expect(response.header).toHaveBeenCalledWith("X-Quota-Limit", 10_000);
    expect(response.header).toHaveBeenCalledWith("X-Quota-Remaining", 9_999);
  });

  it("returns 429 with QUOTA_EXCEEDED when the monthly quota is exhausted", async () => {
    const { client } = createRedis(9999);
    const guard = new QuotaGuard(reflector, client);
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
    const { context, response } = createContext({
      user: { id: "user-4", apiKey: "key-2", tier: "free" },
    });

    try {
      await guard.canActivate(context);
      throw new Error("Expected quota rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      const body = exception.getResponse() as { code: string; resetAt: string };
      expect(body.code).toBe(ErrorCode.QUOTA_EXCEEDED);
      expect(typeof body.resetAt).toBe("string");
    }

    expect(response.header).toHaveBeenCalledWith("X-Quota-Remaining", 0);
  });

  it("does not enforce monthly quota for enterprise tier", async () => {
    const { client } = createRedis(10_000_000);
    const guard = new QuotaGuard(reflector, client);
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
    const { context, response } = createContext({
      user: { id: "user-5", apiKey: "key-3", tier: "enterprise" },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(response.header).toHaveBeenCalledWith("X-Quota-Limit", -1);
  });
});

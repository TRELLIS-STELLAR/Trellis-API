import { HttpStatus } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PublicHealthController } from "./public-health.controller";
import {
  buildPublicHealthView,
  httpStatusForHealth,
  PublicHealthInput,
} from "./public-health.model";
import { PublicHealthService } from "./public-health.service";
import { HealthService } from "./health.service";
import { DependencyHealthService } from "../dependency-health/dependency-health.service";
import { IS_PUBLIC_KEY } from "../common/decorators/public.decorator";

/**
 * Public, dependency-aware health endpoint (#281): normal, failure, retry and
 * authorization (public exposure) paths.
 */

const NOW = new Date("2026-10-18T12:00:00.000Z");

function input(overrides: Partial<PublicHealthInput> = {}): PublicHealthInput {
  return {
    database: { status: "up", responseTime: 5 },
    redis: { status: "up", responseTime: 2 },
    dependencies: { status: "healthy", advisory: "healthy" },
    slowThresholdMs: 1_000,
    now: NOW,
    uptimeSeconds: 42.4,
    ...overrides,
  };
}

const status = (view: ReturnType<typeof buildPublicHealthView>, name: string) =>
  view.checks.find((c) => c.name === name)?.status;

describe("buildPublicHealthView", () => {
  it("is ok when every dependency is healthy", () => {
    const view = buildPublicHealthView(input());
    expect(view).toEqual({
      status: "ok",
      timestamp: NOW.toISOString(),
      uptimeSeconds: 42,
      checks: [
        { name: "database", critical: true, status: "up" },
        { name: "cache", critical: true, status: "up" },
        { name: "external-dependencies", critical: true, status: "up" },
        { name: "optional-dependencies", critical: false, status: "up" },
      ],
    });
    expect(httpStatusForHealth(view.status)).toBe(200);
  });

  it("is down (503) when the database is down", () => {
    const view = buildPublicHealthView(input({ database: { status: "down" } }));
    expect(view.status).toBe("down");
    expect(httpStatusForHealth(view.status)).toBe(503);
  });

  it("treats an unconfigured cache as disabled, not as an outage", () => {
    const view = buildPublicHealthView(input({ redis: null }));
    expect(view.status).toBe("ok");
    expect(view.checks.find((c) => c.name === "cache")).toEqual({
      name: "cache",
      critical: false,
      status: "disabled",
    });
  });

  it("is down when a configured cache is down", () => {
    expect(
      buildPublicHealthView(input({ redis: { status: "down" } })).status,
    ).toBe("down");
  });

  it("is down when a critical external dependency is unavailable or misconfigured", () => {
    for (const state of ["unavailable", "misconfigured"] as const) {
      const view = buildPublicHealthView(
        input({ dependencies: { status: state, advisory: "healthy" } }),
      );
      expect(view.status).toBe("down");
      expect(status(view, "external-dependencies")).toBe("down");
    }
  });

  it("is degraded, still serving, when only optional dependencies are impaired", () => {
    const view = buildPublicHealthView(
      input({ dependencies: { status: "healthy", advisory: "unavailable" } }),
    );
    expect(view.status).toBe("degraded");
    expect(httpStatusForHealth(view.status)).toBe(200);
    expect(status(view, "optional-dependencies")).toBe("down");
  });

  it("is degraded when a core dependency is reachable but slow", () => {
    const view = buildPublicHealthView(
      input({ database: { status: "up", responseTime: 2_500 } }),
    );
    expect(view.status).toBe("degraded");
    expect(status(view, "database")).toBe("degraded");
  });

  it("is degraded, not down, when the dependency summary could not run", () => {
    const view = buildPublicHealthView(input({ dependencies: undefined }));
    expect(view.status).toBe("degraded");
    expect(status(view, "external-dependencies")).toBe("degraded");
  });

  it("ignores intentionally disabled dependency checks", () => {
    const view = buildPublicHealthView(
      input({ dependencies: { status: "disabled", advisory: "disabled" } }),
    );
    expect(view.status).toBe("ok");
  });
});

class TestPublicHealthService extends PublicHealthService {
  nowMs = NOW.getTime();
  sleeps: number[] = [];
  protected clock(): number {
    return this.nowMs;
  }
  protected async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
  }
}

function makeService(
  core: jest.Mock,
  summary: jest.Mock = jest
    .fn()
    .mockResolvedValue({ status: "healthy", advisory: "healthy" }),
  env: Record<string, string> = {},
) {
  const health = { checkCoreComponents: core } as unknown as HealthService;
  const deps = { getSummary: summary } as unknown as DependencyHealthService;
  const config = { get: (key: string) => env[key] } as never;
  return new TestPublicHealthService(health, deps, config);
}

const up = { status: "up" as const, responseTime: 3 };
const downWithSecret = {
  status: "down" as const,
  message:
    "connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5:5432/trellis",
};

describe("PublicHealthService", () => {
  it("returns ok and probes dependencies locally only", async () => {
    const core = jest.fn().mockResolvedValue({ database: up, redis: up });
    const summary = jest
      .fn()
      .mockResolvedValue({ status: "healthy", advisory: "healthy" });
    const service = makeService(core, summary);

    const result = await service.getHealth();

    expect(result.view.status).toBe("ok");
    expect(result.cached).toBe(false);
    expect(summary).toHaveBeenCalledWith({ networkProbes: false });
  });

  it("retries a failing critical probe before reporting down", async () => {
    const core = jest
      .fn()
      .mockResolvedValueOnce({ database: downWithSecret, redis: up })
      .mockResolvedValueOnce({ database: up, redis: up });
    const service = makeService(core);

    const result = await service.getHealth();

    expect(result.view.status).toBe("ok");
    expect(core).toHaveBeenCalledTimes(2);
    expect(service.sleeps).toEqual([200]);
  });

  it("reports down once retries are exhausted, without leaking probe errors", async () => {
    const core = jest
      .fn()
      .mockResolvedValue({ database: downWithSecret, redis: null });
    const service = makeService(core, undefined, {
      HEALTH_PUBLIC_PROBE_RETRIES: "2",
    });

    const result = await service.getHealth();

    expect(result.view.status).toBe("down");
    expect(core).toHaveBeenCalledTimes(3);
    const body = JSON.stringify(result.view);
    expect(body).not.toMatch(/hunter2|10\.0\.0\.5|postgres:\/\/|ECONNREFUSED/);
  });

  it("treats a throwing probe as down instead of failing the request", async () => {
    const core = jest.fn().mockRejectedValue(new Error("pool exhausted"));
    const service = makeService(core, undefined, {
      HEALTH_PUBLIC_PROBE_RETRIES: "0",
    });
    await expect(service.getHealth()).resolves.toMatchObject({
      view: { status: "down" },
    });
  });

  it("degrades instead of failing when the dependency summary throws", async () => {
    const core = jest.fn().mockResolvedValue({ database: up, redis: up });
    const summary = jest.fn().mockRejectedValue(new Error("registry crashed"));
    const result = await makeService(core, summary).getHealth();
    expect(result.view.status).toBe("degraded");
  });

  it("serves a cached verdict within the TTL and re-probes after it", async () => {
    const core = jest.fn().mockResolvedValue({ database: up, redis: up });
    const service = makeService(core, undefined, {
      HEALTH_PUBLIC_CACHE_TTL_MS: "5000",
    });

    await service.getHealth();
    const second = await service.getHealth();
    expect(second.cached).toBe(true);
    expect(core).toHaveBeenCalledTimes(1);

    service.nowMs += 5_001;
    const third = await service.getHealth();
    expect(third.cached).toBe(false);
    expect(core).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight evaluation between concurrent callers", async () => {
    let release!: () => void;
    const core = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ database: up, redis: up });
        }),
    );
    const service = makeService(core, undefined, {
      HEALTH_PUBLIC_CACHE_TTL_MS: "0",
    });

    const calls = Promise.all([
      service.getHealth(),
      service.getHealth(),
      service.getHealth(),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const results = await calls;

    expect(core).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.view.status === "ok")).toBe(true);
  });

  it("re-probes immediately after invalidate()", async () => {
    const core = jest.fn().mockResolvedValue({ database: up, redis: up });
    const service = makeService(core);
    await service.getHealth();
    service.invalidate();
    await service.getHealth();
    expect(core).toHaveBeenCalledTimes(2);
  });
});

function mockResponse() {
  const res: any = { headers: {} as Record<string, string>, statusCode: 200 };
  res.setHeader = (name: string, value: string) => {
    res.headers[name] = value;
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  return res;
}

describe("PublicHealthController", () => {
  async function controllerWith(result: unknown) {
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicHealthController],
      providers: [
        {
          provide: PublicHealthService,
          useValue: { getHealth: jest.fn().mockResolvedValue(result) },
        },
      ],
    }).compile();
    return moduleRef.get(PublicHealthController);
  }

  const view = (s: "ok" | "degraded" | "down") => ({
    status: s,
    timestamp: NOW.toISOString(),
    uptimeSeconds: 1,
    checks: [],
  });

  it("is public: no authentication is required", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, PublicHealthController)).toBe(
      true,
    );
  });

  it("returns 200 with no-store caching headers when ok", async () => {
    const controller = await controllerWith({
      view: view("ok"),
      cached: true,
      retryAfterSeconds: 15,
    });
    const res = mockResponse();
    const body = await controller.getHealth(res);
    expect(body.status).toBe("ok");
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "Cache-Control": "no-store",
      "X-Trellis-Health": "ok",
      "X-Trellis-Health-Cached": "true",
    });
    expect(res.headers["Retry-After"]).toBeUndefined();
  });

  it("keeps serving 200 when degraded", async () => {
    const controller = await controllerWith({
      view: view("degraded"),
      cached: false,
      retryAfterSeconds: 15,
    });
    const res = mockResponse();
    await controller.getHealth(res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 503 with Retry-After when down", async () => {
    const controller = await controllerWith({
      view: view("down"),
      cached: false,
      retryAfterSeconds: 30,
    });
    const res = mockResponse();
    await controller.getHealth(res);
    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(res.headers["Retry-After"]).toBe("30");
  });
});

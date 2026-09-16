import { Test, TestingModule } from "@nestjs/testing";
import { register, httpRequestTotal } from "../config/metrics";
import { ObservabilityController } from "./observability.controller";
import { PerformanceBaselineService } from "./performance-baseline.service";
import { RequestTimingMiddleware } from "./request-timing.middleware";

/**
 * The controller writes the Content-Type header itself, so a minimal stub
 * `Response` that records the header is enough to verify both the header
 * is set and the body matches the Prometheus exposition format.
 */
function makeRes(): { setHeader: jest.Mock; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: jest.fn((name: string, value: string) => {
      headers[name] = value;
    }),
  } as any;
}

/**
 * Minimal Express-request stub carrying the auth header / query token the
 * metrics endpoint inspects when `METRICS_AUTH_TOKEN` is set.
 */
function makeReq(opts: { authorization?: string; token?: string } = {}): any {
  return {
    headers: opts.authorization ? { authorization: opts.authorization } : {},
    query: opts.token ? { token: opts.token } : {},
  };
}

describe("ObservabilityController - Prometheus /metrics endpoint (issue #25)", () => {
  let controller: ObservabilityController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ObservabilityController],
      providers: [
        {
          provide: PerformanceBaselineService,
          useValue: {
            getBaselines: () => [],
            getRegressions: () => [],
            resetBaselines: () => undefined,
          },
        },
        {
          provide: RequestTimingMiddleware,
          useValue: { getActiveRequests: () => [] },
        },
      ],
    }).compile();

    controller = module.get<ObservabilityController>(ObservabilityController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  it("exposes a getMetrics handler", () => {
    expect(typeof controller.getMetrics).toBe("function");
  });

  it("writes the Prometheus content-type and returns text exposition output", async () => {
    httpRequestTotal.reset();
    const res = makeRes();

    const body = await controller.getMetrics(makeReq(), res as any);

    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      register.contentType,
    );
    expect(register.contentType).toMatch(/text\/plain/);
  });

  it("includes the application HTTP request counter that the dashboard reads", async () => {
    httpRequestTotal.reset();
    httpRequestTotal.inc({
      method: "GET",
      route: "/api/v1/health",
      status_code: "200",
    });
    const res = makeRes();

    const body = await controller.getMetrics(makeReq(), res as any);

    expect(body).toContain(
      "# TYPE trellis_http_requests_total counter",
    );
    expect(body).toMatch(
      /trellis_http_requests_total\{[^}]*method="GET"[^}]*\}/,
    );
  });

  describe("token protection via METRICS_AUTH_TOKEN", () => {
    const ORIGINAL = process.env.METRICS_AUTH_TOKEN;

    afterEach(() => {
      if (ORIGINAL === undefined) {
        delete process.env.METRICS_AUTH_TOKEN;
      } else {
        process.env.METRICS_AUTH_TOKEN = ORIGINAL;
      }
    });

    it("stays open when no token is configured", async () => {
      delete process.env.METRICS_AUTH_TOKEN;
      const body = await controller.getMetrics(makeReq(), makeRes() as any);
      expect(typeof body).toBe("string");
    });

    it("rejects requests with no token when one is configured", async () => {
      process.env.METRICS_AUTH_TOKEN = "s3cret";
      await expect(
        controller.getMetrics(makeReq(), makeRes() as any),
      ).rejects.toThrow(/token/i);
    });

    it("rejects requests bearing the wrong token", async () => {
      process.env.METRICS_AUTH_TOKEN = "s3cret";
      await expect(
        controller.getMetrics(
          makeReq({ authorization: "Bearer nope" }),
          makeRes() as any,
        ),
      ).rejects.toThrow(/token/i);
    });

    it("accepts the correct token via Authorization header", async () => {
      process.env.METRICS_AUTH_TOKEN = "s3cret";
      const body = await controller.getMetrics(
        makeReq({ authorization: "Bearer s3cret" }),
        makeRes() as any,
      );
      expect(typeof body).toBe("string");
    });

    it("accepts the correct token via query param", async () => {
      process.env.METRICS_AUTH_TOKEN = "s3cret";
      const body = await controller.getMetrics(
        makeReq({ token: "s3cret" }),
        makeRes() as any,
      );
      expect(typeof body).toBe("string");
    });
  });
});

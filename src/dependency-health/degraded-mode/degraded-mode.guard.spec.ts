import {
  CanActivate,
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  UnauthorizedException,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD, Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { GlobalExceptionFilter } from "../../common/filters/global-exception.filter";
import { StellarPaymentsController } from "../../payments/stellar-payments.controller";
import { DependencyHealthService } from "../dependency-health.service";
import { DependencyReport } from "../dependency-health.types";
import { DegradedModeGuard } from "./degraded-mode.guard";
import { DependencyDegradedModeService } from "./degraded-mode.service";
import {
  REQUIRES_CAPABILITY_KEY,
  RequiresCapability,
} from "./requires-capability.decorator";

const report = (database: "healthy" | "unavailable"): DependencyReport =>
  ({
    status: database === "healthy" ? "healthy" : "unhealthy",
    advisory: "healthy",
    generatedAt: new Date().toISOString(),
    durationMs: 1,
    counts: {},
    criticalFindings: database === "healthy" ? [] : ["database"],
    advisoryFindings: [],
    checks: [
      {
        id: "database",
        label: "PostgreSQL",
        kind: "service",
        criticality: "critical",
        state: database,
        detail: "connect ECONNREFUSED 10.0.0.7:5432",
        verification: "network",
        configKeys: [],
        remediation: "restore postgres",
      },
    ],
    networkProbesSkipped: true,
  }) as unknown as DependencyReport;

@Controller("probe")
class ProbeController {
  @Get("pay")
  @RequiresCapability("payments")
  pay() {
    return { ok: true };
  }

  @Get("search")
  @RequiresCapability("search")
  search() {
    return { ok: true };
  }

  @Get("open")
  open() {
    return { ok: true };
  }
}

describe("DegradedModeGuard", () => {
  let app: INestApplication;
  let run: jest.Mock;
  let mode: DependencyDegradedModeService;

  beforeEach(async () => {
    run = jest.fn().mockResolvedValue(report("unavailable"));
    const config = {
      get: (key: string) =>
        key === "DEGRADED_MODE_HEALTH_RETRY_DELAY_MS" ? 1 : undefined,
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: DependencyHealthService, useValue: { run } },
        DependencyDegradedModeService,
        { provide: APP_GUARD, useClass: DegradedModeGuard },
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    mode = moduleRef.get(DependencyDegradedModeService);
  });

  afterEach(() => app.close());

  it("serves undecorated routes without evaluating the mode", async () => {
    await request(app.getHttpServer()).get("/probe/open").expect(200);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps capabilities unaffected by the failing dependency available", async () => {
    await request(app.getHttpServer()).get("/probe/search").expect(200);
  });

  it("answers a disabled capability with a user-safe 503 and Retry-After", async () => {
    const response = await request(app.getHttpServer())
      .get("/probe/pay")
      .expect(503);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.body).toMatchObject({
      errorCode: "SERVICE_UNAVAILABLE",
      retryable: true,
      message:
        "The payments service is temporarily unavailable. Please retry shortly.",
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /postgres|database|ECONNREFUSED|10\.0\.0\.7/i,
    );
  });

  it("fails safe and blocks when health evaluation keeps failing", async () => {
    run.mockRejectedValue(new Error("health store down"));
    await request(app.getHttpServer()).get("/probe/pay").expect(503);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("serves the route again once the dependency recovers", async () => {
    await request(app.getHttpServer()).get("/probe/pay").expect(503);
    run.mockResolvedValue(report("healthy"));
    mode.invalidate();
    await request(app.getHttpServer()).get("/probe/pay").expect(200);
  });

  it("rethrows unexpected evaluation errors instead of masking them", async () => {
    jest
      .spyOn(mode, "assertCapabilityEnabled")
      .mockRejectedValue(new TypeError("bug"));
    const guard = new DegradedModeGuard(new Reflector(), mode);
    const context: any = {
      getHandler: () => ProbeController.prototype.pay,
      getClass: () => ProbeController,
    };
    await expect(guard.canActivate(context)).rejects.toThrow("bug");
  });

  it.each(["createPayment", "submit"] as const)(
    "gates the Stellar payment %s route on the payments capability",
    (handler) => {
      expect(
        Reflect.getMetadata(
          REQUIRES_CAPABILITY_KEY,
          StellarPaymentsController.prototype[handler],
        ),
      ).toBe("payments");
    },
  );
});

describe("DegradedModeGuard ordering", () => {
  @Injectable()
  class RejectingAuthGuard implements CanActivate {
    canActivate(): boolean {
      throw new UnauthorizedException();
    }
  }

  it("lets the root module's auth guard reject anonymous callers first", async () => {
    // Mirrors AppModule (global auth guards) importing DegradedModeModule.
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: DependencyHealthService,
          useValue: { run: jest.fn().mockResolvedValue(report("unavailable")) },
        },
        DependencyDegradedModeService,
        { provide: APP_GUARD, useClass: DegradedModeGuard },
      ],
    })
    class DegradedChildModule {}

    @Module({
      imports: [DegradedChildModule],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: RejectingAuthGuard }],
    })
    class RootModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [RootModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).get("/probe/pay").expect(401);
    await app.close();
  });
});

import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  INestApplication,
  Injectable,
  Logger,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { GlobalExceptionFilter } from "../filters/global-exception.filter";
import { RetrySchedulerService } from "../../infrastructure/retry-scheduler/retry-scheduler.service";
import {
  CORRELATION_ID_HEADER,
  JOB_CORRELATION_FIELD,
  REQUEST_ID_HEADER,
  getCorrelationId,
  withCorrelationHeaders,
  withJobCorrelation,
} from "./correlation-context";
import { CorrelationIdMiddleware } from "./correlation-id.middleware";

/**
 * End-to-end proof (#270) that one correlation ID covers a request's handler,
 * the jobs and retry records it creates, its outbound calls, and its error
 * response, including when a guard rejects it before the handler runs.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const outbound: Array<Record<string, string>> = [];
const queued: Array<Record<string, unknown>> = [];

@Injectable()
class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.headers["x-role"] !== "admin")
      throw new ForbiddenException("Admin role required");
    return true;
  }
}

@Controller("probe")
class ProbeController {
  constructor(private readonly retries: RetrySchedulerService) {}

  @Get("ping")
  async ping() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { correlationId: getCorrelationId() };
  }

  @Post("work")
  async work() {
    // A job, a retry record and an outbound call created by one request.
    queued.push(withJobCorrelation({ task: "sync" }));
    const retry = await this.retries.schedule({
      operationType: "reconciliation.sync",
      operationId: "op-1",
      payload: {},
    });
    outbound.push(withCorrelationHeaders({ Accept: "application/json" }));
    return { retryCorrelationId: retry.correlationId };
  }

  @Get("boom")
  boom() {
    throw new Error("upstream failed");
  }

  @Get("admin")
  @UseGuards(AdminOnlyGuard)
  admin() {
    return { ok: true };
  }
}

describe("request correlation across API, workers and external calls (#270)", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const retryRepo = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        AdminOnlyGuard,
        {
          provide: RetrySchedulerService,
          useFactory: () =>
            new RetrySchedulerService(retryRepo as any, { emit: jest.fn() } as any),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // Mirrors main.ts: correlation is the first middleware.
    const middleware = new CorrelationIdMiddleware();
    app.use((req: any, res: any, next: any) => middleware.use(req, res, next));
    app.useGlobalFilters(
      new GlobalExceptionFilter({
        get: (key: string) => (key === "NODE_ENV" ? "production" : undefined),
      } as unknown as ConfigService),
    );
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    // A listening server (not supertest's per-request ephemeral one) so the
    // concurrency case does not race socket setup.
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  beforeEach(() => {
    outbound.length = 0;
    queued.length = 0;
  });

  it("normal path: echoes the caller's ID and exposes it to the handler", async () => {
    const res = await request(baseUrl)
      .get("/probe/ping")
      .set(CORRELATION_ID_HEADER, "client-trace-1")
      .expect(200);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe("client-trace-1");
    expect(res.headers[REQUEST_ID_HEADER]).toBe("client-trace-1");
    expect(res.body).toEqual({ correlationId: "client-trace-1" });
  });

  it("normal path: generates an ID when the caller sends none", async () => {
    const res = await request(baseUrl).get("/probe/ping").expect(200);
    expect(res.headers[CORRELATION_ID_HEADER]).toMatch(UUID);
    expect(res.body.correlationId).toBe(res.headers[CORRELATION_ID_HEADER]);
  });

  it("carries the request ID onto jobs, retry records and outbound calls", async () => {
    const res = await request(baseUrl)
      .post("/probe/work")
      .set(REQUEST_ID_HEADER, "legacy-request-7")
      .expect(201);
    expect(res.body.retryCorrelationId).toBe("legacy-request-7");
    expect(queued).toEqual([{ task: "sync", [JOB_CORRELATION_FIELD]: "legacy-request-7" }]);
    expect(outbound[0]).toMatchObject({
      [CORRELATION_ID_HEADER]: "legacy-request-7",
      [REQUEST_ID_HEADER]: "legacy-request-7",
    });
  });

  it("does not leak IDs between concurrent requests", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(baseUrl)
          .get("/probe/ping")
          .set(CORRELATION_ID_HEADER, `parallel-${i}`),
      ),
    );
    responses.forEach((res, i) =>
      expect(res.body.correlationId).toBe(`parallel-${i}`),
    );
  });

  it("failure path: the error response carries the same ID in header and body", async () => {
    const res = await request(baseUrl)
      .get("/probe/boom")
      .set(CORRELATION_ID_HEADER, "failing-request")
      .expect(500);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe("failing-request");
    expect(res.body.correlationId).toBe("failing-request");
  });

  it("authorization path: a guard rejection is still correlated", async () => {
    const res = await request(baseUrl)
      .get("/probe/admin")
      .set(CORRELATION_ID_HEADER, "denied-request")
      .expect(403);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe("denied-request");
    expect(res.body).toMatchObject({
      correlationId: "denied-request",
      statusCode: 403,
    });
  });

  it("authorization path: a forged header cannot inject headers or reach the body", async () => {
    const forged = "x".repeat(65);
    const res = await request(baseUrl)
      .get("/probe/admin")
      .set(CORRELATION_ID_HEADER, forged)
      .expect(403);
    expect(res.headers[CORRELATION_ID_HEADER]).toMatch(UUID);
    expect(res.body.correlationId).toBe(res.headers[CORRELATION_ID_HEADER]);
    expect(JSON.stringify(res.body)).not.toContain(forged);
  });
});

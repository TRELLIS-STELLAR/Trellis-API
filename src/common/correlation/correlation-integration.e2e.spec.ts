import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import {
  getCorrelationId,
  runWithCorrelation,
  withJobCorrelation,
  runJobWithCorrelation,
  normalizeCorrelationId,
  deriveContractCorrelationId,
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
} from "./correlation-context";
import { CorrelationIdMiddleware } from "./correlation-id.middleware";

describe("End-to-End Correlation Integration (e2e)", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [TestController],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use((req, res, next) => {
      new CorrelationIdMiddleware().use(req, res, next);
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("Normal Request Path", () => {
    it("should accept and echo client-supplied correlation ID", () => {
      const correlationId = "client-request-123";
      return request(app.getHttpServer())
        .get("/test")
        .set(CORRELATION_ID_HEADER, correlationId)
        .expect(200)
        .expect((res) => {
          expect(res.headers[CORRELATION_ID_HEADER]).toBe(correlationId);
          expect(res.headers[REQUEST_ID_HEADER]).toBe(correlationId);
          expect(res.body.correlationId).toBe(correlationId);
        });
    });

    it("should generate correlation ID when not provided", () => {
      return request(app.getHttpServer())
        .get("/test")
        .expect(200)
        .expect((res) => {
          expect(res.headers[CORRELATION_ID_HEADER]).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          );
          expect(res.headers[REQUEST_ID_HEADER]).toBe(
            res.headers[CORRELATION_ID_HEADER],
          );
        });
    });

    it("should accept legacy x-request-id header", () => {
      const requestId = "legacy-request-456";
      return request(app.getHttpServer())
        .get("/test")
        .set(REQUEST_ID_HEADER, requestId)
        .expect(200)
        .expect((res) => {
          expect(res.headers[CORRELATION_ID_HEADER]).toBe(requestId);
          expect(res.headers[REQUEST_ID_HEADER]).toBe(requestId);
        });
    });

    it("should prefer x-correlation-id over x-request-id", () => {
      const correlationId = "correlation-789";
      const requestId = "request-789";
      return request(app.getHttpServer())
        .get("/test")
        .set(CORRELATION_ID_HEADER, correlationId)
        .set(REQUEST_ID_HEADER, requestId)
        .expect(200)
        .expect((res) => {
          expect(res.headers[CORRELATION_ID_HEADER]).toBe(correlationId);
          expect(res.headers[REQUEST_ID_HEADER]).toBe(correlationId);
        });
    });
  });

  describe("Failure Path - Invalid Correlation IDs", () => {
    it("should reject and replace XSS attempt", () => {
      const maliciousId = "<script>alert('xss')</script>";
      return request(app.getHttpServer())
        .get("/test")
        .set(CORRELATION_ID_HEADER, maliciousId)
        .expect(200)
        .expect((res) => {
          expect(res.headers[CORRELATION_ID_HEADER]).not.toBe(maliciousId);
          expect(res.headers[CORRELATION_ID_HEADER]).toMatch(/^[0-9a-f-]+$/i);
        });
    });

    it("should reject and replace oversized correlation ID", () => {
      const oversizedId = "a".repeat(65);
      return request(app.getHttpServer())
        .get("/test")
        .set(CORRELATION_ID_HEADER, oversizedId)
        .expect(200)
        .expect((res) => {
          expect(res.headers[CORRELATION_ID_HEADER]).not.toBe(oversizedId);
          expect(res.headers[CORRELATION_ID_HEADER].length).toBeLessThanOrEqual(
            64,
          );
        });
    });

    it("should reject correlation ID with invalid characters", () => {
      const invalidId = "request/123@456";
      return request(app.getHttpServer())
        .get("/test")
        .set(CORRELATION_ID_HEADER, invalidId)
        .expect(200)
        .expect((res) => {
          expect(res.headers[CORRELATION_ID_HEADER]).not.toBe(invalidId);
          expect(res.headers[CORRELATION_ID_HEADER]).toMatch(/^[A-Za-z0-9_-]+$/);
        });
    });

    it("should reject empty correlation ID", () => {
      return request(app.getHttpServer())
        .get("/test")
        .set(CORRELATION_ID_HEADER, "")
        .expect(200)
        .expect((res) => {
          expect(res.headers[CORRELATION_ID_HEADER]).not.toBe("");
          expect(res.headers[CORRELATION_ID_HEADER]).toMatch(/^[0-9a-f-]+$/i);
        });
    });
  });

  describe("Authorization Path", () => {
    it("should preserve correlation ID through auth flow", () => {
      const correlationId = "auth-request-123";
      return request(app.getHttpServer())
        .get("/test/protected")
        .set(CORRELATION_ID_HEADER, correlationId)
        .expect(200)
        .expect((res) => {
          expect(res.headers[CORRELATION_ID_HEADER]).toBe(correlationId);
          expect(res.body.correlationId).toBe(correlationId);
        });
    });

    it("should track correlation through multiple middleware layers", () => {
      const correlationId = "multi-layer-456";
      return request(app.getHttpServer())
        .post("/test/multi-layer")
        .set(CORRELATION_ID_HEADER, correlationId)
        .send({ data: "test" })
        .expect(201)
        .expect((res) => {
          expect(res.headers[CORRELATION_ID_HEADER]).toBe(correlationId);
          expect(res.body.correlationId).toBe(correlationId);
        });
    });
  });

  describe("Retry Path", () => {
    it("should preserve correlation ID in retry metadata", async () => {
      const correlationId = "retry-request-789";
      await runWithCorrelation(correlationId, async () => {
        const currentId = getCorrelationId();
        expect(currentId).toBe(correlationId);

        // Simulate retry operation scheduling
        const retryMetadata = {
          operationId: "op-123",
          correlationId: getCorrelationId(),
        };

        expect(retryMetadata.correlationId).toBe(correlationId);
      });
    });

    it("should maintain correlation across async boundaries", async () => {
      const correlationId = "async-boundary-123";
      await runWithCorrelation(correlationId, async () => {
        const id1 = getCorrelationId();
        expect(id1).toBe(correlationId);

        await Promise.resolve();

        const id2 = getCorrelationId();
        expect(id2).toBe(correlationId);

        await new Promise((resolve) => setTimeout(resolve, 10));

        const id3 = getCorrelationId();
        expect(id3).toBe(correlationId);
      });
    });
  });

  describe("Background Job Path", () => {
    it("should stamp correlation ID on job payload", async () => {
      const correlationId = "job-request-456";
      await runWithCorrelation(correlationId, async () => {
        const jobPayload = withJobCorrelation({
          action: "process",
          data: { id: 123 },
        });

        expect(jobPayload._correlationId).toBe(correlationId);
        expect(jobPayload.action).toBe("process");
        expect(jobPayload.data).toEqual({ id: 123 });
      });
    });

    it("should run job handler in correlation context", async () => {
      const correlationId = "job-worker-789";
      const jobData = {
        _correlationId: correlationId,
        action: "test",
      };

      const result = await runJobWithCorrelation(jobData, (id) => {
        expect(id).toBe(correlationId);
        expect(getCorrelationId()).toBe(correlationId);
        return { success: true, correlationId: getCorrelationId() };
      });

      expect(result.correlationId).toBe(correlationId);
    });

    it("should generate new correlation ID for job without stamp", async () => {
      const jobData = { action: "test" }; // No _correlationId

      const result = await runJobWithCorrelation(jobData, (id) => {
        expect(id).toMatch(/^[0-9a-f-]+$/i);
        expect(getCorrelationId()).toBe(id);
        return { correlationId: id };
      });

      expect(result.correlationId).toMatch(/^[0-9a-f-]+$/i);
    });
  });

  describe("Contract-Derived Correlation", () => {
    it("should derive valid contract correlation ID", () => {
      const rootId = "api-request-123";
      const contractId = "contract-xyz";

      const derivedId = deriveContractCorrelationId(contractId, rootId);

      expect(derivedId).toBeTruthy();
      expect(derivedId).toMatch(/^c-[0-9a-f]{32}$/);
      expect(normalizeCorrelationId(derivedId)).toBe(derivedId);
    });

    it("should return null for invalid inputs", () => {
      expect(deriveContractCorrelationId("", "valid-id")).toBeNull();
      expect(deriveContractCorrelationId("contract", "")).toBeNull();
      expect(deriveContractCorrelationId("@invalid", "valid")).toBeNull();
    });

    it("should derive consistent ID for same inputs", () => {
      const id1 = deriveContractCorrelationId("contract-1", "root-1");
      const id2 = deriveContractCorrelationId("contract-1", "root-1");
      expect(id1).toBe(id2);
    });

    it("should derive different IDs for different inputs", () => {
      const id1 = deriveContractCorrelationId("contract-1", "root-1");
      const id2 = deriveContractCorrelationId("contract-2", "root-1");
      const id3 = deriveContractCorrelationId("contract-1", "root-2");

      expect(id1).not.toBe(id2);
      expect(id1).not.toBe(id3);
      expect(id2).not.toBe(id3);
    });
  });

  describe("Nested Context Operations", () => {
    it("should maintain outer correlation in nested contexts", async () => {
      const outerId = "outer-123";
      await runWithCorrelation(outerId, async () => {
        expect(getCorrelationId()).toBe(outerId);

        const nestedResult = await runWithCorrelation("inner-456", async () => {
          expect(getCorrelationId()).toBe("inner-456");
          return "nested";
        });

        expect(nestedResult).toBe("nested");
        expect(getCorrelationId()).toBe(outerId);
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle array value in header", () => {
      const ids = ["id-1", "id-2"];
      const normalized = normalizeCorrelationId(ids);
      expect(normalized).toBe("id-1"); // Takes first element
    });

    it("should handle whitespace in correlation ID", () => {
      const idWithSpaces = "  valid-id-123  ";
      const normalized = normalizeCorrelationId(idWithSpaces);
      expect(normalized).toBe("valid-id-123");
    });

    it("should reject correlation ID at exact max length + 1", () => {
      const atMax = "a".repeat(64);
      const overMax = "a".repeat(65);

      expect(normalizeCorrelationId(atMax)).toBe(atMax);
      expect(normalizeCorrelationId(overMax)).toBeNull();
    });

    it("should handle non-string values gracefully", () => {
      expect(normalizeCorrelationId(null)).toBeNull();
      expect(normalizeCorrelationId(undefined)).toBeNull();
      expect(normalizeCorrelationId(123 as any)).toBeNull();
      expect(normalizeCorrelationId({} as any)).toBeNull();
    });
  });
});

// Test Controller
import { Controller, Get, Post, Body } from "@nestjs/common";

@Controller("test")
class TestController {
  @Get()
  async testGet() {
    return {
      correlationId: getCorrelationId(),
      message: "Test response",
    };
  }

  @Get("protected")
  async testProtected() {
    return {
      correlationId: getCorrelationId(),
      message: "Protected response",
    };
  }

  @Post("multi-layer")
  async testMultiLayer(@Body() body: any) {
    return {
      correlationId: getCorrelationId(),
      message: "Multi-layer response",
      body,
    };
  }
}

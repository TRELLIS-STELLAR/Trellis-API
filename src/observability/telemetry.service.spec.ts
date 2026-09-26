import { TelemetryService } from "./telemetry.service";
import { Telemetry } from "./telemetry.decorator";
import {
  businessOperationDuration,
  businessOperationTotal,
  businessFailureTotal,
  conversionFunnelTotal,
} from "../monitoring/monitoring.metrics";

describe("TelemetryService & @Telemetry", () => {
  let service: TelemetryService;

  beforeEach(() => {
    service = new TelemetryService();
  });

  describe("maskSensitiveData", () => {
    it("should mask sensitive keys in nested objects", () => {
      const input = {
        userId: "usr_123",
        password: "SuperSecretPassword123!",
        secret: "my-vault-secret",
        seed: "twelve words mnemonic seed phrase here",
        privateKey: "0x1234567890abcdef",
        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M",
        profile: {
          email: "user@example.com",
          apiKey: "sk_live_123456789",
          nested: {
            authorization: "Bearer secret-token",
          },
        },
      };

      const sanitized: any = service.maskSensitiveData(input);

      expect(sanitized.userId).toBe("usr_123");
      expect(sanitized.password).toBe("[REDACTED]");
      expect(sanitized.secret).toBe("[REDACTED]");
      expect(sanitized.seed).toBe("[REDACTED]");
      expect(sanitized.privateKey).toBe("[REDACTED]");
      expect(sanitized.token).toBe("[REDACTED]");
      expect(sanitized.profile.email).toBe("user@example.com");
      expect(sanitized.profile.apiKey).toBe("[REDACTED]");
      expect(sanitized.profile.nested.authorization).toBe("[REDACTED]");
    });

    it("should mask JWTs and Stellar private keys inside string values", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgN_b_error_token_payload";
      const stellarSecret = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3UM6OH4XA7QXIF4DOWSBOIS";

      const text = `User authenticated with ${jwt} and key ${stellarSecret}`;
      const sanitized = service.maskSensitiveData(text);

      expect(sanitized).toContain("[REDACTED_JWT]");
      expect(sanitized).toContain("[REDACTED_STELLAR_SECRET]");
      expect(sanitized).not.toContain(stellarSecret);
    });

    it("should leave null, undefined, and non-sensitive values unchanged", () => {
      expect(service.maskSensitiveData(null)).toBeNull();
      expect(service.maskSensitiveData(undefined)).toBeUndefined();
      expect(service.maskSensitiveData(42)).toBe(42);
      expect(service.maskSensitiveData("safe-text")).toBe("safe-text");
    });
  });

  describe("recordOperation", () => {
    it("should record a successful operation with standardized fields", () => {
      const durationSpy = jest.spyOn(businessOperationDuration, "labels");
      const totalSpy = jest.spyOn(businessOperationTotal, "labels");

      const event = service.recordOperation({
        operation: "wallet.authenticate",
        actorType: "user",
        result: "success",
        latencyMs: 45.2,
        correlationId: "corr-1234",
        funnel: "auth_onboarding",
        step: "wallet_verify",
        metadata: { client: "web" },
      });

      expect(event.operation).toBe("wallet.authenticate");
      expect(event.actor_type).toBe("user");
      expect(event.result).toBe("success");
      expect(event.latency_ms).toBe(45.2);
      expect(event.correlation_id).toBe("corr-1234");
      expect(event.timestamp).toBeDefined();
      expect(event.metadata).toEqual({ client: "web" });

      expect(durationSpy).toHaveBeenCalledWith(
        "wallet.authenticate",
        "user",
        "success",
      );
      expect(totalSpy).toHaveBeenCalledWith(
        "wallet.authenticate",
        "user",
        "success",
      );
    });

    it("should record a failed operation and increment failure total by error code", () => {
      const failureSpy = jest.spyOn(businessFailureTotal, "labels");
      const funnelSpy = jest.spyOn(conversionFunnelTotal, "labels");

      const event = service.recordOperation({
        operation: "payment.process",
        actorType: "user",
        result: "failure",
        latencyMs: 120.5,
        errorCode: "INSUFFICIENT_FUNDS",
        funnel: "payment_settlement",
        step: "payment_submit",
      });

      expect(event.result).toBe("failure");
      expect(event.error_code).toBe("INSUFFICIENT_FUNDS");

      expect(failureSpy).toHaveBeenCalledWith(
        "payment.process",
        "user",
        "INSUFFICIENT_FUNDS",
      );
      expect(funnelSpy).toHaveBeenCalledWith(
        "payment_settlement",
        "payment_submit",
        "failed",
      );
    });
  });

  describe("recordFunnelStep", () => {
    it("should update conversion funnel metric with step status", () => {
      const funnelSpy = jest.spyOn(conversionFunnelTotal, "labels");

      service.recordFunnelStep(
        "payment_settlement",
        "reconciliation_match",
        "completed",
        { invoiceId: "inv_123" },
      );

      expect(funnelSpy).toHaveBeenCalledWith(
        "payment_settlement",
        "reconciliation_match",
        "completed",
      );
    });
  });

  describe("startTimer", () => {
    it("should measure operation latency and return telemetry event", async () => {
      const endTimer = service.startTimer("portfolio.optimize", {
        actorType: "user",
        funnel: "portfolio_management",
        step: "portfolio_optimize",
      });

      await new Promise((r) => setTimeout(r, 10));

      const event = endTimer("success", undefined, { strategy: "max_sharpe" });

      expect(event.operation).toBe("portfolio.optimize");
      expect(event.result).toBe("success");
      expect(event.latency_ms).toBeGreaterThanOrEqual(5);
    });
  });

  describe("@Telemetry decorator", () => {
    class TestService {
      @Telemetry({
        operation: "test.operation",
        actorType: "test_actor",
        funnel: "test_funnel",
        step: "step_1",
      })
      async successfulMethod(req?: any) {
        return { ok: true };
      }

      @Telemetry({
        operation: "test.failing_operation",
        actorType: "test_actor",
      })
      async failingMethod(req?: any) {
        const err: any = new Error("Simulated failure");
        err.errorCode = "CUSTOM_FAILURE_CODE";
        throw err;
      }
    }

    it("should instrument successful method and capture correlation ID from request", async () => {
      const instance = new TestService();
      const mockReq = {
        headers: { "x-correlation-id": "req-corr-999" },
        user: { role: "operator" },
      };

      const result = await instance.successfulMethod(mockReq);
      expect(result).toEqual({ ok: true });
    });

    it("should capture error code and record failure on exception", async () => {
      const instance = new TestService();
      await expect(instance.failingMethod()).rejects.toThrow("Simulated failure");
    });
  });
});

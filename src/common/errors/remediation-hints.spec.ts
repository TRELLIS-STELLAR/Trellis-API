import { ErrorCode, ErrorDomain } from "./error-codes";
import { REMEDIATION_HINTS, getRemediationHint, RemediationHint } from "./remediation-hints";

describe("Stable Error Codes & Documented Remediation Hints", () => {
  it("should have a documented remediation hint for every ErrorCode in the catalog", () => {
    const errorCodes = Object.values(ErrorCode);

    for (const code of errorCodes) {
      const hint = REMEDIATION_HINTS[code];
      expect(hint).toBeDefined();
      expect(hint.action.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(hint.steps)).toBe(true);
      expect(hint.steps.length).toBeGreaterThan(0);
      expect(hint.docUrl).toContain(`https://trellis-stellar.github.io/Trellis-API/problems/${code}`);
      expect(typeof hint.retryable).toBe("boolean");

      if (hint.retryable && hint.retryAfterSeconds !== undefined) {
        expect(hint.retryAfterSeconds).toBeGreaterThan(0);
      }
    }
  });

  describe("Specific Error Path Verification", () => {
    it("should provide actionable remediation for authorization failures (UNAUTHORIZED & FORBIDDEN)", () => {
      const unauthHint = getRemediationHint(ErrorCode.UNAUTHORIZED, "corr-auth-1");
      expect(unauthHint.action).toContain("Provide valid authentication");
      expect(unauthHint.steps.some((s) => s.includes("Bearer token"))).toBe(true);
      expect(unauthHint.retryable).toBe(false);
      expect(unauthHint.supportReference).toBe("corr-auth-1");

      const forbiddenHint = getRemediationHint(ErrorCode.FORBIDDEN, "corr-auth-2");
      expect(forbiddenHint.action).toContain("Request required roles or permissions");
      expect(forbiddenHint.steps.some((s) => s.includes("permissions/my-permissions"))).toBe(true);
      expect(forbiddenHint.retryable).toBe(false);
    });

    it("should provide retry guidance and cool-off durations for retryable errors (RATE_LIMITED & SERVICE_UNAVAILABLE)", () => {
      const rateLimitHint = getRemediationHint(ErrorCode.RATE_LIMITED, "corr-rate-1");
      expect(rateLimitHint.retryable).toBe(true);
      expect(rateLimitHint.retryAfterSeconds).toBe(60);
      expect(rateLimitHint.steps.some((s) => s.includes("retryAfterSeconds"))).toBe(true);

      const serviceUnavailableHint = getRemediationHint(ErrorCode.SERVICE_UNAVAILABLE);
      expect(serviceUnavailableHint.retryable).toBe(true);
      expect(serviceUnavailableHint.retryAfterSeconds).toBe(30);
      expect(serviceUnavailableHint.steps.some((s) => s.includes("exponential backoff"))).toBe(true);
    });

    it("should provide validation guidance for malformed requests (VALIDATION_ERROR & MALFORMED_PAYLOAD)", () => {
      const valHint = getRemediationHint(ErrorCode.VALIDATION_ERROR);
      expect(valHint.retryable).toBe(false);
      expect(valHint.steps.some((s) => s.includes("errors"))).toBe(true);

      const malformedHint = getRemediationHint(ErrorCode.MALFORMED_PAYLOAD);
      expect(malformedHint.retryable).toBe(false);
      expect(malformedHint.steps.some((s) => s.includes("JSON"))).toBe(true);
    });

    it("should provide blockchain recovery guidance (SETTLEMENT_TIMEOUT & STELLAR_NETWORK_ERROR)", () => {
      const settlementTimeout = getRemediationHint(ErrorCode.SETTLEMENT_TIMEOUT);
      expect(settlementTimeout.retryable).toBe(true);
      expect(settlementTimeout.steps.some((s) => s.includes("Stellar Horizon"))).toBe(true);

      const stellarNet = getRemediationHint(ErrorCode.STELLAR_NETWORK_ERROR);
      expect(stellarNet.retryable).toBe(true);
      expect(stellarNet.retryAfterSeconds).toBe(10);
    });
  });

  describe("Fallback Behavior", () => {
    it("should return a safe default hint if an unknown code is queried", () => {
      const fallback = getRemediationHint("UNKNOWN_CUSTOM_CODE" as any, "trace-999");
      expect(fallback.action).toBeDefined();
      expect(fallback.docUrl).toBe("https://trellis-stellar.github.io/Trellis-API/problems/UNKNOWN_CUSTOM_CODE");
      expect(fallback.supportReference).toBe("trace-999");
      expect(fallback.retryable).toBe(false);
    });
  });
});

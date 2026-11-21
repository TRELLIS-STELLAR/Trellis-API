import { HttpStatus } from "@nestjs/common";
import { ErrorCode, ErrorDomain } from "./error-codes";
import {
  ERROR_TAXONOMY,
  getErrorTaxonomy,
  getProblemType,
  createProblemDetailsResponse,
  sanitizeClientMessage,
} from "./error-taxonomy";

describe("Problem Details Error Taxonomy & Contracts (#483)", () => {
  describe("Normal Path", () => {
    it("generates an RFC 7807 compliant problem details response", () => {
      const problem = createProblemDetailsResponse({
        errorCode: ErrorCode.VALIDATION_ERROR,
        status: HttpStatus.BAD_REQUEST,
        detail: "Input validation failed: 'amount' must be positive",
        instance: "/api/orders",
        correlationId: "corr-test-123",
      });

      expect(problem.type).toBe(
        "https://trellis-stellar.github.io/Trellis-API/problems/VALIDATION_ERROR",
      );
      expect(problem.title).toBe("Request validation failed");
      expect(problem.status).toBe(HttpStatus.BAD_REQUEST);
      expect(problem.detail).toBe(
        "Input validation failed: 'amount' must be positive",
      );
      expect(problem.instance).toBe("/api/orders");
      expect(problem.remediation).toBeDefined();
      expect(problem.domain).toBe(ErrorDomain.VALIDATION);
      expect(problem.retryable).toBe(false);
      expect(problem.correlationId).toBe("corr-test-123");
      expect(problem.timestamp).toBeDefined();
    });

    it("maps all 54 public ErrorCode values to unique valid taxonomy entries", () => {
      const codes = Object.values(ErrorCode);
      expect(codes.length).toBe(54);

      for (const code of codes) {
        const taxonomy = getErrorTaxonomy(code);
        expect(taxonomy).toBeDefined();
        expect(taxonomy.defaultMessage.length).toBeGreaterThan(0);
        expect(taxonomy.recoveryGuidance.length).toBeGreaterThan(0);
        expect(taxonomy.domain).toBeDefined();
        expect(typeof taxonomy.retryable).toBe("boolean");
        expect(taxonomy.userSafe).toBe(true);

        const problemType = getProblemType(code);
        expect(problemType).toContain(`/problems/${code}`);
      }
    });
  });

  describe("Failure Path", () => {
    it("falls back gracefully for unknown or unmapped error codes", () => {
      const unknownTaxonomy = getErrorTaxonomy("NON_EXISTENT_CODE" as any);

      expect(unknownTaxonomy).toBeDefined();
      expect(unknownTaxonomy.domain).toBe(ErrorDomain.SYSTEM);
      expect(unknownTaxonomy.retryable).toBe(false);
      expect(unknownTaxonomy.retryStrategy).toBe("none");
      expect(unknownTaxonomy.defaultMessage).toBe(
        "An internal server error occurred",
      );
      expect(unknownTaxonomy.userSafe).toBe(true);

      const problem = createProblemDetailsResponse({
        errorCode: "UNKNOWN" as any,
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });

      expect(problem.status).toBe(500);
      expect(problem.title).toBe("An internal server error occurred");
    });
  });

  describe("Retry Path", () => {
    it("enforces retryable flag and retryAfterSeconds contracts on transient system & network errors", () => {
      const retryableCodes = [
        ErrorCode.SERVICE_UNAVAILABLE,
        ErrorCode.DATABASE_ERROR,
        ErrorCode.DEPENDENCY_TIMEOUT,
        ErrorCode.RATE_LIMITED,
        ErrorCode.SETTLEMENT_TIMEOUT,
        ErrorCode.TRANSACTION_UNCONFIRMED,
        ErrorCode.STELLAR_NETWORK_ERROR,
        ErrorCode.HORIZON_TIMEOUT,
        ErrorCode.OPTIMIZATION_FAILED,
        ErrorCode.IMPORT_COMMIT_FAILED,
        ErrorCode.IMPORT_ROLLBACK_FAILED,
        ErrorCode.IMPORT_RETRY_FAILED,
      ];

      for (const code of retryableCodes) {
        const entry = ERROR_TAXONOMY[code];
        expect(entry.retryable).toBe(true);
        expect(entry.retryAfterSeconds).toBeGreaterThan(0);
        expect(["immediate", "exponential_backoff"]).toContain(
          entry.retryStrategy,
        );

        const problem = createProblemDetailsResponse({
          errorCode: code,
          status: HttpStatus.SERVICE_UNAVAILABLE,
        });
        expect(problem.retryable).toBe(true);
        expect(problem.retryAfterSeconds).toBe(entry.retryAfterSeconds);
      }
    });

    it("ensures non-retryable errors have retryable=false and retryStrategy=none", () => {
      const nonRetryableCodes = [
        ErrorCode.UNAUTHORIZED,
        ErrorCode.FORBIDDEN,
        ErrorCode.ACCOUNT_LOCKED,
        ErrorCode.INVALID_PARAMETER,
        ErrorCode.VALIDATION_ERROR,
        ErrorCode.IMPORT_NOT_FOUND,
        ErrorCode.IMPORT_ROW_INVALID,
      ];

      for (const code of nonRetryableCodes) {
        const entry = ERROR_TAXONOMY[code];
        expect(entry.retryable).toBe(false);
        expect(entry.retryStrategy).toBe("none");
        expect(entry.retryAfterSeconds).toBeUndefined();
      }
    });
  });

  describe("Authorization Path", () => {
    it("returns standard problem details for UNAUTHORIZED and FORBIDDEN", () => {
      const unauth = createProblemDetailsResponse({
        errorCode: ErrorCode.UNAUTHORIZED,
        status: HttpStatus.UNAUTHORIZED,
        instance: "/auth/session",
      });
      expect(unauth.status).toBe(401);
      expect(unauth.errorCode).toBe(ErrorCode.UNAUTHORIZED);
      expect(unauth.domain).toBe(ErrorDomain.AUTH);
      expect(unauth.retryable).toBe(false);

      const forbidden = createProblemDetailsResponse({
        errorCode: ErrorCode.FORBIDDEN,
        status: HttpStatus.FORBIDDEN,
        instance: "/admin/policies",
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.errorCode).toBe(ErrorCode.FORBIDDEN);
      expect(forbidden.domain).toBe(ErrorDomain.AUTH);
      expect(forbidden.retryable).toBe(false);
    });

    it("handles client message sanitization correctly in production and non-production", () => {
      const msg = "Invalid parameter: userId cannot be null";
      const sanitizedProd = sanitizeClientMessage(
        msg,
        true,
        ErrorCode.INVALID_PARAMETER,
      );
      expect(sanitizedProd).toBe(msg);

      const objMsg = { error: "detail" };
      expect(sanitizeClientMessage(objMsg, true, ErrorCode.INVALID_PARAMETER)).toBe(objMsg);
    });
  });
});

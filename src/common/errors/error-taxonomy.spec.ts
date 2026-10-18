import { ErrorCode } from "./error-codes";
import { ERROR_TAXONOMY, getProblemType } from "./error-taxonomy";

describe("Problem Details error contract", () => {
  it("keeps the public machine-readable error code catalog stable", () => {
    expect(Object.values(ErrorCode).sort()).toEqual(
      [
        "ACCOUNT_LOCKED",
        "ASSET_UNSUPPORTED",
        "CONFLICT",
        "DATABASE_ERROR",
        "DEPENDENCY_TIMEOUT",
        "DUPLICATE_ENTRY",
        "DUPLICATE_PAYMENT_SUBMISSION",
        "FORBIDDEN",
        "HORIZON_TIMEOUT",
        "INSUFFICIENT_FUNDS",
        "INTERNAL_ERROR",
        "INVALID_CREDENTIALS",
        "INVALID_PARAMETER",
        "INVALID_TRANSACTION_ENVELOPE",
        "INVOICE_NOT_FOUND",
        "MALFORMED_PAYLOAD",
        "NONCE_EXPIRED",
        "NOT_FOUND",
        "OPTIMIZATION_FAILED",
        "ORACLE_VERIFICATION_FAILED",
        "PAYMENT_FAILED",
        "PAYMENT_METHOD_UNSUPPORTED",
        "PORTFOLIO_NOT_FOUND",
        "PRECONDITION_FAILED",
        "QUOTA_EXCEEDED",
        "RATE_LIMITED",
        "RECONCILIATION_MISMATCH",
        "RESOURCE_NOT_FOUND",
        "RISK_LIMIT_EXCEEDED",
        "SERVICE_UNAVAILABLE",
        "SESSION_TERMINATED",
        "SETTLEMENT_FAILED",
        "SETTLEMENT_TIMEOUT",
        "STELLAR_NETWORK_ERROR",
        "TOKEN_EXPIRED",
        "TRANSACTION_UNCONFIRMED",
        "UNAUTHORIZED",
        "VALIDATION_ERROR",
      ].sort(),
    );
  });

  it("provides a safe title and remediation for every public code", () => {
    for (const code of Object.values(ErrorCode)) {
      const entry = ERROR_TAXONOMY[code];

      expect(entry.defaultMessage.trim()).not.toBe("");
      expect(entry.recoveryGuidance.trim()).not.toBe("");
      expect(entry.userSafe).toBe(true);
    }
  });

  it("maps error codes to stable problem type identifiers", () => {
    expect(getProblemType(ErrorCode.INVALID_PARAMETER)).toBe(
      "https://trellis-stellar.github.io/Trellis-API/problems/INVALID_PARAMETER",
    );
  });
});
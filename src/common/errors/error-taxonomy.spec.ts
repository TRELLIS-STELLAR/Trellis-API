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
        "IMPORT_COMMIT_FAILED",
        "IMPORT_FORMAT_UNSUPPORTED",
        "IMPORT_IDEMPOTENCY_CONFLICT",
        "IMPORT_IDEMPOTENCY_KEY_REQUIRED",
        "IMPORT_LIMIT_EXCEEDED",
        "IMPORT_NOT_FOUND",
        "IMPORT_PREVIEW_ALREADY_COMMITTED",
        "IMPORT_PREVIEW_EXPIRED",
        "IMPORT_PREVIEW_NOT_FOUND",
        "IMPORT_RETRY_FAILED",
        "IMPORT_ROLLBACK_FAILED",
        "IMPORT_ROLLBACK_NOT_POSSIBLE",
        "IMPORT_ROWS_QUARANTINED",
        "IMPORT_ROW_DUPLICATE",
        "IMPORT_ROW_INVALID",
        "IMPORT_ROW_UNSAFE",
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
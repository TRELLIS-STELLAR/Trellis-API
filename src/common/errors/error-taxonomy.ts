import { ErrorCode, ErrorDomain } from "./error-codes";

export interface ErrorTaxonomyEntry {
  domain: ErrorDomain;
  retryable: boolean;
  retryAfterSeconds?: number;
  retryStrategy: "immediate" | "exponential_backoff" | "none";
  defaultMessage: string;
  recoveryGuidance: string;
  userSafe: boolean;
}

const PROBLEM_TYPE_BASE_URL =
  "https://trellis-stellar.github.io/Trellis-API/problems";

export function getProblemType(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE_URL}/${code}`;
}

export const ERROR_TAXONOMY: Record<ErrorCode, ErrorTaxonomyEntry> = {
  // Generic & System
  [ErrorCode.INTERNAL_ERROR]: {
    domain: ErrorDomain.SYSTEM,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "An internal server error occurred",
    recoveryGuidance:
      "Please quote the correlationId when contacting support or try again later.",
    userSafe: true,
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    domain: ErrorDomain.SYSTEM,
    retryable: true,
    retryAfterSeconds: 30,
    retryStrategy: "exponential_backoff",
    defaultMessage: "Service temporarily unavailable",
    recoveryGuidance:
      "The service is temporarily undergoing maintenance or degraded. Please retry in a few moments.",
    userSafe: true,
  },
  [ErrorCode.DATABASE_ERROR]: {
    domain: ErrorDomain.SYSTEM,
    retryable: true,
    retryAfterSeconds: 5,
    retryStrategy: "exponential_backoff",
    defaultMessage: "A database error occurred",
    recoveryGuidance:
      "Database operation failed. If the problem persists, contact technical support.",
    userSafe: true,
  },
  [ErrorCode.DEPENDENCY_TIMEOUT]: {
    domain: ErrorDomain.SYSTEM,
    retryable: true,
    retryAfterSeconds: 5,
    retryStrategy: "exponential_backoff",
    defaultMessage: "Upstream dependency request timed out",
    recoveryGuidance:
      "An upstream service did not respond in time. Please retry with exponential backoff.",
    userSafe: true,
  },
  [ErrorCode.NOT_FOUND]: {
    domain: ErrorDomain.SYSTEM,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Resource not found",
    recoveryGuidance:
      "Verify the URL path and resource identifier specified in the request.",
    userSafe: true,
  },
  [ErrorCode.RATE_LIMITED]: {
    domain: ErrorDomain.RATE_LIMIT,
    retryable: true,
    retryAfterSeconds: 60,
    retryStrategy: "exponential_backoff",
    defaultMessage: "Rate limit exceeded",
    recoveryGuidance:
      "Too many requests. Please throttle your client requests and retry after the specified window.",
    userSafe: true,
  },
  [ErrorCode.QUOTA_EXCEEDED]: {
    domain: ErrorDomain.QUOTA,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Quota exceeded",
    recoveryGuidance:
      "Review current quota and usage, then wait for the quota to reset or request an increase.",
    userSafe: true,
  },

  // Validation
  [ErrorCode.VALIDATION_ERROR]: {
    domain: ErrorDomain.VALIDATION,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Request validation failed",
    recoveryGuidance:
      "Review the request body and address validation constraints in the 'errors' object.",
    userSafe: true,
  },
  [ErrorCode.INVALID_PARAMETER]: {
    domain: ErrorDomain.VALIDATION,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Invalid request parameter supplied",
    recoveryGuidance:
      "Ensure query parameters and path arguments conform to the expected format.",
    userSafe: true,
  },
  [ErrorCode.MALFORMED_PAYLOAD]: {
    domain: ErrorDomain.VALIDATION,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Malformed request payload",
    recoveryGuidance: "Ensure the request body contains valid JSON matching the API schema.",
    userSafe: true,
  },
  [ErrorCode.PRECONDITION_FAILED]: {
    domain: ErrorDomain.VALIDATION,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Precondition failed",
    recoveryGuidance:
      "The resource state changed or prerequisites were not met. Refresh resource state and retry.",
    userSafe: true,
  },

  // Auth & RBAC
  [ErrorCode.UNAUTHORIZED]: {
    domain: ErrorDomain.AUTH,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Authentication required",
    recoveryGuidance:
      "Provide a valid Bearer token in the Authorization header or sign in again.",
    userSafe: true,
  },
  [ErrorCode.FORBIDDEN]: {
    domain: ErrorDomain.AUTH,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Access forbidden: insufficient permissions",
    recoveryGuidance:
      "Your account lacks the role or permissions required to perform this action.",
    userSafe: true,
  },
  [ErrorCode.TOKEN_EXPIRED]: {
    domain: ErrorDomain.AUTH,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Authentication token has expired",
    recoveryGuidance:
      "Refresh your session using your refresh token or re-authenticate via /auth/login.",
    userSafe: true,
  },
  [ErrorCode.INVALID_CREDENTIALS]: {
    domain: ErrorDomain.AUTH,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Invalid credentials provided",
    recoveryGuidance:
      "Verify your email, password, or wallet signature and try again.",
    userSafe: true,
  },
  [ErrorCode.ACCOUNT_LOCKED]: {
    domain: ErrorDomain.AUTH,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Account has been locked",
    recoveryGuidance:
      "Account locked due to security policy or excessive failed attempts. Contact an administrator.",
    userSafe: true,
  },
  [ErrorCode.SESSION_TERMINATED]: {
    domain: ErrorDomain.AUTH,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Session terminated",
    recoveryGuidance: "Log in again to establish a new active session.",
    userSafe: true,
  },

  // Settlement & Payment
  [ErrorCode.SETTLEMENT_FAILED]: {
    domain: ErrorDomain.SETTLEMENT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Stellar settlement execution failed",
    recoveryGuidance:
      "Review transaction parameters, destination address, and escrow conditions.",
    userSafe: true,
  },
  [ErrorCode.SETTLEMENT_TIMEOUT]: {
    domain: ErrorDomain.SETTLEMENT,
    retryable: true,
    retryAfterSeconds: 5,
    retryStrategy: "exponential_backoff",
    defaultMessage: "Settlement confirmation timed out on network",
    recoveryGuidance:
      "The payment was submitted to Stellar Horizon but confirmation timed out. Verify transaction status before resubmitting.",
    userSafe: true,
  },
  [ErrorCode.INSUFFICIENT_FUNDS]: {
    domain: ErrorDomain.SETTLEMENT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Insufficient funds for payment",
    recoveryGuidance:
      "Ensure the source wallet holds sufficient balance for both the payment amount and Stellar network fees.",
    userSafe: true,
  },
  [ErrorCode.PAYMENT_FAILED]: {
    domain: ErrorDomain.PAYMENT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Payment processing failed",
    recoveryGuidance:
      "Payment gateway rejected the transaction. Verify payment method details.",
    userSafe: true,
  },
  [ErrorCode.DUPLICATE_PAYMENT_SUBMISSION]: {
    domain: ErrorDomain.PAYMENT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Duplicate payment submission detected",
    recoveryGuidance:
      "This payment has already been submitted and processed. Do not double-submit.",
    userSafe: true,
  },
  [ErrorCode.PAYMENT_METHOD_UNSUPPORTED]: {
    domain: ErrorDomain.PAYMENT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Payment method not supported",
    recoveryGuidance: "Select an active and configured payment processor adapter.",
    userSafe: true,
  },

  // Reconciliation
  [ErrorCode.RECONCILIATION_MISMATCH]: {
    domain: ErrorDomain.RECONCILIATION,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Reconciliation mismatch detected",
    recoveryGuidance:
      "The on-chain transaction destination, asset, or memo does not match the internal invoice.",
    userSafe: true,
  },
  [ErrorCode.INVOICE_NOT_FOUND]: {
    domain: ErrorDomain.RECONCILIATION,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Reconciliation invoice not found",
    recoveryGuidance: "Verify the invoice ID referenced in the payment memo.",
    userSafe: true,
  },
  [ErrorCode.TRANSACTION_UNCONFIRMED]: {
    domain: ErrorDomain.RECONCILIATION,
    retryable: true,
    retryAfterSeconds: 10,
    retryStrategy: "exponential_backoff",
    defaultMessage: "Transaction not yet confirmed on ledger",
    recoveryGuidance:
      "Wait for the Stellar ledger close before re-attempting reconciliation ingestion.",
    userSafe: true,
  },

  // Blockchain / Stellar / Oracle
  [ErrorCode.STELLAR_NETWORK_ERROR]: {
    domain: ErrorDomain.BLOCKCHAIN,
    retryable: true,
    retryAfterSeconds: 5,
    retryStrategy: "exponential_backoff",
    defaultMessage: "Stellar Horizon network communication error",
    recoveryGuidance:
      "Stellar node communication failed. Retry after a short delay.",
    userSafe: true,
  },
  [ErrorCode.HORIZON_TIMEOUT]: {
    domain: ErrorDomain.BLOCKCHAIN,
    retryable: true,
    retryAfterSeconds: 5,
    retryStrategy: "exponential_backoff",
    defaultMessage: "Stellar Horizon server timed out",
    recoveryGuidance:
      "Horizon server took long to respond. Retry with exponential backoff.",
    userSafe: true,
  },
  [ErrorCode.INVALID_TRANSACTION_ENVELOPE]: {
    domain: ErrorDomain.BLOCKCHAIN,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Invalid CDR transaction envelope",
    recoveryGuidance:
      "Verify that the XDR transaction is properly formatted and signed for the current network passphrase.",
    userSafe: true,
  },
  [ErrorCode.NONCE_EXPIRED]: {
    domain: ErrorDomain.BLOCKCHAIN,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Submission nonce expired or reused",
    recoveryGuidance:
      "Request a fresh nonce before signing and submitting oracle or wallet payloads.",
    userSafe: true,
  },
  [ErrorCode.ORACLE_VERIFICATION_FAILED]: {
    domain: ErrorDomain.BLOCKCHAIN,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Oracle payload verification failed",
    recoveryGuidance:
      "Signature verification failed. Ensure payload was signed by a registered oracle signer.",
    userSafe: true,
  },

  // Portfolio & DeFi
  [ErrorCode.PORTFOLIO_NOT_FOUND]: {
    domain: ErrorDomain.PORTFOLIO,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Portfolio not found",
    recoveryGuidance: "Check portfolio ID and verify account ownership.",
    userSafe: true,
  },
  [ErrorCode.OPTIMIZATION_FAILED]: {
    domain: ErrorDomain.PORTFOLIO,
    retryable: true,
    retryAfterSeconds: 3,
    retryStrategy: "immediate",
    defaultMessage: "Portfolio optimization calculation failed",
    recoveryGuidance:
      "Optimization algorithm could not converge on feasible weights. Adjust risk constraints and retry.",
    userSafe: true,
  },
  [ErrorCode.RISK_LIMIT_EXCEEDED]: {
    domain: ErrorDomain.PORTFOLIO,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Operation exceeds defined risk threshold",
    recoveryGuidance:
      "Order size or volatility profile exceeds portfolio risk boundaries.",
    userSafe: true,
  },
  [ErrorCode.ASSET_UNSUPPORTED]: {
    domain: ErrorDomain.PORTFOLIO,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Asset unsupported for portfolio allocation",
    recoveryGuidance: "Select an asset with an active pricing feed and liquidity pool.",
    userSafe: true,
  },

  // Business Conflict
  [ErrorCode.CONFLICT]: {
    domain: ErrorDomain.SYSTEM,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Resource conflict",
    recoveryGuidance:
      "The request conflicts with the current state of the resource. Refresh and retry.",
    userSafe: true,
  },
  [ErrorCode.RESOURCE_NOT_FOUND]: {
    domain: ErrorDomain.SYSTEM,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Target resource not found",
    recoveryGuidance:
      "Verify resource identifier, tenancy context, or projection synchronization.",
    userSafe: true,
  },
  [ErrorCode.DUPLICATE_ENTRY]: {
    domain: ErrorDomain.SYSTEM,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Duplicate entry already exists",
    recoveryGuidance:
      "The resource or unique key already exists. Ensure uniqueness or perform an update.",
    userSafe: true,
  },

  // Import Pipeline
  [ErrorCode.IMPORT_NOT_FOUND]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Import job not found",
    recoveryGuidance: "Verify the import job ID and ensure it belongs to your account.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_PREVIEW_EXPIRED]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Import preview has expired",
    recoveryGuidance: "Generate a new import preview before committing the dataset.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_PREVIEW_NOT_FOUND]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Import preview not found",
    recoveryGuidance: "Run an import preview dry-run before attempting to commit.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_PREVIEW_ALREADY_COMMITTED]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Import preview already committed",
    recoveryGuidance: "This preview batch has already been committed and cannot be re-applied.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_ROWS_QUARANTINED]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Import rows quarantined due to validation errors",
    recoveryGuidance: "Review quarantined rows in the preview report and correct invalid entries.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_ROW_INVALID]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Invalid data row in import batch",
    recoveryGuidance: "Ensure all row fields conform to expected column types and constraints.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_ROW_DUPLICATE]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Duplicate row detected in import dataset",
    recoveryGuidance: "Remove or deduplicate redundant rows before committing the import.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_ROW_UNSAFE]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Unsafe or malicious content detected in import payload",
    recoveryGuidance: "Sanitize row content to remove disallowed scripts, tags, or unescaped characters.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_COMMIT_FAILED]: {
    domain: ErrorDomain.IMPORT,
    retryable: true,
    retryAfterSeconds: 5,
    retryStrategy: "exponential_backoff",
    defaultMessage: "Import commit failed",
    recoveryGuidance: "The commit operation encountered a transient failure. Retry the commit or initiate a rollback.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_ROLLBACK_FAILED]: {
    domain: ErrorDomain.IMPORT,
    retryable: true,
    retryAfterSeconds: 10,
    retryStrategy: "exponential_backoff",
    defaultMessage: "Import rollback failed",
    recoveryGuidance: "Rollback could not be completed. Retry the rollback or contact support with the import job ID and correlationId.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_ROLLBACK_NOT_POSSIBLE]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Import rollback is not possible in the current state",
    recoveryGuidance: "Only committed imports within the retention window can be rolled back.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_RETRY_FAILED]: {
    domain: ErrorDomain.IMPORT,
    retryable: true,
    retryAfterSeconds: 15,
    retryStrategy: "exponential_backoff",
    defaultMessage: "Import retry attempt failed",
    recoveryGuidance: "The retried operation did not succeed. Check upstream service status and try again.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_IDEMPOTENCY_KEY_REQUIRED]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Idempotency key required for import mutation",
    recoveryGuidance: "Supply an Idempotency-Key header with a unique request UUID.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_IDEMPOTENCY_CONFLICT]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Conflicting request payload with identical idempotency key",
    recoveryGuidance: "Use a fresh idempotency key for new payloads or reuse identical payload to fetch cached result.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_LIMIT_EXCEEDED]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Import batch size or row limit exceeded",
    recoveryGuidance: "Reduce batch size below maximum threshold (e.g. 10,000 rows) and resubmit in chunks.",
    userSafe: true,
  },
  [ErrorCode.IMPORT_FORMAT_UNSUPPORTED]: {
    domain: ErrorDomain.IMPORT,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Unsupported import file format",
    recoveryGuidance: "Provide data in supported formats: CSV, JSON, or Parquet.",
    userSafe: true,
  },
};

export interface ProblemDetailsPayload {
  type: string;
  title: string;
  status: number;
  detail: string | object;
  instance: string;
  remediation: string;
  errorCode: ErrorCode;
  domain: ErrorDomain;
  retryable: boolean;
  retryAfterSeconds?: number;
  correlationId?: string;
  timestamp: string;
}

export function createProblemDetailsResponse(options: {
  errorCode: ErrorCode;
  status: number;
  detail?: string | object;
  instance?: string;
  correlationId?: string;
}): ProblemDetailsPayload {
  const taxonomy = getErrorTaxonomy(options.errorCode);
  return {
    type: getProblemType(options.errorCode),
    title: taxonomy.defaultMessage,
    status: options.status,
    detail: options.detail ?? taxonomy.defaultMessage,
    instance: options.instance ?? "/api",
    remediation: taxonomy.recoveryGuidance,
    errorCode: options.errorCode,
    domain: taxonomy.domain,
    retryable: taxonomy.retryable,
    ...(taxonomy.retryAfterSeconds !== undefined && {
      retryAfterSeconds: taxonomy.retryAfterSeconds,
    }),
    ...(options.correlationId && { correlationId: options.correlationId }),
    timestamp: new Date().toISOString(),
  };
}

export function getErrorTaxonomy(code: ErrorCode): ErrorTaxonomyEntry {
  return (
    ERROR_TAXONOMY[code] ?? {
      domain: ErrorDomain.SYSTEM,
      retryable: false,
      retryStrategy: "none",
      defaultMessage: "An internal server error occurred",
      recoveryGuidance: "Please try again later or contact support.",
      userSafe: true,
    }
  );
}

export function sanitizeClientMessage(
  message: string | object,
  isProduction: boolean,
  code: ErrorCode,
): string | object {
  if (typeof message !== "string") {
    return message;
  }
  if (!isProduction) {
    return message;
  }
  const entry = ERROR_TAXONOMY[code];
  if (entry && !entry.userSafe) {
    return entry.defaultMessage;
  }
  return message;
}


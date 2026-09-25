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
      "Horizon server took too long to respond. Retry with exponential backoff.",
    userSafe: true,
  },
  [ErrorCode.INVALID_TRANSACTION_ENVELOPE]: {
    domain: ErrorDomain.BLOCKCHAIN,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Invalid XDR transaction envelope",
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
    defaultMessage: "Resource conflict occurred",
    recoveryGuidance:
      "Resource already exists or conflicting operation is currently in progress.",
    userSafe: true,
  },
  [ErrorCode.RESOURCE_NOT_FOUND]: {
    domain: ErrorDomain.SYSTEM,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Requested entity could not be found",
    recoveryGuidance: "Verify the resource key and current tenant context.",
    userSafe: true,
  },
  [ErrorCode.DUPLICATE_ENTRY]: {
    domain: ErrorDomain.SYSTEM,
    retryable: false,
    retryStrategy: "none",
    defaultMessage: "Duplicate entry already exists",
    recoveryGuidance: "Use a unique identifier or update the existing resource.",
    userSafe: true,
  },
};

/**
 * Retrieve taxonomy metadata for a given ErrorCode.
 */
export function getErrorTaxonomy(code: ErrorCode): ErrorTaxonomyEntry {
  return (
    ERROR_TAXONOMY[code] ?? {
      domain: ErrorDomain.SYSTEM,
      retryable: false,
      retryStrategy: "none",
      defaultMessage: "An unexpected error occurred",
      recoveryGuidance:
        "Please quote the correlationId when contacting support or try again later.",
      userSafe: true,
    }
  );
}

/**
 * Sanitizes an error message so that database connection strings, SQL statements,
 * and internal traces never leak to client responses.
 */
export function sanitizeClientMessage(
  rawMessage: unknown,
  isProduction: boolean,
  errorCode: ErrorCode,
): string {
  const taxonomy = getErrorTaxonomy(errorCode);

  if (typeof rawMessage !== "string" || !rawMessage.trim()) {
    return taxonomy.defaultMessage;
  }

  // Detect sensitive database / stack leaks
  const isLeakingInternal =
    /connection|postgres|select\s|insert\s|update\s|delete\s|from\s|where\s|pg_|typeorm|knex|at\s.*\:\d+/i.test(
      rawMessage,
    );

  if (isProduction && (isLeakingInternal || errorCode === ErrorCode.INTERNAL_ERROR)) {
    return taxonomy.defaultMessage;
  }

  return rawMessage;
}

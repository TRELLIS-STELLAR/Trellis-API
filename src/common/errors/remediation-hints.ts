import { ErrorCode, ErrorDomain } from "./error-codes";

export interface RemediationHint {
  action: string;
  steps: string[];
  docUrl: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  supportReference?: string;
}

const DOCS_BASE_URL = "https://trellis-stellar.github.io/Trellis-API/problems";

export const REMEDIATION_HINTS: Record<ErrorCode, RemediationHint> = {
  // Generic & System
  [ErrorCode.INTERNAL_ERROR]: {
    action: "Contact system support with correlation identifier",
    steps: [
      "Record the correlationId from the response header or body.",
      "Check Trellis status page at https://status.trellis.network for active incidents.",
      "If the issue persists, submit a support ticket referencing the correlationId.",
    ],
    docUrl: `${DOCS_BASE_URL}/INTERNAL_ERROR`,
    retryable: false,
    retryAfterSeconds: undefined,
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    action: "Wait for maintenance window or automated recovery",
    steps: [
      "Check if scheduled maintenance is in progress.",
      "Retry the request using exponential backoff with jitter.",
      "Do not hammer the endpoint with immediate concurrent requests.",
    ],
    docUrl: `${DOCS_BASE_URL}/SERVICE_UNAVAILABLE`,
    retryable: true,
    retryAfterSeconds: 30,
  },
  [ErrorCode.DATABASE_ERROR]: {
    action: "Retry after brief delay or verify database schema version",
    steps: [
      "Wait 5 seconds and retry the query.",
      "If the query continues to fail, check database replica connection pool health.",
    ],
    docUrl: `${DOCS_BASE_URL}/DATABASE_ERROR`,
    retryable: true,
    retryAfterSeconds: 5,
  },
  [ErrorCode.DEPENDENCY_TIMEOUT]: {
    action: "Retry with exponential backoff",
    steps: [
      "Upstream external dependency timed out.",
      "Retry after 5 seconds with exponential backoff (e.g. 5s, 10s, 20s).",
      "Verify external network egress connectivity.",
    ],
    docUrl: `${DOCS_BASE_URL}/DEPENDENCY_TIMEOUT`,
    retryable: true,
    retryAfterSeconds: 5,
  },
  [ErrorCode.NOT_FOUND]: {
    action: "Verify URI path and resource identifier",
    steps: [
      "Check the spelling and format of the resource UUID or identifier in the URL path.",
      "Ensure the resource was not deleted or belongs to another tenant/user.",
    ],
    docUrl: `${DOCS_BASE_URL}/NOT_FOUND`,
    retryable: false,
  },
  [ErrorCode.RATE_LIMITED]: {
    action: "Throttle client requests and observe Retry-After window",
    steps: [
      "Pause request execution for the duration specified in the retryAfterSeconds field.",
      "Implement client-side request queues or rate limiting.",
      "Contact support if you need a higher tier quota allowance.",
    ],
    docUrl: `${DOCS_BASE_URL}/RATE_LIMITED`,
    retryable: true,
    retryAfterSeconds: 60,
  },
  [ErrorCode.QUOTA_EXCEEDED]: {
    action: "Upgrade account tier or wait for quota reset period",
    steps: [
      "Review current period usage via GET /quota/usage.",
      "Wait for the monthly billing cycle reset or request a quota increase via admin console.",
    ],
    docUrl: `${DOCS_BASE_URL}/QUOTA_EXCEEDED`,
    retryable: false,
  },

  // Validation
  [ErrorCode.VALIDATION_ERROR]: {
    action: "Fix invalid fields reported in the errors payload",
    steps: [
      "Inspect the 'errors' map in the response for field-specific constraints.",
      "Verify data types, required fields, and length restrictions.",
      "Resubmit the corrected payload.",
    ],
    docUrl: `${DOCS_BASE_URL}/VALIDATION_ERROR`,
    retryable: false,
  },
  [ErrorCode.INVALID_PARAMETER]: {
    action: "Verify query parameters and URL arguments conform to API schema",
    steps: [
      "Ensure numeric parameters (e.g. page, limit) are positive integers.",
      "Check date formats conform to ISO-8601 (YYYY-MM-DDTHH:mm:ss.sssZ).",
    ],
    docUrl: `${DOCS_BASE_URL}/INVALID_PARAMETER`,
    retryable: false,
  },
  [ErrorCode.MALFORMED_PAYLOAD]: {
    action: "Ensure request body contains valid, well-formed JSON",
    steps: [
      "Check JSON syntax for unescaped characters, missing quotes, or trailing commas.",
      "Ensure Content-Type header is set to 'application/json'.",
    ],
    docUrl: `${DOCS_BASE_URL}/MALFORMED_PAYLOAD`,
    retryable: false,
  },
  [ErrorCode.PRECONDITION_FAILED]: {
    action: "Refresh state and verify resource prerequisites before retrying",
    steps: [
      "Fetch the latest version of the resource to resolve optimistic lock version mismatch.",
      "Verify prerequisite conditions (e.g., account verification status) are met.",
    ],
    docUrl: `${DOCS_BASE_URL}/PRECONDITION_FAILED`,
    retryable: false,
  },

  // Auth & RBAC
  [ErrorCode.UNAUTHORIZED]: {
    action: "Provide valid authentication credentials",
    steps: [
      "Include a valid Bearer token in the 'Authorization' header.",
      "If using wallet auth, ensure cryptographic signature is valid and nonce is unexpired.",
      "Obtain a new token via POST /auth/login or POST /auth/wallet/verify.",
    ],
    docUrl: `${DOCS_BASE_URL}/UNAUTHORIZED`,
    retryable: false,
  },
  [ErrorCode.FORBIDDEN]: {
    action: "Request required roles or permissions from administrator",
    steps: [
      "Check your assigned roles via GET /permissions/my-permissions.",
      "Verify endpoint required role/permission via OpenAPI documentation.",
      "Request role elevation or access grant from your organization administrator.",
    ],
    docUrl: `${DOCS_BASE_URL}/FORBIDDEN`,
    retryable: false,
  },
  [ErrorCode.TOKEN_EXPIRED]: {
    action: "Refresh authentication session using refresh token",
    steps: [
      "Call POST /auth/refresh with your current refresh token.",
      "If the refresh token has expired, re-authenticate via the login flow.",
    ],
    docUrl: `${DOCS_BASE_URL}/TOKEN_EXPIRED`,
    retryable: false,
  },
  [ErrorCode.INVALID_CREDENTIALS]: {
    action: "Verify email, password, or signature and retry",
    steps: [
      "Check entered credentials for typos or caps lock.",
      "Use password reset via POST /auth/forgot-password if needed.",
    ],
    docUrl: `${DOCS_BASE_URL}/INVALID_CREDENTIALS`,
    retryable: false,
  },
  [ErrorCode.ACCOUNT_LOCKED]: {
    action: "Contact organization administrator or security team",
    steps: [
      "Account has been locked due to excessive failed attempts or administrative action.",
      "Contact support or security team to unlock account and verify identity.",
    ],
    docUrl: `${DOCS_BASE_URL}/ACCOUNT_LOCKED`,
    retryable: false,
  },
  [ErrorCode.SESSION_TERMINATED]: {
    action: "Re-authenticate to establish a fresh session",
    steps: [
      "Your session was terminated due to logout, concurrency limits, or security rotation.",
      "Authenticate again via login endpoint.",
    ],
    docUrl: `${DOCS_BASE_URL}/SESSION_TERMINATED`,
    retryable: false,
  },

  // Settlement & Payment
  [ErrorCode.SETTLEMENT_FAILED]: {
    action: "Review transaction parameters, destination address, and escrow terms",
    steps: [
      "Verify destination Stellar public key exists and has trustline established for asset.",
      "Check that source account has sufficient balance including reserve requirements.",
    ],
    docUrl: `${DOCS_BASE_URL}/SETTLEMENT_FAILED`,
    retryable: false,
  },
  [ErrorCode.SETTLEMENT_TIMEOUT]: {
    action: "Verify transaction confirmation status on Stellar Horizon before retrying",
    steps: [
      "Do not immediately re-submit transaction to prevent double spending.",
      "Check transaction status on Stellar Horizon using transaction hash.",
      "If unsubmitted, retry with fresh sequence number after 30 seconds.",
    ],
    docUrl: `${DOCS_BASE_URL}/SETTLEMENT_TIMEOUT`,
    retryable: true,
    retryAfterSeconds: 30,
  },
  [ErrorCode.INSUFFICIENT_FUNDS]: {
    action: "Fund source wallet with XLM or required asset",
    steps: [
      "Ensure balance covers transaction amount plus base Stellar transaction fee (0.00001 XLM).",
      "Account for Stellar base reserve requirement (0.5 XLM per entry/trustline).",
    ],
    docUrl: `${DOCS_BASE_URL}/INSUFFICIENT_FUNDS`,
    retryable: false,
  },
  [ErrorCode.PAYMENT_FAILED]: {
    action: "Verify payment details and gateway status",
    steps: [
      "Check payment processor adapter status.",
      "Ensure payment method details are active and supported.",
    ],
    docUrl: `${DOCS_BASE_URL}/PAYMENT_FAILED`,
    retryable: false,
  },
  [ErrorCode.DUPLICATE_PAYMENT_SUBMISSION]: {
    action: "Do not resubmit; payment has already been processed",
    steps: [
      "Query existing payment receipt using idempotency key or invoice ID.",
      "Verify payment status in invoice ledger.",
    ],
    docUrl: `${DOCS_BASE_URL}/DUPLICATE_PAYMENT_SUBMISSION`,
    retryable: false,
  },
  [ErrorCode.PAYMENT_METHOD_UNSUPPORTED]: {
    action: "Select a supported payment adapter",
    steps: [
      "List supported payment methods via GET /payments/adapters.",
      "Select an active and configured payment processor.",
    ],
    docUrl: `${DOCS_BASE_URL}/PAYMENT_METHOD_UNSUPPORTED`,
    retryable: false,
  },

  // Reconciliation
  [ErrorCode.RECONCILIATION_MISMATCH]: {
    action: "Reconcile memo, destination, or amount discrepancies against registered invoice",
    steps: [
      "Verify that the transaction memo matches the invoice ID exactly.",
      "Confirm transaction asset and amount match expected billing amount.",
    ],
    docUrl: `${DOCS_BASE_URL}/RECONCILIATION_MISMATCH`,
    retryable: false,
  },
  [ErrorCode.INVOICE_NOT_FOUND]: {
    action: "Verify invoice identifier",
    steps: [
      "Ensure invoice ID corresponds to an active invoice.",
      "Verify the invoice has not expired or been voided.",
    ],
    docUrl: `${DOCS_BASE_URL}/INVOICE_NOT_FOUND`,
    retryable: false,
  },
  [ErrorCode.TRANSACTION_UNCONFIRMED]: {
    action: "Wait for Stellar ledger close and retry",
    steps: [
      "Wait 5 seconds for Stellar consensus ledger close (typically 3-5 seconds).",
      "Retry reconciliation verification query.",
    ],
    docUrl: `${DOCS_BASE_URL}/TRANSACTION_UNCONFIRMED`,
    retryable: true,
    retryAfterSeconds: 5,
  },

  // Blockchain / Stellar / Oracle
  [ErrorCode.STELLAR_NETWORK_ERROR]: {
    action: "Retry after brief backoff or verify Horizon node health",
    steps: [
      "Stellar node communication failed.",
      "Retry request after 10 seconds.",
      "Verify Horizon network connectivity and status.",
    ],
    docUrl: `${DOCS_BASE_URL}/STELLAR_NETWORK_ERROR`,
    retryable: true,
    retryAfterSeconds: 10,
  },
  [ErrorCode.HORIZON_TIMEOUT]: {
    action: "Retry Horizon request with exponential backoff",
    steps: [
      "Wait 10 seconds before retrying Horizon query.",
      "If timeout persists, check Stellar status and Horizon ingress rate limits.",
    ],
    docUrl: `${DOCS_BASE_URL}/HORIZON_TIMEOUT`,
    retryable: true,
    retryAfterSeconds: 10,
  },
  [ErrorCode.INVALID_TRANSACTION_ENVELOPE]: {
    action: "Ensure XDR envelope is correctly base64-encoded and matches target network passphrase",
    steps: [
      "Verify transaction envelope conforms to Stellar XDR specification.",
      "Ensure network passphrase matches (Public Global Stellar Network vs Test SDF Network).",
    ],
    docUrl: `${DOCS_BASE_URL}/INVALID_TRANSACTION_ENVELOPE`,
    retryable: false,
  },
  [ErrorCode.NONCE_EXPIRED]: {
    action: "Fetch fresh nonce before signing and submitting payload",
    steps: [
      "Obtain fresh nonce via GET /blockchain/oracle/nonce.",
      "Sign canonical payload including fresh nonce and resubmit within validity window.",
    ],
    docUrl: `${DOCS_BASE_URL}/NONCE_EXPIRED`,
    retryable: false,
  },
  [ErrorCode.ORACLE_VERIFICATION_FAILED]: {
    action: "Ensure payload signature matches registered oracle signer public key",
    steps: [
      "Verify EIP-712 / canonical payload serialization matches hashing standard.",
      "Ensure signing key is authorized as registered oracle signer in smart contract.",
    ],
    docUrl: `${DOCS_BASE_URL}/ORACLE_VERIFICATION_FAILED`,
    retryable: false,
  },

  // Portfolio & DeFi
  [ErrorCode.PORTFOLIO_NOT_FOUND]: {
    action: "Verify portfolio ID and account permissions",
    steps: [
      "Ensure portfolio ID is correct and portfolio has not been archived.",
      "Verify requesting user is owner or operator for the portfolio.",
    ],
    docUrl: `${DOCS_BASE_URL}/PORTFOLIO_NOT_FOUND`,
    retryable: false,
  },
  [ErrorCode.OPTIMIZATION_FAILED]: {
    action: "Adjust risk tolerance constraints or asset bounds and retry",
    steps: [
      "Review target allocation constraints to ensure they are mathematically feasible.",
      "Ensure asset weights sum to exactly 100%.",
      "Retry optimization with relaxed bounds.",
    ],
    docUrl: `${DOCS_BASE_URL}/OPTIMIZATION_FAILED`,
    retryable: true,
    retryAfterSeconds: 2,
  },
  [ErrorCode.RISK_LIMIT_EXCEEDED]: {
    action: "Reduce order size or adjust portfolio risk profile limits",
    steps: [
      "Review proposed trade against maximum slippage and concentration limits.",
      "Adjust portfolio risk profile via portfolio settings or split trade into smaller orders.",
    ],
    docUrl: `${DOCS_BASE_URL}/RISK_LIMIT_EXCEEDED`,
    retryable: false,
  },
  [ErrorCode.ASSET_UNSUPPORTED]: {
    action: "Select an asset supported by Trellis risk oracle",
    steps: [
      "List supported assets via GET /portfolio/assets/supported.",
      "Ensure asset issuer is trusted and active on Stellar DEX.",
    ],
    docUrl: `${DOCS_BASE_URL}/ASSET_UNSUPPORTED`,
    retryable: false,
  },

  // Business Conflict
  [ErrorCode.CONFLICT]: {
    action: "Resource conflict: reload latest state and resolve differences",
    steps: [
      "Fetch latest version of the resource.",
      "Reapply changes on top of latest version to resolve concurrent update conflict.",
    ],
    docUrl: `${DOCS_BASE_URL}/CONFLICT`,
    retryable: false,
  },
  [ErrorCode.RESOURCE_NOT_FOUND]: {
    action: "Verify resource identifier exists and is active",
    steps: [
      "Verify resource identifier and query filters.",
    ],
    docUrl: `${DOCS_BASE_URL}/RESOURCE_NOT_FOUND`,
    retryable: false,
  },
  [ErrorCode.DUPLICATE_ENTRY]: {
    action: "Use unique identifier; record already exists",
    steps: [
      "Ensure unique fields (e.g. username, email, transaction hash) do not collide with existing records.",
    ],
    docUrl: `${DOCS_BASE_URL}/DUPLICATE_ENTRY`,
    retryable: false,
  },

  // Import Pipeline
  [ErrorCode.IMPORT_NOT_FOUND]: {
    action: "Verify import job ID",
    steps: ["Ensure import job ID exists and was created by your account."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_NOT_FOUND`,
    retryable: false,
  },
  [ErrorCode.IMPORT_PREVIEW_EXPIRED]: {
    action: "Re-upload import file to generate fresh preview",
    steps: ["Import previews expire after 24 hours. Re-upload file."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_PREVIEW_EXPIRED`,
    retryable: false,
  },
  [ErrorCode.IMPORT_PREVIEW_NOT_FOUND]: {
    action: "Generate new import preview",
    steps: ["Preview was not found or has been cleaned up. Upload file to preview."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_PREVIEW_NOT_FOUND`,
    retryable: false,
  },
  [ErrorCode.IMPORT_PREVIEW_ALREADY_COMMITTED]: {
    action: "Import already committed",
    steps: ["Job has already been committed to database. Do not commit again."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_PREVIEW_ALREADY_COMMITTED`,
    retryable: false,
  },
  [ErrorCode.IMPORT_ROWS_QUARANTINED]: {
    action: "Review quarantined rows and correct invalid data",
    steps: ["Download quarantine report, resolve row errors, and re-upload."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_ROWS_QUARANTINED`,
    retryable: false,
  },
  [ErrorCode.IMPORT_ROW_INVALID]: {
    action: "Correct invalid row values according to schema",
    steps: ["Check row fields against data type constraints."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_ROW_INVALID`,
    retryable: false,
  },
  [ErrorCode.IMPORT_ROW_DUPLICATE]: {
    action: "Remove duplicate rows from import file",
    steps: ["Deduplicate rows by unique key before re-submitting."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_ROW_DUPLICATE`,
    retryable: false,
  },
  [ErrorCode.IMPORT_ROW_UNSAFE]: {
    action: "Remove unsafe scripts or formula injections from import rows",
    steps: ["Ensure cells do not begin with =, +, -, @, or contain unescaped HTML/scripts."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_ROW_UNSAFE`,
    retryable: false,
  },
  [ErrorCode.IMPORT_COMMIT_FAILED]: {
    action: "Retry commit or initiate rollback",
    steps: ["Retry commit operation with exponential backoff or trigger rollback."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_COMMIT_FAILED`,
    retryable: true,
    retryAfterSeconds: 5,
  },
  [ErrorCode.IMPORT_ROLLBACK_FAILED]: {
    action: "Retry rollback or contact technical support",
    steps: ["Retry rollback or contact support with import job ID."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_ROLLBACK_FAILED`,
    retryable: true,
    retryAfterSeconds: 10,
  },
  [ErrorCode.IMPORT_ROLLBACK_NOT_POSSIBLE]: {
    action: "Rollback window has expired",
    steps: ["Rollbacks are only supported within retention window. Use compensatory records."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_ROLLBACK_NOT_POSSIBLE`,
    retryable: false,
  },
  [ErrorCode.IMPORT_RETRY_FAILED]: {
    action: "Retry operation failed",
    steps: ["Check import worker status and retry limit."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_RETRY_FAILED`,
    retryable: false,
  },
  [ErrorCode.IMPORT_IDEMPOTENCY_KEY_REQUIRED]: {
    action: "Provide unique Idempotency-Key header",
    steps: ["Include an Idempotency-Key header with mutating import requests."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_IDEMPOTENCY_KEY_REQUIRED`,
    retryable: false,
  },
  [ErrorCode.IMPORT_IDEMPOTENCY_CONFLICT]: {
    action: "Idempotency key reused with different payload",
    steps: ["Generate a new UUID for distinct import operations."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_IDEMPOTENCY_CONFLICT`,
    retryable: false,
  },
  [ErrorCode.IMPORT_LIMIT_EXCEEDED]: {
    action: "Reduce file size or batch into smaller imports",
    steps: ["Maximum row limit exceeded. Split into smaller batches."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_LIMIT_EXCEEDED`,
    retryable: false,
  },
  [ErrorCode.IMPORT_FORMAT_UNSUPPORTED]: {
    action: "Use supported CSV or JSON format",
    steps: ["Ensure file is formatted as valid UTF-8 CSV or JSON."],
    docUrl: `${DOCS_BASE_URL}/IMPORT_FORMAT_UNSUPPORTED`,
    retryable: false,
  },
};

export function getRemediationHint(
  code: ErrorCode,
  correlationId?: string,
): RemediationHint {
  const hint = REMEDIATION_HINTS[code] ?? {
    action: "Consult technical documentation and contact support",
    steps: ["Check API documentation for error code specifications.", "Contact support with correlation ID."],
    docUrl: `${DOCS_BASE_URL}/${code}`,
    retryable: false,
  };

  return {
    ...hint,
    supportReference: correlationId ?? "N/A",
  };
}

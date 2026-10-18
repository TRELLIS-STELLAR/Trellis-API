# Error Taxonomy and User-Safe Error Rendering

Trellis API provides a centralized, structured error taxonomy that categorizes all client and server failures, exposes deterministic retryability metadata, provides actionable recovery guidance, and ensures internal implementation details (such as database credentials, raw SQL, or stack traces) are never leaked to end users.

---

## 1. Error Response Contract

All errors emitted across HTTP endpoints conform to the following JSON payload:

```json
{
  "type": "https://trellis-stellar.github.io/Trellis-API/problems/SETTLEMENT_FAILED",
  "title": "Stellar settlement execution failed",
  "status": 400,
  "detail": "Stellar settlement execution failed",
  "instance": "/api/v1/stellar/settlement",
  "remediation": "Review transaction parameters, destination address, and escrow conditions.",
  "statusCode": 400,
  "errorCode": "SETTLEMENT_FAILED",
  "domain": "settlement",
  "message": "Stellar settlement execution failed",
  "recoveryGuidance": "Review transaction parameters, destination address, and escrow conditions.",
  "retryable": false,
  "correlationId": "c8f2b381-872e-4b92-8ec2-132d914e7a83",
  "timestamp": "2026-09-25T21:02:31.000Z",
  "path": "/api/v1/stellar/settlement",
  "errors": {
    "amount": ["amount must be a positive number"]
  }
}
```

The response adds the RFC 9457 Problem Details members `type`, `title`,
`status`, `detail`, and `instance`, plus the `remediation` hint. The existing
Trellis fields (`statusCode`, `errorCode`, `message`, `recoveryGuidance`, and
the correlation metadata) remain unchanged for compatibility. Responses
continue to use the existing `application/json` media type; changing the media
type is intentionally deferred to a separately versioned contract migration.

Problem type identifiers use the stable form
`https://trellis-stellar.github.io/Trellis-API/problems/{ERROR_CODE}`. The
`errorCode` value is the machine-readable contract; titles and guidance are for
people and may be clarified without changing the code. When adding or removing
an error code, update `ErrorCode`, its taxonomy entry, and the frozen catalog
assertion in `src/common/errors/error-taxonomy.spec.ts` together.

### Key Fields:
- **`statusCode`**: Standard HTTP status code (400, 401, 403, 404, 409, 422, 429, 500, 502, 504).
- **`errorCode`**: Machine-readable, stable enum string (`ErrorCode`) identifying the exact failure condition.
- **`domain`**: Domain category (`auth`, `validation`, `settlement`, `payment`, `reconciliation`, `blockchain`, `portfolio`, `rate_limit`, `quota`, `system`).
- **`message`**: Human-readable explanation sanitized for end-user safety.
- **`recoveryGuidance`**: Actionable instructions guiding the caller or end-user on how to recover from the failure.
- **`retryable`**: Boolean indicating whether the caller can safely retry the operation.
- **`retryAfterSeconds`**: (Optional) Suggested cool-off duration before issuing a retry.
- **`correlationId`**: Unique identifier for cross-service and log tracing (propagated via `x-correlation-id` and `x-request-id` headers).
- **`errors`**: (Optional) Property-level constraint violations for schema validation failures.

---

## 2. Domain Categorization and Error Codes

| Domain | ErrorCode | HTTP Status | Retryable | Retry Strategy | Recovery Guidance |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Validation** | `VALIDATION_ERROR` | 400 | No | `none` | Review request body and address constraints in `errors` object. |
| | `INVALID_PARAMETER` | 400 | No | `none` | Ensure query params and path arguments conform to API schema. |
| | `MALFORMED_PAYLOAD` | 400 | No | `none` | Ensure request body contains valid JSON matching API schema. |
| | `PRECONDITION_FAILED` | 422 | No | `none` | Refresh resource state and verify prerequisites before retrying. |
| **Auth & RBAC** | `UNAUTHORIZED` | 401 | No | `none` | Provide valid Bearer token in Authorization header or sign in. |
| | `FORBIDDEN` | 403 | No | `none` | Account lacks role or permission required for this endpoint. |
| | `TOKEN_EXPIRED` | 401 | No | `none` | Refresh token or re-authenticate via `/auth/login`. |
| | `INVALID_CREDENTIALS` | 401 | No | `none` | Verify email, password, or wallet signature and try again. |
| | `ACCOUNT_LOCKED` | 403 | No | `none` | Contact an administrator to unlock your account. |
| **Settlement** | `SETTLEMENT_FAILED` | 400 | No | `none` | Review transaction parameters, destination address, and escrow terms. |
| | `SETTLEMENT_TIMEOUT` | 504 | **Yes** | `exponential_backoff` | Stellar Horizon confirmation timed out. Verify tx status before retrying. |
| | `INSUFFICIENT_FUNDS` | 400 | No | `none` | Fund source wallet with XLM to cover amount and base fees. |
| **Payment** | `PAYMENT_FAILED` | 400 | No | `none` | Payment gateway rejected transaction. Check payment adapter. |
| | `DUPLICATE_PAYMENT_SUBMISSION` | 409 | No | `none` | Payment already submitted and ingested. Do not duplicate. |
| | `PAYMENT_METHOD_UNSUPPORTED`| 400 | No | `none` | Select a supported active payment processor adapter. |
| **Reconciliation** | `RECONCILIATION_MISMATCH` | 409 | No | `none` | Payment memo, destination, or asset does not match registered invoice. |
| | `INVOICE_NOT_FOUND` | 404 | No | `none` | Verify invoice ID referenced in transaction memo. |
| | `TRANSACTION_UNCONFIRMED` | 400 | **Yes** | `exponential_backoff` | Wait for Stellar ledger close before re-attempting reconciliation. |
| **Blockchain** | `STELLAR_NETWORK_ERROR` | 502 | **Yes** | `exponential_backoff` | Stellar node communication failed. Retry after brief backoff. |
| | `HORIZON_TIMEOUT` | 504 | **Yes** | `exponential_backoff` | Horizon server timed out. Retry with exponential backoff. |
| | `INVALID_TRANSACTION_ENVELOPE` | 400 | No | `none` | Ensure XDR envelope is formatted for the target network. |
| | `NONCE_EXPIRED` | 400 | No | `none` | Request fresh nonce before signing and submitting payload. |
| | `ORACLE_VERIFICATION_FAILED` | 400 | No | `none` | Payload signature invalid or not from registered oracle signer. |
| **Portfolio** | `PORTFOLIO_NOT_FOUND` | 404 | No | `none` | Check portfolio ID and verify account ownership. |
| | `OPTIMIZATION_FAILED` | 422 | **Yes** | `immediate` | Algorithm could not converge. Adjust constraints and retry. |
| | `RISK_LIMIT_EXCEEDED` | 400 | No | `none` | Order size or volatility profile exceeds portfolio limits. |
| **Rate Limit** | `RATE_LIMITED` | 429 | **Yes** | `exponential_backoff` | Throttle requests and retry after the specified window. |
| **Quota** | `QUOTA_EXCEEDED` | 429 | No | `none` | Review usage and quota limits; wait for reset or request an increase. |
| **System** | `INTERNAL_ERROR` | 500 | No | `none` | Quote `correlationId` when contacting support. |
| | `SERVICE_UNAVAILABLE` | 503 | **Yes** | `exponential_backoff` | Service degraded or under maintenance. Retry shortly. |

---

## 3. User-Safe Rendering and Leak Prevention

In production environments (`NODE_ENV=production`), the `GlobalExceptionFilter` intercepts all thrown exceptions and sanitizes output:
1. **Database & SQL Protection**: Statements containing `SELECT`, `INSERT`, `UPDATE`, `pg_`, `typeorm`, or connection strings are scrubbed.
2. **Stack Trace Suppression**: Internal file locations, stack traces, and runtime internals are excluded from client payloads.
3. **Structured Server Logging**: Detailed error objects, original exceptions, and stack traces are logged internally along with the `correlationId` and captured in Sentry for support investigation.

---

## 4. Correlation IDs and Support Tracing

Every request is assigned a `correlationId`:
- If the incoming request contains an `x-request-id` or `x-correlation-id` header, it is preserved.
- Otherwise, a cryptographically random UUID v4 is generated.
- The `correlationId` is returned in both the `x-correlation-id` response header and the JSON response body.
- When support tickets are opened, customers can provide this ID to query logs instantly.

---

## 5. Operational Edge Cases, Recovery, and Rollback

- Clients should branch on `errorCode`, not `title`, `detail`, or `message`;
  human-readable text and remediation may be clarified without changing the
  machine contract. `retryable: false` means do not automatically retry.
- A retryable settlement timeout is an ambiguous outcome: query the transaction
  status on the network before resubmitting. For payment writes, use the API's
  idempotency mechanism where available to avoid duplicate operations.
- Validation errors may include the optional `errors` field with field-level
  messages. Other error types omit it. Do not assume every error has that
  extension.
- The `instance` field contains the request path without its query string.
  Use `correlationId` to find the detailed server-side record; logs and Sentry
  may contain internal exception information that is deliberately absent from
  the client response.
- In production, unexpected failures use the generic `INTERNAL_ERROR` title and
  detail. Do not return raw driver/provider errors to make a response more
  actionable; improve the taxonomy remediation or investigate using the
  correlation ID instead.

The new Problem Details fields are additive, require no database migration, and
keep the existing `application/json` media type and Trellis fields. If a
consumer has trouble after rollout, roll back the application release through
the normal deployment process; there is no data rollback. Consumers should
continue to tolerate unknown JSON members and may fall back to
`statusCode`/`errorCode`/`message` when talking to an older server. Do not
remove or rename legacy fields without a separately versioned contract change.

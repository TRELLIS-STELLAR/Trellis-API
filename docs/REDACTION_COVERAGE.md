# Redaction coverage: logs, exports and error responses

> Resolves issue #271: redaction tests for logs, exports and error responses.

A secret can leave the API in three ways: a log sink, a data export, or an
error response. [`src/logging/redaction-surfaces.spec.ts`](../src/logging/redaction-surfaces.spec.ts)
checks all three against **one shared corpus** of secret shapes. A new secret
shape is added to the corpus once and is then tested on every surface.

## Secret shapes

| Shape | Example | Redactor |
| --- | --- | --- |
| JWT | `eyJ...` `.` `...` `.` `...` | `redactSecretValues` |
| Bearer / Basic credentials | `Bearer abc`, `Basic dXNlcjpw...` | `redactSecretValues` |
| Stellar secret seed | `S` + 55 base32 chars | `redactSecretValues` |
| Credentials in a URL | `postgres://user:pass@host` | `redactSecretValues` (the host is kept) |
| PEM private key block | `-----BEGIN PRIVATE KEY-----...` | `redactSecretValues` (also when the END line is cut off) |
| `password=` / `secret=` / `key=` / `token=` pairs | `password=hunter2` | `redactSecretValues` |
| 64-128 hex characters | raw private keys | `sanitizeErrorMessage` only |
| Sensitive keys or headers | `password`, `apiKey`, `Authorization` | `sanitizeObject` / `sanitizeHeaders` / `sanitizeQuery` / `sanitizeUrl` |

Deliberately **not** redacted, and asserted by the spec: Stellar public keys
(`G...`), contract IDs (`C...`), 64-hex transaction hashes in client messages
and exports, hostnames, and prose such as "Basic plan".

## Surfaces

| Surface | What changed |
| --- | --- |
| `LoggerService` | The message text is now redacted. Before, only metadata was. `logError` also redacts its message, and `formatError` redacts the stack trace. |
| `GlobalExceptionFilter` response | `detail` and `message` are scrubbed in **every** environment, not only production. The echoed `path` and `instance` have sensitive query values replaced. |
| `GlobalExceptionFilter` log and Sentry | The logged URL, message and stack are sanitized. Sentry `path`, `query` and `params` extras are sanitized. |
| Export payloads (`PrivacyExportAuthorizer`) | Invariant 4: string values in fields that are otherwise public (notes, memos) are scrubbed by value. Key-based rules are unchanged. |
| Failed export (`ExportService`) | The stored `error`, served by `GET /exports/:id`, and its log line are sanitized. |
| Retry records (`RetrySchedulerService`) | `lastError`, shown on the failure dashboard and dead-letter listing, and the `retry.failed` event are sanitized. |
| Background jobs | `job.error`, shown on the inspection endpoints, is sanitized. |
| Webhook deliveries | `requestHeaders` stored on deliveries and dead letters go through `sanitizeHeaders`, so a subscriber's `Authorization` header is **sent but never persisted**. Transport errors are sanitized. |

## Path coverage

- **Normal:** owner exports, info logs and URL/query logging.
- **Failure:** 500 responses in production and development, `logError`,
  failed exports, dead letters.
- **Retry:** a failed export processed twice, the same 500 rendered twice,
  retry-scheduler attempts, webhook retries.
- **Authorization:** a 401 that echoes the presented token, non-owner and
  admin exports (secrets are dropped even for admins), and subscriber
  credentials on webhooks.

The spec was checked against the pre-change code. Restoring the previous
filter, logger and export authorizer makes 12 of its 17 cases fail.

## Operational edge cases

- Redaction is pattern-based. A secret that matches no pattern and sits under a
  non-sensitive key is not caught. Add its shape to `redactSecretValues` and to
  the spec's corpus.
- When text exceeds the length cap, the token straddling the cut is dropped
  (see [resource-budget-tests.md](resource-budget-tests.md)), so half a secret
  is never logged.
- Webhook `requestHeaders` stored **before** this release may still contain
  subscriber credentials. If that matters, scrub existing rows with a one-off
  `UPDATE` that replaces `Authorization`/`X-Api-Key` values in
  `webhook_deliveries.requestHeaders` and `webhook_dead_letters.requestHeaders`.
  Retries are unaffected because they rebuild headers from the subscription.
- Error response bodies change only where a secret was present, or where a
  sensitive query value was echoed in `path`. No field was added or removed.

## Rollback

Code-only; no data migration. Reverting restores the previous behaviour.
Records redacted in the meantime stay redacted, which is the safe direction.

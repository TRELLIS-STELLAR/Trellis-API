# Request correlation

> Resolves issue #270: request correlation across the API, background workers
> and external calls.

Every HTTP request gets exactly one **correlation ID**. That ID is on every log
line written while the request is handled, on every job or retry record the
request creates, on every outbound call it causes (even ones made later by a
queue worker), and on its error response.

Code: [`src/common/correlation/`](../src/common/correlation/).

## How the ID is chosen

`CorrelationIdMiddleware` is registered in `main.ts` as the **first** Express
middleware, so it runs before Helmet, Sentry breadcrumbs, module middleware,
guards and the exception filter.

1. `x-correlation-id` is read first, then `x-request-id` (existing clients send
   this one).
2. A value is accepted only if it is 1-64 characters of `A-Z a-z 0-9 - _`
   after trimming. This is the oracle contract's `MAX_CORRELATION_ID_LEN` and
   charset, so an API ID can be passed on-chain unchanged. UUIDs qualify.
3. If no value is accepted, a UUID v4 is generated. A rejected value is
   **never echoed**: it cannot add response headers (CRLF), forge log lines, or
   show up in an error body.
4. The chosen ID is written back to `req.headers["x-correlation-id"]` and
   `req.headers["x-request-id"]`, set on `req.correlationId` and
   `req.requestId`, and sent back in both response headers. The existing
   readers (`HttpLoggingMiddleware`, `TracingInterceptor`,
   `RequestTimingMiddleware`, `GlobalExceptionFilter`) therefore all see the
   same sanitized value without code changes.
5. The rest of the request runs inside an `AsyncLocalStorage` scope.
   `getCorrelationId()` returns the ID from any service, at any depth, across
   `await`. Concurrent requests are isolated from each other.

## Propagation

| Boundary | Mechanism |
| --- | --- |
| Log lines (`LoggerService`) | `correlationId` is added to every entry written inside a scope, unless the caller set one. |
| Error responses (`GlobalExceptionFilter`) | Uses the scope's ID, or a validated header if the filter somehow runs outside the middleware. The ID goes in the `x-correlation-id` and `x-request-id` headers and in the `correlationId` body field. Guard rejections (401/403) are covered because the middleware runs before guards. |
| Background jobs (`BackgroundWorkerService.enqueue`) | An explicit valid `correlationId` wins; otherwise the scope's ID is used. It is stored on the job record and stamped into the Bull payload as `_correlationId`. |
| Manual job retry (`retryJob`) | Re-stamps the job's **original** ID, not the operator's request ID. |
| Retry records (`RetrySchedulerService.schedule`) | Same precedence as jobs; persisted in the existing `correlationId` column and included in the `retry.failed` and `retry.dead_letter` events. |
| Webhook jobs | `withJobCorrelation` stamps the queued payload; `WebhookProcessor` re-enters the scope with `runJobWithCorrelation`. |
| Outbound webhook calls | The ID is pinned in `delivery.metadata.correlationId` when the delivery is created and sent as `x-correlation-id` / `x-request-id` on **every** attempt. A replayed dead letter keeps it. Subscriber-supplied headers with the same name are not overridden. |
| Other outbound HTTP | Wrap headers with `withCorrelationHeaders(headers)`. |

## Edge cases

- **Work outside a request** (cron, startup, `onModuleInit`): there is no
  scope, so `getCorrelationId()` is `undefined`. Nothing is stamped and log
  lines carry no `correlationId`; this is the same behaviour as before.
  Workers processing such jobs generate a fresh ID per job.
- **Jobs enqueued before this release**: they carry no `_correlationId`. The
  worker generates a fresh ID; the job still runs.
- **Tampered job payloads**: an invalid `_correlationId` is replaced, never
  trusted.
- **Stellar RPC** (`rpc.Server`) takes headers at construction, not per call,
  so Soroban RPC requests are not correlated. Correlate them through the
  verifier's log lines instead.
- **Correlation is not authorization.** The ID is caller-controlled and is
  used only for tracing, never for access decisions or idempotency.

## Rollback

There is no schema or data migration. Existing columns are reused
(`retry_operations.correlationId`, `webhook_deliveries.metadata`), and
`x-request-id` keeps working. To roll back, revert the release. Records
written in the meantime keep their IDs; older code ignores
`metadata.correlationId` and the `_correlationId` job field.

## Verification

```sh
npm test -- --runInBand src/common/correlation \
  src/infrastructure/workers/background-worker.correlation.spec.ts \
  src/infrastructure/retry-scheduler/retry-scheduler.correlation.spec.ts \
  src/infrastructure/webhooks/services/webhook-delivery.correlation.spec.ts
```

`correlation.e2e.spec.ts` sends real HTTP requests through the middleware, a
guard and the exception filter. It covers the normal, failure (500),
authorization (403 and a forged header) and concurrency paths. The worker,
retry and webhook specs cover the retry paths.

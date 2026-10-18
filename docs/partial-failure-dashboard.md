# Partial-failure triage endpoint

Maintainers can use `GET /retry-scheduler/failures` to page through failed and
dead-letter operations, optionally filtering by `operationType` or a search
string matching operation ID, correlation ID, or the last error. The response
omits operation payloads and includes the cause, retryability, attempt counts,
and a suggested next action. Results are capped at 100 per request.

The route uses the existing JWT and maintainer-role guards. Dead-letter retries
continue through `POST /retry-scheduler/dead-letters/:operationId/retry`, which
is restricted to administrators. Non-retryable failures should be investigated
instead of resubmitted. This first slice covers the retry-scheduler operation
store; integration-specific health and user-action workflows can be added by
their owning modules.

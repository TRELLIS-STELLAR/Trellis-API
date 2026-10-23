# External dependency degradation matrix

This matrix describes the API behavior when a dependency is slow, unavailable,
or misconfigured. The health report is diagnostic; it does not make a failed
business operation succeed with stale or fabricated data.

| Dependency | Criticality | User or API behavior during failure | Safe fallback and recovery |
| --- | --- | --- | --- |
| PostgreSQL (`database`) | Critical | Readiness reports `503`; database-backed operations fail and must not be treated as committed. | Restore PostgreSQL connectivity and confirm credentials/pool capacity. Retry an operation only when its idempotency key or transaction status makes the outcome clear. |
| Redis (`redis`) | Critical | Readiness reports `503`; Redis-backed rate limits, cache, and queue work may be unavailable. | Restore Redis and allow clients/workers to reconnect. Do not silently replace distributed limits or queue state with process-local state. |
| Bull queues (`background_jobs`) | Optional | Core readiness remains available; background email, webhook, and worker work can be delayed. | Restore Redis; queued work resumes through the configured workers. Inspect queue depth before replaying jobs manually. |
| Stellar Horizon (`stellar_horizon`) | Critical | Readiness reports `503` when unreachable; account and transaction status cannot be confirmed. | Do not report an unconfirmed payment as successful. Restore Horizon access and reconcile the transaction before retrying submission. |
| Stellar network passphrase (`stellar_network_passphrase`) | Critical | Readiness reports `503` when missing or invalid; transaction signatures cannot be trusted for the intended network. | Correct the passphrase for the deployment network, then re-run the local health check before enabling writes. |
| EVM JSON-RPC (`eth_rpc`) | Critical | Readiness reports `503` when unavailable or when the returned chain ID conflicts with configuration; oracle-dependent actions cannot be confirmed. | Restore the configured RPC or correct `CHAIN_ID`; never substitute data from another chain. |
| Object storage (`object_storage`) | Optional | Readiness remains available; storage-dependent uploads/downloads can fail. | Use the configured local backend only when that backend is explicitly selected. Restore the configured bucket/credentials before retrying failed uploads. |
| SMTP (`smtp`) | Optional | Readiness remains available; email delivery is delayed or unavailable. | Keep the API response independent of SMTP delivery and retry through the mail worker after SMTP recovers; do not tell a user an email was delivered based only on enqueue success. |
| Elasticsearch (`elasticsearch`) | Optional | Readiness remains available; search/index-backed views may be stale or unavailable. | Use the source-of-truth database for critical decisions. Restore Elasticsearch and let indexing catch up before replaying indexing jobs. |
| OpenTelemetry collector (`otel_collector`) | Optional | Readiness remains available; traces may be dropped. | Continue serving requests without blocking on telemetry. Restore the collector and verify telemetry export separately. |
| Sentry (`sentry`) | Optional | Readiness remains available; error reporting may be unavailable. | Continue serving requests and rely on local application logs/metrics until the DSN or Sentry service is restored. |
| AI provider (`ai_provider`) | Optional | Readiness remains available; AI-assisted compute is offline when credentials are absent or invalid. | Return the existing unavailable/error result for the compute request; do not fabricate generated output. Configure the provider and retry the request. |

## Operational checks

- `GET /health/dependencies` is local-only and returns `503` only when a
  critical dependency is unavailable or misconfigured. Its response does not
  trigger outbound probes.
- `GET /health/dependencies/diagnostics` requires an admin role and two-factor
  authentication. Use `?refresh=true` to bypass the report cache and
  `?networkProbes=false` to avoid outbound checks.
- `npm run deps:health -- --no-network` checks local configuration and backing
  stores before deployment. The full CLI report can contact configured
  third-party endpoints and should be run from an environment with expected
  network access.
- Reports expose configuration key names and sanitized targets, never secret
  values. Keep health output in normal operational logs; do not add secret
  values to remediation messages.

The matrix is intentionally conservative: a degraded dependency may still allow
readiness, but callers must handle the affected operation's normal error path.
Only a successful response from the authoritative service confirms a payment,
upload, email delivery, or generated result.

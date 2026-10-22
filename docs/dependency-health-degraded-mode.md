# Dependency health degraded-mode behaviour (#355)

## What this is

The dependency health check (issue #124) answers *"is each external dependency
healthy?"*. This slice answers the operational follow-up: *"given that report,
what is the API allowed to do right now?"*

Rather than failing every request when a dependency is down, the API enters a
defined **operating mode** that disables only the capabilities that depend on
the failing dependency and keeps the rest serving.

The module is additive (`src/dependency-health/degraded-mode/`) and consumes the
existing `DependencyHealthService`; the health report shape is unchanged.

## Modes

| Level | Meaning | Capability effect |
| --- | --- | --- |
| `normal` | Every dependency is healthy and no override is active. | All capabilities allowed. |
| `degraded` | A critical dependency is slow, or an optional dependency is degraded/unavailable/misconfigured. | Affected capabilities stay **allowed but flagged** (`degradedCapabilities`). |
| `restricted` | A critical dependency is `unavailable` or `misconfigured`. | Capabilities mapped to that dependency are **disabled**. |
| `maintenance` | An operator declared a maintenance window. | All user-facing capabilities disabled; `admin` stays available. |

Severity ordering is `normal < degraded < restricted < maintenance`. A manual
override can only make the mode *more* restrictive, never less.

## Capability map

| Dependency | Capabilities gated |
| --- | --- |
| `database` | payments, trades, imports, exports, admin |
| `redis` | notifications, webhooks, search |
| `background_jobs` | notifications, webhooks |
| `stellar_horizon`, `stellar_network_passphrase` | payments, trades |
| `eth_rpc` | oracle |
| `object_storage` | imports, exports |
| `smtp` | notifications |
| `elasticsearch` | search |
| `otel_collector`, `sentry`, `ai_provider` | — (observability only) |

The map lives in `degraded-mode.policy.ts` as `DEFAULT_DEPENDENCY_CAPABILITY_MAP`
and is a pure function input, so it can be overridden in tests or per
environment without touching the policy.

## Paths covered

| Path | Behaviour |
| --- | --- |
| **Normal** | Healthy report → `normal`, nothing disabled. |
| **Failure** | Critical `database` unavailable → `restricted`; `assertCapabilityEnabled("payments")` throws `DegradedModeCapabilityBlockedError`. Unaffected capabilities such as `search` still pass. |
| **Retry** | `DependencyHealthService.run()` throws transiently. The service retries (`DEGRADED_MODE_HEALTH_MAX_ATTEMPTS`, default 3, backoff `DEGRADED_MODE_HEALTH_RETRY_DELAY_MS`, default 50ms). If it still fails, it fails safe: `restricted` with every capability disabled except `admin`, or the last known cached decision. |
| **Authorization** | Reading the mode requires `ADMIN`/`MAINTAINER`; setting or clearing the manual override requires `ADMIN` (`DegradedModeAuthorizationError` → HTTP 403). |

## Endpoints

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/dependency-mode` | `ADMIN`/`MAINTAINER` | Current decision plus per-capability view. |
| `GET` | `/api/v1/dependency-mode/capabilities` | `ADMIN`/`MAINTAINER` | Per-capability availability only. |
| `POST` | `/api/v1/dependency-mode/manual` | `ADMIN` | Activate a manual window (`level`, `reason`, optional `disabledCapabilities`). |
| `DELETE` | `/api/v1/dependency-mode/manual` | `ADMIN` | Clear the manual window. |

## Using the mode as a guard

Any module can inject the exported `DependencyDegradedModeService` and guard a
capability at its boundary:

```ts
await this.degradedMode.assertCapabilityEnabled("payments");
```

This throws `DegradedModeCapabilityBlockedError` (map it to HTTP 503) when the
capability is disabled, so the enforcement point lives in one place instead of
being re-derived per feature.

## Operational edge cases

- **Cache.** Decisions are cached for `DEGRADED_MODE_CACHE_TTL_MS` (default
  5000ms). `?refresh` is not exposed; operators can wait one TTL or call the
  manual endpoints, which invalidate the cache.
- **Health probe skip.** The mode evaluation always calls
  `run({ networkProbes: false })` so it never adds outbound latency to a read
  path; configuration/database checks still run.
- **Manual override precedence.** A manual override is merged with the
  report-derived decision; the more restrictive level wins, and
  `disabledCapabilities` are unioned. It is process-local and cleared on
  restart — that is intentional, so a forgotten override cannot outlive a
  deploy.
- **Fail-safe.** If health evaluation is unavailable, the API restricts rather
  than assuming health. `admin` remains allowed to recover.

## Recovery / rollback

- The module is additive; removing it restores the previous behaviour with no
  data migration.
- To leave a degraded mode, fix the dependency (the next evaluation flips back
  automatically) or clear a manual override with `DELETE .../manual`.
- A stale manual override is harmless after restart.

## Contract preservation / migration

- `DependencyReport` / `DependencyCheckResult` are untouched.
- The mode decision is a new additive response shape; no existing route or DTO
  changed.
- New configuration is optional with safe defaults:
  `DEGRADED_MODE_HEALTH_MAX_ATTEMPTS`, `DEGRADED_MODE_HEALTH_RETRY_DELAY_MS`,
  `DEGRADED_MODE_CACHE_TTL_MS`.

## Verification

```bash
node node_modules/jest/bin/jest.js src/dependency-health/degraded-mode/degraded-mode.service.spec.ts
```

Covers the pure policy plus normal, failure, retry, fail-safe and authorization
paths.

## User-safe enforcement at the request boundary (#267)

Mark a route with `@RequiresCapability("<capability>")`
(`degraded-mode/requires-capability.decorator.ts`). The global
`DegradedModeGuard`, registered by `DegradedModeModule`, then enforces the
mode:

- **Undecorated routes** return immediately, without evaluating the mode.
- **Capability disabled:** `503` with `errorCode: SERVICE_UNAVAILABLE`,
  `retryable: true` and a `Retry-After: 30` header (delay-seconds,
  RFC 9110 §10.2.3). The message names only the capability. Dependency names,
  hosts and diagnostics stay in the operator-only `/api/v1/dependency-mode`
  endpoints and the server log.
- **Health evaluation keeps failing:** the existing fail-safe decision applies
  (`restricted`), so gated routes are blocked rather than assumed healthy.
- **Recovery:** the next evaluation (cache TTL `DEGRADED_MODE_CACHE_TTL_MS`)
  re-enables the route automatically. Clearing a manual override invalidates
  the cache immediately.
- **Authorization:** the guard is registered in an imported module, so the
  application's global auth guards run first. Anonymous callers get `401`
  and never learn the mode.

First vertical slice: `POST /payments/stellar/create` and
`POST /payments/stellar/submit` require `payments`. This matches the
degradation matrix rule that an unconfirmed payment must never be reported as
successful. Read routes such as `GET /payments/stellar/status` are not gated.

Because the mode is evaluated with `networkProbes: false`, `payments` is
disabled by:
- the database failing its `SELECT 1`;
- an unset `STELLAR_NETWORK_PASSPHRASE`;
- an invalid `STELLAR_HORIZON_URL`;
- an operator's manual `restricted` or `maintenance` override;
- the fail-safe decision when health evaluation itself keeps failing.

It is **not** disabled by Horizon being unreachable. Without network probes,
the Horizon check only validates the URL, which keeps the request path free of
outbound calls. During a Horizon outage, operators activate a manual override
(`POST /api/v1/dependency-mode/manual`) to block payment writes. Note that
Stellar now considers Horizon deprecated in favour of Stellar RPC; this
codebase's payment adapter still submits through Horizon.

**Rollback:** remove the decorator from a route. Removing the `APP_GUARD`
provider disables enforcement everywhere. No data is involved.

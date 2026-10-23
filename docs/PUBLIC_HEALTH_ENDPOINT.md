# Public dependency-aware health endpoint (#281)

`GET /api/v1/health` returns one overall verdict for load balancers, uptime
monitors and status pages. It is unauthenticated, rate limited (60/min per
client) and safe to expose.

```json
{
  "status": "degraded",
  "timestamp": "2026-10-18T12:00:00.000Z",
  "uptimeSeconds": 3600,
  "checks": [
    { "name": "database", "status": "up", "critical": true },
    { "name": "cache", "status": "up", "critical": true },
    { "name": "external-dependencies", "status": "up", "critical": true },
    { "name": "optional-dependencies", "status": "down", "critical": false }
  ]
}
```

## How the verdict is derived

| Check | Source | Critical |
| --- | --- | --- |
| `database` | `SELECT 1` through the TypeORM data source | yes |
| `cache` | Redis `PING` | only when `REDIS_URL` is set; otherwise `disabled` |
| `external-dependencies` | critical findings of the local dependency-health summary (`/health/dependencies`) | yes |
| `optional-dependencies` | advisory findings of the same summary | no |

* `ok` — every check is `up` or `disabled`. **HTTP 200.**
* `degraded` — something is slow (`HEALTH_PUBLIC_SLOW_THRESHOLD_MS`) or an
  optional dependency is impaired, but traffic can be served. **HTTP 200.**
* `down` — a critical check is `down`. **HTTP 503** with `Retry-After`.

Headers: `Cache-Control: no-store`, `X-Trellis-Health: <status>`,
`X-Trellis-Health-Cached: true|false`.

## What is never exposed

Check names come from a fixed list and states are coarse. Probe error text
(which can include hosts, ports or connection strings) is logged server-side
only. Operators who need causes, latencies and remediation use the
authenticated views: `GET /health/dependencies/diagnostics` and
`GET /status/operator` (ADMIN/MAINTAINER + admin 2FA).

The dependency summary used here runs **local checks only**: this route can
never trigger outbound requests to Horizon, RPC providers or SMTP relays, so it
cannot be used as a request amplifier.

## Load and flapping protection

| Variable | Default | Effect |
| --- | --- | --- |
| `HEALTH_PUBLIC_CACHE_TTL_MS` | `5000` | Verdict reuse window. `0` disables caching. Concurrent callers always share one in-flight evaluation. |
| `HEALTH_PUBLIC_PROBE_RETRIES` | `1` | Extra attempts for a failing critical core probe before reporting `down`. |
| `HEALTH_PUBLIC_RETRY_DELAY_MS` | `200` | Delay between those attempts. |
| `HEALTH_PUBLIC_RETRY_AFTER_SECONDS` | `15` | `Retry-After` value on 503. |
| `HEALTH_PUBLIC_SLOW_THRESHOLD_MS` | `1000` | Latency above which a reachable core dependency is `degraded`. |

## Operational edge cases

* **Redis not used by a deployment.** Leave `REDIS_URL` unset: the cache check
  is `disabled` and not critical. (Readiness still reports Redis as `down`; that
  probe is unchanged.)
* **Dependency-health disabled** (`DEPENDENCY_HEALTH_ENABLED=false`). Its checks
  report `disabled` and do not affect the verdict.
* **Dependency summary crashes.** Reported as `degraded`, never `down`: the core
  probes stay authoritative for whether the API can serve traffic.
* **A single dropped DB connection.** Retried once before the API is reported
  `down`, so one blip does not pull the instance out of a pool.
* **Stale verdict after recovery.** At most `HEALTH_PUBLIC_CACHE_TTL_MS` old.
  Lower the TTL if monitors need faster recovery detection.

## Contracts and rollback

`/health/live`, `/health/ready`, `/health/startup`, `/health/dependencies` and
`/status` are unchanged. `GET /health` is a new route, so rolling back is a
plain revert; monitors pointed at it should be pointed back at
`/health/ready` first.

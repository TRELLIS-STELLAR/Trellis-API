# Trellis — Monitoring Stack

This directory contains the operational monitoring configuration for the
Trellis API. It is the implementation of GitHub issue
[`#25`](https://github.com/SourceXXL/trellis-api/issues/25)
("Setup Application Monitoring Dashboard").

## Overview

```
┌──────────────────────┐   scrape :15s   ┌────────────┐  queries  ┌─────────┐
│ Trellis API  │ ───────────────▶│ Prometheus │ ─────────▶│ Grafana │
│ /api/v1/observability│                 └────────────┘           └─────────┘
│   /metrics           │
└──────────────────────┘
```

The API exposes a Prometheus-compatible `/metrics` endpoint (defined in
`src/observability/observability.controller.ts` and populated by Prometheus
metrics registered in `src/config/metrics.ts`). Prometheus scrapes this
endpoint, persists the time series, and Grafana visualises them.

### What gets instrumented

| Metric                                                                  | Type      | Source                                                                       |
| ----------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------- |
| `trellis_http_requests_total`                                   | Counter   | `RequestTimingMiddleware` (this issue)                                       |
| `trellis_http_request_duration_seconds`                         | Histogram | `RequestTimingMiddleware` (this issue)                                       |
| `trellis_http_requests_in_progress`                             | Gauge     | `RequestTimingMiddleware` (this issue)                                       |
| `trellis_errors_total`                                          | Counter   | `RequestTimingMiddleware` for HTTP `>=400` (this issue)                      |
| `trellis_database_query_duration_seconds`                       | Histogram | `DatabaseTimingInterceptor` / services                                       |
| `trellis_active_connections`                                    | Gauge     | services                                                                      |
| `trellis_user_signups_total` / `trellis_active_users`   | Counter   | auth services                                                                 |
| `trellis_job_duration_seconds` / `job_success_total` / `_failure_total` / `queue_length` | Histogram / Counter / Counter / Gauge | compute / queue workers |
| `trellis_baseline_p50_seconds` / `_p95` / `_p99` / `_regressions_total` | Gauge | `PerformanceBaselineService` |
| `process_cpu_*`, `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, `nodejs_eventloop_lag_seconds`, `nodejs_active_handles_total`, `nodejs_active_requests_total`, `process_uptime_seconds` | various | `prom-client` default metrics |

## Quick start

1. **Start the API**

   ```bash
   npm run start:dev
   ```

2. **Smoke-test the `/metrics` endpoint**

   ```bash
   curl -s http://localhost:3001/api/v1/observability/metrics | head -40
   ```

   You should see Prometheus exposition format output including
   `trellis_http_requests_total{...}` and the default
   `process_*` / `nodejs_*` metrics.

3. **Run a local Prometheus** (optional)

   ```bash
   docker run --rm -p 9090:9090 \
     -v "$PWD/monitoring/prometheus/prometheus.yml":/etc/prometheus/prometheus.yml \
     prom/prometheus
   ```

4. **Import the Grafana dashboard**

   - Open Grafana → Dashboards → Import.
   - Upload `monitoring/grafana/dashboards/application-overview.json`,
     or paste its contents, or use the file provisioner:

     ```yaml
     # grafana provisioning config snippet
     - name: default
       type: file
       options:
         path: /etc/grafana/provisioning/dashboards/trellis
       folders: ['Trellis']
     ```

   - Select your Prometheus datasource when prompted.

## Files

- **`grafana/dashboards/application-overview.json`** — single Grafana
  10+ dashboard with rows for *Application Performance*, *Latency
  Percentiles*, *API Endpoint Performance*, *Infrastructure*,
  *Database*, *Business Metrics*, and *Alerts & Regressions*. Includes:
  - Request & error rate panels
  - p50 / p95 / p99 latency panels
  - CPU usage (user + system) and memory (RSS, heap, external) panels
  - Database connection pool panel and query-duration p95 panel
  - Top endpoints table (request volume + p95 + error %)
  - Business metrics (signups, active users, auth activity, queue length)
  - SLO gauge panels for error budget and p95 latency
  - Stat panel for performance regressions detected
  - Auto-refresh set to **10s** with `now-1h` default time range

- **`prometheus/prometheus.yml`** — reference scrape config for the
  API. Replace the `static_configs.targets` with your real API hosts.

- **`prometheus/alerts.yml.example`** — starter SLO alerting rules
  (error rate, p95 latency, event-loop lag, memory, regressions).

## Monitoring module (`src/monitoring`)

Beyond the passive HTTP/DB instrumentation above, the `MonitoringModule`
adds active collection, in-process alerting, historical retention and a
top-level scrape endpoint. It reuses the **same** Prometheus registry
(`src/config/metrics.ts`), so everything surfaces on one scrape.

### Endpoints

| Endpoint                              | Purpose                                                        |
| ------------------------------------- | ------------------------------------------------------------- |
| `GET /metrics`                        | Prometheus text-exposition (top-level, per acceptance criteria) |
| `GET /monitoring/health`              | Composite status from resource pressure + active alerts (503 on critical) |
| `GET /monitoring/system`              | Fresh CPU / memory / disk snapshot                            |
| `GET /monitoring/alerts`              | Active alerts and all rule states                             |
| `GET/POST/DELETE /monitoring/alerts/rules` | List / upsert / delete threshold rules                   |
| `GET /monitoring/history`             | Historical KPI time series (`?since&until&limit`)            |
| `GET /monitoring/dashboard`           | Aggregated KPI summary for a dashboard UI                     |

> The token gate (`METRICS_AUTH_TOKEN`) protects both `GET /metrics` and
> the legacy `GET /observability/metrics`.

### Added metrics

| Metric                                          | Type      | Source                    |
| ----------------------------------------------- | --------- | ------------------------- |
| `trellis_system_cpu_usage_percent`      | Gauge     | `SystemMetricsService`    |
| `trellis_system_process_cpu_usage_percent` | Gauge  | `SystemMetricsService`    |
| `trellis_system_load_average`           | Gauge     | `SystemMetricsService`    |
| `trellis_system_memory_usage_bytes` / `_percent` | Gauge | `SystemMetricsService` |
| `trellis_system_disk_usage_bytes` / `_percent`   | Gauge | `SystemMetricsService` |
| `trellis_operation_duration_seconds`    | Histogram | `@Monitor` decorator      |
| `trellis_operation_total`               | Counter   | `@Monitor` decorator      |
| `trellis_alerts_active`                 | Gauge     | `AlertRulesService`       |
| `trellis_alerts_fired_total`            | Counter   | `AlertRulesService`       |

### Instrumenting an operation

```ts
import { Monitor } from "../monitoring";

class PricingService {
  @Monitor({ name: "pricing.recompute" })
  async recompute() {
    /* latency + success/error counts recorded automatically */
  }
}
```

For ad-hoc business metrics, inject `MonitoringMetricsService` and call
`incrementCounter` / `setGauge` / `observeOperation`.

### Configuration

| Env var                            | Default        | Meaning                              |
| ---------------------------------- | -------------- | ------------------------------------ |
| `MONITORING_SYSTEM_INTERVAL_MS`    | `15000`        | System sampling interval             |
| `MONITORING_DISK_MOUNT`            | `/` (`C:\` win)| Mount reported for disk usage        |
| `MONITORING_ALERT_INTERVAL_MS`     | `30000`        | Alert-rule evaluation interval       |
| `MONITORING_HISTORY_INTERVAL_MS`   | `15000`        | Historical capture interval          |
| `MONITORING_HISTORY_RETENTION_MS`  | `86400000`     | History retention window (24h)       |
| `MONITORING_HISTORY_MAX_POINTS`    | `5760`         | Hard cap on retained points          |

## Customisation tips

- **Add metric labels.** Custom labels should be bounded (fixed value
  set per environment, not request-derived) or the cardinality will
  explode. The middleware in `src/observability/request-timing.middleware.ts`
  normalises UUIDs, hex addresses and high-entropy numeric IDs to
  `:uuid` / `:address` / `:hash` / `:id` before labelling — keep this
  pattern when adding new observed values.
- **Tune the SLO thresholds** in
  `monitoring/grafana/dashboards/application-overview.json` (gauge
  panels with id `20` and `21`) to match your operational targets.
- **Multiple jobs/environments.** The dashboard exposes a `$job`
  template variable driven by Prometheus' `job` label, so the same
  dashboard works across dev / staging / prod.

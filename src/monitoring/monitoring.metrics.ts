import client from "prom-client";
import { register } from "../config/metrics";

/**
 * Additional Prometheus metrics owned by the monitoring module.
 *
 * These are registered against the *same* shared registry defined in
 * `src/config/metrics.ts`, so they surface on every metrics endpoint alongside
 * the HTTP, database and baseline metrics that already exist. Keeping a single
 * registry avoids the "metric registered twice" errors prom-client throws when
 * the same name is added to two registries.
 *
 * `getOrCreate*` helpers make the definitions idempotent. Jest re-imports
 * modules between test files within the same worker, and decorators may run
 * before the module is imported, so a metric can legitimately be requested more
 * than once. Rather than let prom-client throw, we reuse the already-registered
 * collector.
 */

const PREFIX = "trellis_";

function getOrCreateGauge(
  config: client.GaugeConfiguration<string>,
): client.Gauge {
  const existing = register.getSingleMetric(config.name);
  if (existing) return existing as client.Gauge;
  return new client.Gauge({ ...config, registers: [register] });
}

function getOrCreateCounter(
  config: client.CounterConfiguration<string>,
): client.Counter {
  const existing = register.getSingleMetric(config.name);
  if (existing) return existing as client.Counter;
  return new client.Counter({ ...config, registers: [register] });
}

function getOrCreateHistogram(
  config: client.HistogramConfiguration<string>,
): client.Histogram {
  const existing = register.getSingleMetric(config.name);
  if (existing) return existing as client.Histogram;
  return new client.Histogram({ ...config, registers: [register] });
}

// ---------------------------------------------------------------------------
// System metrics — sampled periodically by SystemMetricsService.
// ---------------------------------------------------------------------------

export const systemCpuUsagePercent = getOrCreateGauge({
  name: `${PREFIX}system_cpu_usage_percent`,
  help: "System-wide CPU utilisation as a percentage (0-100)",
});

export const processCpuUsagePercent = getOrCreateGauge({
  name: `${PREFIX}system_process_cpu_usage_percent`,
  help: "CPU utilisation of this process as a percentage (0-100)",
});

export const systemLoadAverage = getOrCreateGauge({
  name: `${PREFIX}system_load_average`,
  help: "System load average",
  labelNames: ["period"],
});

export const systemMemoryUsageBytes = getOrCreateGauge({
  name: `${PREFIX}system_memory_usage_bytes`,
  help: "Memory usage in bytes broken down by kind",
  labelNames: ["type"],
});

export const systemMemoryUsagePercent = getOrCreateGauge({
  name: `${PREFIX}system_memory_usage_percent`,
  help: "Used system memory as a percentage of total (0-100)",
});

export const systemDiskUsageBytes = getOrCreateGauge({
  name: `${PREFIX}system_disk_usage_bytes`,
  help: "Disk usage in bytes broken down by kind",
  labelNames: ["mount", "type"],
});

export const systemDiskUsagePercent = getOrCreateGauge({
  name: `${PREFIX}system_disk_usage_percent`,
  help: "Used disk space as a percentage of total (0-100)",
  labelNames: ["mount"],
});

// ---------------------------------------------------------------------------
// Custom operation metrics — populated by the @Monitor decorator so any method
// can be instrumented without hand-rolling collectors.
// ---------------------------------------------------------------------------

export const customOperationDuration = getOrCreateHistogram({
  name: `${PREFIX}operation_duration_seconds`,
  help: "Duration of instrumented operations in seconds",
  labelNames: ["operation", "status"],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
});

export const customOperationTotal = getOrCreateCounter({
  name: `${PREFIX}operation_total`,
  help: "Total number of instrumented operation invocations",
  labelNames: ["operation", "status"],
});

// ---------------------------------------------------------------------------
// Alerting metrics — mirror the AlertRulesService state so alert status is
// itself scrapeable (useful for meta-alerting / dashboards).
// ---------------------------------------------------------------------------

export const alertsActive = getOrCreateGauge({
  name: `${PREFIX}alerts_active`,
  help: "Number of alert rules currently in the firing state",
  labelNames: ["severity"],
});

export const alertsFiredTotal = getOrCreateCounter({
  name: `${PREFIX}alerts_fired_total`,
  help: "Total number of times alert rules have transitioned into firing",
  labelNames: ["rule", "severity"],
});

export { register };

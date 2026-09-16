import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SystemMetricsService } from "./system-metrics.service";
import { alertsActive, alertsFiredTotal } from "./monitoring.metrics";

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertComparison = "gt" | "gte" | "lt" | "lte";
export type AlertState = "ok" | "firing";

/**
 * A configurable threshold rule evaluated against a scalar metric value.
 */
export interface AlertRule {
  /** Stable, unique identifier used as a metric label and for dedup. */
  id: string;
  description: string;
  severity: AlertSeverity;
  /** Which scalar the rule watches. */
  metric: AlertMetricKey;
  comparison: AlertComparison;
  threshold: number;
  /**
   * Number of consecutive breaching evaluations required before the alert
   * transitions to firing. Debounces transient spikes. Default 1.
   */
  forEvaluations?: number;
}

/**
 * The scalar signals the engine knows how to read. Kept deliberately small and
 * explicit rather than accepting arbitrary PromQL — the built-in engine is for
 * fast in-process threshold checks, while richer alerting lives in Prometheus
 * (see `monitoring/prometheus/alerts.yml.example`).
 */
export type AlertMetricKey =
  | "system_cpu_usage_percent"
  | "process_cpu_usage_percent"
  | "system_memory_usage_percent"
  | "system_disk_usage_percent"
  | "process_heap_used_bytes"
  | "event_loop_lag_seconds";

export interface ActiveAlert {
  rule: AlertRule;
  state: AlertState;
  value: number;
  since: string;
  lastEvaluatedAt: string;
  message: string;
}

const DEFAULT_RULES: AlertRule[] = [
  {
    id: "high-cpu-usage",
    description: "System CPU usage above 85%",
    severity: "warning",
    metric: "system_cpu_usage_percent",
    comparison: "gt",
    threshold: 85,
    forEvaluations: 3,
  },
  {
    id: "high-memory-usage",
    description: "System memory usage above 90%",
    severity: "critical",
    metric: "system_memory_usage_percent",
    comparison: "gt",
    threshold: 90,
    forEvaluations: 2,
  },
  {
    id: "high-disk-usage",
    description: "Disk usage above 90%",
    severity: "critical",
    metric: "system_disk_usage_percent",
    comparison: "gt",
    threshold: 90,
    forEvaluations: 1,
  },
];

/**
 * Evaluates configurable metric thresholds on a timer and tracks the
 * firing/resolved state of each rule. Firing transitions are logged and
 * reflected into the `trellis_alerts_active` /
 * `trellis_alerts_fired_total` metrics so alert state is scrapeable.
 */
@Injectable()
export class AlertRulesService implements OnModuleDestroy {
  private readonly logger = new Logger(AlertRulesService.name);
  private readonly intervalMs: number;
  private readonly rules = new Map<string, AlertRule>();
  private readonly states = new Map<string, ActiveAlert>();
  private readonly breachStreak = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly systemMetrics: SystemMetricsService,
    private readonly configService?: ConfigService,
  ) {
    this.intervalMs =
      Number(this.configService?.get("MONITORING_ALERT_INTERVAL_MS")) || 30000;
    for (const rule of DEFAULT_RULES) this.rules.set(rule.id, rule);
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      try {
        this.evaluate();
      } catch (err: any) {
        this.logger.warn(`Alert evaluation failed: ${err.message}`);
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Register or replace an alert rule. */
  upsertRule(rule: AlertRule): AlertRule {
    this.rules.set(rule.id, rule);
    return rule;
  }

  /** Remove a rule and any tracked state for it. Returns true if it existed. */
  removeRule(id: string): boolean {
    this.states.delete(id);
    this.breachStreak.delete(id);
    return this.rules.delete(id);
  }

  listRules(): AlertRule[] {
    return Array.from(this.rules.values());
  }

  /** All rules currently in the firing state. */
  getActiveAlerts(): ActiveAlert[] {
    return Array.from(this.states.values()).filter((a) => a.state === "firing");
  }

  /** State for every rule that has been evaluated at least once. */
  getAllAlertStates(): ActiveAlert[] {
    return Array.from(this.states.values());
  }

  /**
   * Read the current scalar value for a metric key, or null if it can't be
   * resolved yet (e.g. before the first system sample).
   */
  private readMetric(key: AlertMetricKey): number | null {
    const snapshot = this.systemMetrics.getLatest();
    switch (key) {
      case "system_cpu_usage_percent":
        return snapshot?.cpu.usagePercent ?? null;
      case "process_cpu_usage_percent":
        return snapshot?.cpu.processUsagePercent ?? null;
      case "system_memory_usage_percent":
        return snapshot?.memory.usagePercent ?? null;
      case "system_disk_usage_percent":
        return snapshot?.disk?.usagePercent ?? null;
      case "process_heap_used_bytes":
        return process.memoryUsage().heapUsed;
      case "event_loop_lag_seconds":
        return null; // Reserved: sourced from prom-client default metrics.
      default:
        return null;
    }
  }

  private breaches(value: number, rule: AlertRule): boolean {
    switch (rule.comparison) {
      case "gt":
        return value > rule.threshold;
      case "gte":
        return value >= rule.threshold;
      case "lt":
        return value < rule.threshold;
      case "lte":
        return value <= rule.threshold;
      default:
        return false;
    }
  }

  /**
   * Evaluate every rule once. Public so tests and the controller can trigger a
   * synchronous evaluation without waiting for the timer.
   */
  evaluate(): ActiveAlert[] {
    const now = new Date().toISOString();
    // Aggregate active counts per severity so the gauge reflects reality even
    // when a rule resolves.
    const activeBySeverity: Record<AlertSeverity, number> = {
      info: 0,
      warning: 0,
      critical: 0,
    };

    for (const rule of this.rules.values()) {
      const value = this.readMetric(rule.metric);
      if (value === null) continue;

      const required = Math.max(1, rule.forEvaluations ?? 1);
      const breaching = this.breaches(value, rule);
      const streak = breaching ? (this.breachStreak.get(rule.id) ?? 0) + 1 : 0;
      this.breachStreak.set(rule.id, streak);

      const prev = this.states.get(rule.id);
      const shouldFire = streak >= required;
      const newState: AlertState = shouldFire ? "firing" : "ok";

      const message = shouldFire
        ? `${rule.description} — current ${value} ${rule.comparison} ${rule.threshold}`
        : `${rule.description} — ok (current ${value})`;

      // Detect transitions for logging + counters.
      if (newState === "firing" && prev?.state !== "firing") {
        this.logger.warn(`🔥 Alert firing: ${rule.id} — ${message}`);
        alertsFiredTotal.labels(rule.id, rule.severity).inc();
      } else if (newState === "ok" && prev?.state === "firing") {
        this.logger.log(`✅ Alert resolved: ${rule.id}`);
      }

      this.states.set(rule.id, {
        rule,
        state: newState,
        value,
        since: newState === prev?.state && prev ? prev.since : now,
        lastEvaluatedAt: now,
        message,
      });

      if (newState === "firing") activeBySeverity[rule.severity] += 1;
    }

    alertsActive.labels("info").set(activeBySeverity.info);
    alertsActive.labels("warning").set(activeBySeverity.warning);
    alertsActive.labels("critical").set(activeBySeverity.critical);

    return this.getActiveAlerts();
  }
}

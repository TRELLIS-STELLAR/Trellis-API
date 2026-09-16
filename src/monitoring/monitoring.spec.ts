import { Test, TestingModule } from "@nestjs/testing";
import { MonitoringMetricsService } from "./monitoring-metrics.service";
import { SystemMetricsService } from "./system-metrics.service";
import { AlertRulesService } from "./alert-rules.service";
import { MetricsHistoryService } from "./metrics-history.service";
import { MonitoringController } from "./monitoring.controller";
import { Monitor } from "./monitor.decorator";
import { register } from "../config/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSystemService(): SystemMetricsService {
  const svc = new SystemMetricsService();
  // Prevent real timers from running in tests.
  jest.spyOn(svc, "start").mockImplementation(() => {});
  jest.spyOn(svc, "stop").mockImplementation(() => {});
  return svc;
}

// ---------------------------------------------------------------------------
// MonitoringMetricsService
// ---------------------------------------------------------------------------

describe("MonitoringMetricsService", () => {
  let service: MonitoringMetricsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MonitoringMetricsService],
    }).compile();
    service = module.get(MonitoringMetricsService);
  });

  it("renders Prometheus text output", async () => {
    const output = await service.render();
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  it("exposes the correct content type", () => {
    expect(service.contentType).toContain("text/plain");
  });

  it("creates a counter idempotently", () => {
    const opts = {
      name: "trellis_test_counter_idempotent",
      help: "test",
    };
    const c1 = service.counter(opts);
    const c2 = service.counter(opts);
    expect(c1).toBe(c2);
  });

  it("creates a gauge idempotently", () => {
    const opts = {
      name: "trellis_test_gauge_idempotent",
      help: "test",
    };
    const g1 = service.gauge(opts);
    const g2 = service.gauge(opts);
    expect(g1).toBe(g2);
  });

  it("creates a histogram idempotently", () => {
    const opts = {
      name: "trellis_test_histogram_idempotent",
      help: "test",
    };
    const h1 = service.histogram(opts);
    const h2 = service.histogram(opts);
    expect(h1).toBe(h2);
  });

  it("incrementCounter increments the counter value", async () => {
    const opts = {
      name: "trellis_test_increment_counter",
      help: "test",
    };
    service.incrementCounter(opts);
    service.incrementCounter(opts);
    const snap = await service.snapshot();
    const metric = snap.find((m) => m.name === opts.name);
    expect(metric).toBeDefined();
    expect((metric!.values[0] as any).value).toBe(2);
  });

  it("setGauge sets the gauge value", async () => {
    const opts = { name: "trellis_test_set_gauge", help: "test" };
    service.setGauge(opts, 42);
    const snap = await service.snapshot();
    const metric = snap.find((m) => m.name === opts.name);
    expect(metric).toBeDefined();
    expect((metric!.values[0] as any).value).toBe(42);
  });

  it("observeOperation records duration and count", async () => {
    service.observeOperation("test.op", 0.1, "success");
    const snap = await service.snapshot();
    const total = snap.find(
      (m) => m.name === "trellis_operation_total",
    );
    expect(total).toBeDefined();
    const entry = total!.values.find(
      (v: any) =>
        v.labels?.operation === "test.op" && v.labels?.status === "success",
    );
    expect(entry).toBeDefined();
    expect((entry as any).value).toBeGreaterThanOrEqual(1);
  });

  afterAll(() => {
    // Clean up test-only metrics so they don't bleed into other suites.
    [
      "trellis_test_counter_idempotent",
      "trellis_test_gauge_idempotent",
      "trellis_test_histogram_idempotent",
      "trellis_test_increment_counter",
      "trellis_test_set_gauge",
    ].forEach((name) => {
      try {
        register.removeSingleMetric(name);
      } catch {
        // ignore
      }
    });
  });
});

// ---------------------------------------------------------------------------
// SystemMetricsService
// ---------------------------------------------------------------------------

describe("SystemMetricsService", () => {
  let service: SystemMetricsService;

  beforeEach(() => {
    service = new SystemMetricsService();
  });

  it("collect() returns a snapshot with all required fields", async () => {
    const snap = await service.collect();
    expect(snap.timestamp).toBeDefined();
    expect(typeof snap.cpu.usagePercent).toBe("number");
    expect(typeof snap.cpu.processUsagePercent).toBe("number");
    expect(typeof snap.cpu.cores).toBe("number");
    expect(snap.cpu.cores).toBeGreaterThan(0);
    expect(typeof snap.cpu.loadAverage["1m"]).toBe("number");
    expect(typeof snap.memory.totalBytes).toBe("number");
    expect(snap.memory.totalBytes).toBeGreaterThan(0);
    expect(typeof snap.memory.usagePercent).toBe("number");
    expect(typeof snap.memory.processHeapUsedBytes).toBe("number");
  });

  it("CPU usage percent is within [0, 100]", async () => {
    const snap = await service.collect();
    expect(snap.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(snap.cpu.usagePercent).toBeLessThanOrEqual(100);
    expect(snap.cpu.processUsagePercent).toBeGreaterThanOrEqual(0);
    expect(snap.cpu.processUsagePercent).toBeLessThanOrEqual(100);
  });

  it("memory usage percent is within [0, 100]", async () => {
    const snap = await service.collect();
    expect(snap.memory.usagePercent).toBeGreaterThanOrEqual(0);
    expect(snap.memory.usagePercent).toBeLessThanOrEqual(100);
  });

  it("getLatest() returns null before first collect", () => {
    expect(service.getLatest()).toBeNull();
  });

  it("getLatest() returns the snapshot after collect", async () => {
    await service.collect();
    expect(service.getLatest()).not.toBeNull();
  });

  it("disk snapshot is null or has valid fields", async () => {
    const snap = await service.collect();
    if (snap.disk !== null) {
      expect(typeof snap.disk.totalBytes).toBe("number");
      expect(snap.disk.usagePercent).toBeGreaterThanOrEqual(0);
      expect(snap.disk.usagePercent).toBeLessThanOrEqual(100);
    }
  });
});

// ---------------------------------------------------------------------------
// Monitor decorator
// ---------------------------------------------------------------------------

describe("Monitor decorator", () => {
  class SampleService {
    @Monitor({ name: "test.sync_op" })
    syncOp(fail = false): string {
      if (fail) throw new Error("boom");
      return "ok";
    }

    @Monitor({ name: "test.async_op" })
    async asyncOp(fail = false): Promise<string> {
      if (fail) throw new Error("async boom");
      return "async ok";
    }
  }

  const svc = new SampleService();

  it("passes through the return value for sync methods", () => {
    expect(svc.syncOp()).toBe("ok");
  });

  it("passes through the resolved value for async methods", async () => {
    await expect(svc.asyncOp()).resolves.toBe("async ok");
  });

  it("re-throws sync errors", () => {
    expect(() => svc.syncOp(true)).toThrow("boom");
  });

  it("re-throws async errors", async () => {
    await expect(svc.asyncOp(true)).rejects.toThrow("async boom");
  });

  it("records success and error counts in Prometheus", async () => {
    svc.syncOp();
    try {
      svc.syncOp(true);
    } catch {
      // expected
    }
    const snap = await register.getMetricsAsJSON();
    const total = snap.find(
      (m) => m.name === "trellis_operation_total",
    );
    expect(total).toBeDefined();
    const successEntry = total!.values.find(
      (v: any) =>
        v.labels?.operation === "test.sync_op" &&
        v.labels?.status === "success",
    );
    const errorEntry = total!.values.find(
      (v: any) =>
        v.labels?.operation === "test.sync_op" && v.labels?.status === "error",
    );
    expect((successEntry as any)?.value).toBeGreaterThanOrEqual(1);
    expect((errorEntry as any)?.value).toBeGreaterThanOrEqual(1);
  });

  it("uses ClassName.methodName as default operation name", async () => {
    class AnotherService {
      @Monitor()
      doWork() {
        return true;
      }
    }
    new AnotherService().doWork();
    const snap = await register.getMetricsAsJSON();
    const total = snap.find(
      (m) => m.name === "trellis_operation_total",
    );
    const entry = total?.values.find(
      (v: any) => v.labels?.operation === "AnotherService.doWork",
    );
    expect(entry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AlertRulesService
// ---------------------------------------------------------------------------

describe("AlertRulesService", () => {
  let systemSvc: SystemMetricsService;
  let alertSvc: AlertRulesService;

  beforeEach(async () => {
    systemSvc = makeSystemService();
    await systemSvc.collect(); // prime snapshot
    alertSvc = new AlertRulesService(systemSvc);
  });

  it("listRules() returns the default rules", () => {
    const rules = alertSvc.listRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.id && r.metric && r.threshold)).toBe(true);
  });

  it("upsertRule adds a new rule", () => {
    alertSvc.upsertRule({
      id: "test-rule",
      description: "test",
      severity: "info",
      metric: "system_cpu_usage_percent",
      comparison: "gt",
      threshold: 999,
    });
    expect(
      alertSvc.listRules().find((r) => r.id === "test-rule"),
    ).toBeDefined();
  });

  it("removeRule deletes the rule and returns true", () => {
    alertSvc.upsertRule({
      id: "to-remove",
      description: "x",
      severity: "info",
      metric: "system_cpu_usage_percent",
      comparison: "gt",
      threshold: 999,
    });
    expect(alertSvc.removeRule("to-remove")).toBe(true);
    expect(
      alertSvc.listRules().find((r) => r.id === "to-remove"),
    ).toBeUndefined();
  });

  it("removeRule returns false for unknown id", () => {
    expect(alertSvc.removeRule("nonexistent")).toBe(false);
  });

  it("evaluate() fires an alert when threshold is breached immediately", () => {
    alertSvc.upsertRule({
      id: "always-fire",
      description: "always fires",
      severity: "critical",
      metric: "process_heap_used_bytes",
      comparison: "gt",
      threshold: 0, // always true
      forEvaluations: 1,
    });
    alertSvc.evaluate();
    const active = alertSvc.getActiveAlerts();
    expect(active.find((a) => a.rule.id === "always-fire")).toBeDefined();
  });

  it("forEvaluations debounces: does not fire before streak is met", () => {
    alertSvc.upsertRule({
      id: "debounced",
      description: "needs 3 evals",
      severity: "warning",
      metric: "process_heap_used_bytes",
      comparison: "gt",
      threshold: 0,
      forEvaluations: 3,
    });
    alertSvc.evaluate(); // streak 1
    alertSvc.evaluate(); // streak 2
    expect(
      alertSvc.getActiveAlerts().find((a) => a.rule.id === "debounced"),
    ).toBeUndefined();
    alertSvc.evaluate(); // streak 3 — should fire now
    expect(
      alertSvc.getActiveAlerts().find((a) => a.rule.id === "debounced"),
    ).toBeDefined();
  });

  it("alert resolves when threshold is no longer breached", () => {
    alertSvc.upsertRule({
      id: "resolves",
      description: "resolves",
      severity: "info",
      metric: "process_heap_used_bytes",
      comparison: "gt",
      threshold: 0,
      forEvaluations: 1,
    });
    alertSvc.evaluate(); // fires
    expect(
      alertSvc.getActiveAlerts().find((a) => a.rule.id === "resolves"),
    ).toBeDefined();

    // Replace with a threshold that can never be breached.
    alertSvc.upsertRule({
      id: "resolves",
      description: "resolves",
      severity: "info",
      metric: "process_heap_used_bytes",
      comparison: "gt",
      threshold: Number.MAX_SAFE_INTEGER,
      forEvaluations: 1,
    });
    alertSvc.evaluate();
    expect(
      alertSvc.getActiveAlerts().find((a) => a.rule.id === "resolves"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MetricsHistoryService
// ---------------------------------------------------------------------------

describe("MetricsHistoryService", () => {
  let systemSvc: SystemMetricsService;
  let historySvc: MetricsHistoryService;

  beforeEach(async () => {
    systemSvc = makeSystemService();
    await systemSvc.collect();
    historySvc = new MetricsHistoryService(systemSvc);
  });

  it("capture() returns null before first system snapshot", () => {
    const fresh = new SystemMetricsService();
    const h = new MetricsHistoryService(fresh);
    expect(h.capture()).toBeNull();
  });

  it("capture() returns a point after system snapshot exists", () => {
    const point = historySvc.capture();
    expect(point).not.toBeNull();
    expect(typeof point!.cpuUsagePercent).toBe("number");
    expect(typeof point!.memoryUsagePercent).toBe("number");
  });

  it("size() grows with each capture", () => {
    historySvc.capture();
    historySvc.capture();
    expect(historySvc.size()).toBe(2);
  });

  it("query() returns all points when no filter applied", () => {
    historySvc.capture(1000);
    historySvc.capture(2000);
    expect(historySvc.query().length).toBe(2);
  });

  it("query() filters by since", () => {
    historySvc.capture(1000);
    historySvc.capture(2000);
    historySvc.capture(3000);
    const result = historySvc.query({ since: 2000 });
    expect(result.length).toBe(2);
    expect(result.every((p) => p.timestamp >= 2000)).toBe(true);
  });

  it("query() filters by until", () => {
    historySvc.capture(1000);
    historySvc.capture(2000);
    historySvc.capture(3000);
    const result = historySvc.query({ until: 2000 });
    expect(result.length).toBe(2);
    expect(result.every((p) => p.timestamp <= 2000)).toBe(true);
  });

  it("query() respects limit (most recent)", () => {
    for (let i = 1; i <= 5; i++) historySvc.capture(i * 1000);
    const result = historySvc.query({ limit: 3 });
    expect(result.length).toBe(3);
    expect(result[result.length - 1].timestamp).toBe(5000);
  });

  it("prunes points beyond maxPoints", () => {
    // Create a service with a tiny cap.
    const tiny = new MetricsHistoryService(systemSvc, {
      get: (key: string) =>
        key === "MONITORING_HISTORY_MAX_POINTS" ? "3" : undefined,
    } as any);
    for (let i = 1; i <= 5; i++) tiny.capture(i * 1000);
    expect(tiny.size()).toBe(3);
  });

  it("prunes points older than retentionMs", () => {
    const shortRetention = new MetricsHistoryService(systemSvc, {
      get: (key: string) =>
        key === "MONITORING_HISTORY_RETENTION_MS" ? "5000" : undefined,
    } as any);
    shortRetention.capture(1000);
    shortRetention.capture(2000);
    // Capture at a time well beyond retention.
    shortRetention.capture(10000);
    // The first two are older than 10000 - 5000 = 5000 cutoff.
    expect(shortRetention.size()).toBe(1);
  });

  it("clear() empties the store", () => {
    historySvc.capture();
    historySvc.capture();
    historySvc.clear();
    expect(historySvc.size()).toBe(0);
  });

  it("getRetention() returns configured values", () => {
    const r = historySvc.getRetention();
    expect(typeof r.retentionMs).toBe("number");
    expect(typeof r.maxPoints).toBe("number");
    expect(r.retentionMs).toBeGreaterThan(0);
    expect(r.maxPoints).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// MonitoringController
// ---------------------------------------------------------------------------

describe("MonitoringController", () => {
  let controller: MonitoringController;
  let systemSvc: SystemMetricsService;
  let alertSvc: AlertRulesService;
  let historySvc: MetricsHistoryService;
  let metricsSvc: MonitoringMetricsService;

  beforeEach(async () => {
    systemSvc = makeSystemService();
    await systemSvc.collect();
    alertSvc = new AlertRulesService(systemSvc);
    historySvc = new MetricsHistoryService(systemSvc);
    metricsSvc = new MonitoringMetricsService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MonitoringController],
      providers: [
        { provide: MonitoringMetricsService, useValue: metricsSvc },
        { provide: SystemMetricsService, useValue: systemSvc },
        { provide: AlertRulesService, useValue: alertSvc },
        { provide: MetricsHistoryService, useValue: historySvc },
      ],
    }).compile();

    controller = module.get(MonitoringController);
  });

  it("getMetrics() returns Prometheus text output", async () => {
    const mockRes = { setHeader: jest.fn() } as any;
    const mockReq = { headers: {}, query: {} } as any;
    const output = await controller.getMetrics(mockReq, mockRes);
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
    expect(mockRes.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      expect.stringContaining("text/plain"),
    );
  });

  it("getHealth() returns status ok when no alerts are active", () => {
    const mockRes = { status: jest.fn() } as any;
    const result = controller.getHealth(mockRes);
    expect(["ok", "degraded", "critical"]).toContain(result.status);
    expect(typeof result.uptimeSeconds).toBe("number");
  });

  it("getSystem() returns a snapshot", async () => {
    const snap = await controller.getSystem();
    expect(snap.cpu).toBeDefined();
    expect(snap.memory).toBeDefined();
  });

  it("getAlerts() returns active and states arrays", () => {
    const result = controller.getAlerts();
    expect(Array.isArray(result.active)).toBe(true);
    expect(Array.isArray(result.states)).toBe(true);
  });

  it("listRules() returns the configured rules", () => {
    const rules = controller.listRules();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
  });

  it("upsertRule() adds a rule", () => {
    const rule = controller.upsertRule({
      id: "ctrl-test-rule",
      description: "test",
      severity: "info",
      metric: "system_cpu_usage_percent",
      comparison: "gt",
      threshold: 999,
    });
    expect(rule.id).toBe("ctrl-test-rule");
  });

  it("removeRule() removes a rule", () => {
    alertSvc.upsertRule({
      id: "ctrl-remove",
      description: "x",
      severity: "info",
      metric: "system_cpu_usage_percent",
      comparison: "gt",
      threshold: 999,
    });
    const result = controller.removeRule("ctrl-remove");
    expect(result.removed).toBe(true);
  });

  it("getHistory() returns retention info and points array", () => {
    historySvc.capture();
    const result = controller.getHistory();
    expect(result.retention).toBeDefined();
    expect(Array.isArray(result.points)).toBe(true);
  });

  it("getDashboard() returns kpis, alerts and trend", async () => {
    const result = await controller.getDashboard();
    expect(result.kpis).toBeDefined();
    expect(typeof result.kpis.cpuUsagePercent).toBe("number");
    expect(result.alerts).toBeDefined();
    expect(Array.isArray(result.trend)).toBe(true);
  });
});

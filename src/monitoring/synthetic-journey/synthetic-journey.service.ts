import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  SyntheticJourneyEngine,
  SyntheticJourneyReport,
  SyntheticJourneyOptions,
  DependencyBlameTarget,
  SyntheticJourneyStepDefinition,
} from "./synthetic-journey.engine";
import { MonitoringMetricsService } from "../monitoring-metrics.service";

/**
 * Synthetic Journey Monitor Service.
 *
 * Wraps the framework-agnostic SyntheticJourneyEngine into NestJS lifecycle,
 * emits Prometheus metrics to MonitoringMetricsService, and connects to config.
 */
@Injectable()
export class SyntheticJourneyMonitorService {
  private readonly logger = new Logger(SyntheticJourneyMonitorService.name);
  private readonly engine: SyntheticJourneyEngine;
  private readonly configService?: ConfigService;
  private readonly metricsService?: MonitoringMetricsService;

  constructor(
    @Optional() configService?: ConfigService,
    @Optional() metricsService?: MonitoringMetricsService,
  ) {
    this.configService = configService;
    this.metricsService = metricsService;
    this.engine = new SyntheticJourneyEngine();
  }

  getEngine(): SyntheticJourneyEngine {
    return this.engine;
  }

  attributeBlame(
    stepDef: SyntheticJourneyStepDefinition,
    err: any,
  ): { blame: DependencyBlameTarget; remediation: string } {
    return this.engine.attributeBlame(stepDef, err);
  }

  async runJourney(options: SyntheticJourneyOptions = {}): Promise<SyntheticJourneyReport> {
    const report = await this.engine.runJourney(options);
    this.recordMetrics(report);
    this.logger.log(
      `Synthetic journey completed: ${report.journeyId} status=${report.status} duration=${report.durationMs}ms passed=${report.passedSteps}/${report.totalSteps}`,
    );
    return report;
  }

  private recordMetrics(report: SyntheticJourneyReport): void {
    if (!this.metricsService) return;

    try {
      this.metricsService.incrementCounter(
        {
          name: "trellis_synthetic_journey_runs_total",
          help: "Total count of synthetic journey monitoring runs",
          labelNames: ["journey_name", "status", "trigger"],
        },
        {
          journey_name: report.journeyName,
          status: report.status,
          trigger: report.runTrigger,
        },
      );

      this.metricsService.gauge({
        name: "trellis_synthetic_journey_duration_ms",
        help: "Duration of synthetic journey monitoring run in milliseconds",
        labelNames: ["journey_name", "status"],
      }).set({ journey_name: report.journeyName, status: report.status }, report.durationMs);

      for (const step of report.steps) {
        this.metricsService.gauge({
          name: "trellis_synthetic_journey_step_duration_ms",
          help: "Duration of individual synthetic journey step in milliseconds",
          labelNames: ["step_id", "target_service", "dependency", "status"],
        }).set(
          {
            step_id: step.stepId,
            target_service: step.targetService,
            dependency: step.dependency,
            status: step.status,
          },
          step.latencyMs,
        );
      }
    } catch (err: any) {
      this.logger.warn(`Failed to record synthetic telemetry metrics: ${err.message}`);
    }
  }

  async getLatestReport(autoTriggerIfEmpty = true): Promise<SyntheticJourneyReport> {
    return this.engine.getLatestReport(autoTriggerIfEmpty);
  }

  startScheduler(intervalMs = 60000): void {
    this.logger.log(`Starting synthetic journey background scheduler (interval: ${intervalMs}ms)`);
    this.engine.startScheduler(intervalMs, (report) => {
      this.recordMetrics(report);
    });
  }

  stopScheduler(): void {
    this.engine.stopScheduler();
    this.logger.log("Synthetic journey background scheduler stopped.");
  }
}

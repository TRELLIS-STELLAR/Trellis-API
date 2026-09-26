import { Module, OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MonitoringController } from "./monitoring.controller";
import { MonitoringMetricsService } from "./monitoring-metrics.service";
import { SystemMetricsService } from "./system-metrics.service";
import { AlertRulesService } from "./alert-rules.service";
import { MetricsHistoryService } from "./metrics-history.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OperationalHealthController } from "./operational-health.controller";
import { OperationalHealthService } from "./operational-health.service";
import { StellarTransaction } from "../reconciliation/entities/stellar-transaction.entity";
import { ReconciliationInvoice } from "../reconciliation/entities/reconciliation-invoice.entity";
import { WebhookDeadLetter } from "../infrastructure/webhooks/entities/webhook-dead-letter.entity";
import { PartialFailure } from "./entities/partial-failure.entity";
import { PartialFailureController } from "./partial-failure.controller";
import { PartialFailureService } from "./partial-failure.service";

/**
 * Comprehensive monitoring & metrics module.
 *
 * Wires together:
 *  - {@link MonitoringMetricsService} — facade over the shared Prometheus registry
 *  - {@link SystemMetricsService}    — periodic CPU/memory/disk sampling
 *  - {@link AlertRulesService}       — configurable threshold alerting
 *  - {@link MetricsHistoryService}   — retained historical KPI time series
 *  - {@link MonitoringController}    — /metrics, health, alerts, history, dashboard
 *
 * The three timer-driven services are started in {@link onModuleInit} rather
 * than in their constructors so importing the module (e.g. in a unit test) does
 * not spawn background intervals.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([StellarTransaction, ReconciliationInvoice, WebhookDeadLetter, PartialFailure]),
  ],
  controllers: [MonitoringController, OperationalHealthController, PartialFailureController],
  providers: [
    MonitoringMetricsService,
    SystemMetricsService,
    AlertRulesService,
    MetricsHistoryService,
    OperationalHealthService,
    PartialFailureService,
  ],
  exports: [
    MonitoringMetricsService,
    SystemMetricsService,
    AlertRulesService,
    MetricsHistoryService,
    OperationalHealthService,
    PartialFailureService,
  ],
})
export class MonitoringModule implements OnModuleInit {
  constructor(
    private readonly systemMetrics: SystemMetricsService,
    private readonly alerts: AlertRulesService,
    private readonly history: MetricsHistoryService,
  ) {}

  onModuleInit(): void {
    this.systemMetrics.start();
    this.alerts.start();
    this.history.start();
  }
}

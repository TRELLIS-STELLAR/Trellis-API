import { Injectable, Logger } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import client from "prom-client";
import { register } from "../config/metrics";
import {
  businessOperationDuration,
  businessOperationTotal,
  businessFailureTotal,
  conversionFunnelTotal,
} from "../monitoring/monitoring.metrics";

export type DbWriteOperation = "save" | "insert" | "update" | "delete";

function getOrCreateHistogram(
  config: client.HistogramConfiguration<string>,
): client.Histogram {
  const existing = register.getSingleMetric(config.name);
  if (existing) return existing as client.Histogram;
  return new client.Histogram({ ...config, registers: [register] });
}

export const dbWriteDuration = getOrCreateHistogram({
  name: "db_write_duration_seconds",
  help: "Duration of database write operations in seconds",
  labelNames: ["operation", "entity", "status"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1.0, 5.0],
});

export interface RecordDbWriteOptions {
  operation: DbWriteOperation;
  entity?: string;
  durationSeconds: number;
  status?: "success" | "failure" | OperationResult;
}

export interface StartDbWriteTimerOptions {
  entity?: string;
}

export type OperationResult = "success" | "failure";
export type FunnelStatus = "started" | "completed" | "failed";

export interface TelemetryEvent {
  timestamp: string;
  operation: string;
  actor_type: string;
  result: OperationResult;
  latency_ms: number;
  correlation_id: string;
  error_code?: string;
  funnel?: string;
  step?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordOperationOptions {
  operation: string;
  actorType?: string;
  result: OperationResult;
  latencyMs: number;
  correlationId?: string;
  errorCode?: string;
  funnel?: string;
  step?: string;
  metadata?: Record<string, unknown>;
}

export interface StartTimerOptions {
  actorType?: string;
  correlationId?: string;
  funnel?: string;
  step?: string;
}

const SENSITIVE_KEY_REGEX =
  /^(password|secret|private[_-]?key|seed|token|bearer|auth|authorization|signature|api[_-]?key|access[_-]?token|refresh[_-]?token|credit[_-]?card|cvv|ssn)$/i;

const JWT_REGEX = /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g;
const STELLAR_SECRET_REGEX = /\bS[A-Z2-7]{55}\b/g;

/**
 * TelemetryService provides standardized structured logging and Prometheus metrics
 * for business-critical operations, failure rates, and conversion funnels.
 *
 * Implements strict sensitive data sanitization (passwords, tokens, private keys, secrets).
 */
@Injectable()
export class TelemetryService {
  private readonly logger = new Logger("Telemetry");

  /**
   * Recursively mask sensitive fields in objects, arrays, and strings.
   */
  maskSensitiveData<T = unknown>(data: T): T {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === "string") {
      let sanitized = data.replace(JWT_REGEX, "[REDACTED_JWT]");
      sanitized = sanitized.replace(
        STELLAR_SECRET_REGEX,
        "[REDACTED_STELLAR_SECRET]",
      );
      return sanitized as unknown as T;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.maskSensitiveData(item)) as unknown as T;
    }

    if (typeof data === "object") {
      const sanitizedObj: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (SENSITIVE_KEY_REGEX.test(key)) {
          sanitizedObj[key] = "[REDACTED]";
        } else {
          sanitizedObj[key] = this.maskSensitiveData(value);
        }
      }
      return sanitizedObj as T;
    }

    return data;
  }

  /**
   * Record a business operation execution, updating Prometheus metrics and
   * emitting a structured JSON log.
   */
  recordOperation(options: RecordOperationOptions): TelemetryEvent {
    const actorType = options.actorType || "anonymous";
    const correlationId = options.correlationId || uuidv4();
    const latencyMs = Math.max(0, Math.round(options.latencyMs * 100) / 100);

    const event: TelemetryEvent = {
      timestamp: new Date().toISOString(),
      operation: options.operation,
      actor_type: actorType,
      result: options.result,
      latency_ms: latencyMs,
      correlation_id: correlationId,
    };

    if (options.errorCode) {
      event.error_code = options.errorCode;
    }

    if (options.funnel) {
      event.funnel = options.funnel;
    }

    if (options.step) {
      event.step = options.step;
    }

    if (options.metadata) {
      event.metadata = this.maskSensitiveData(options.metadata);
    }

    // 1. Prometheus metric updates
    try {
      businessOperationDuration
        .labels(options.operation, actorType, options.result)
        .observe(latencyMs / 1000);

      businessOperationTotal
        .labels(options.operation, actorType, options.result)
        .inc();

      if (options.result === "failure") {
        businessFailureTotal
          .labels(options.operation, actorType, options.errorCode || "UNKNOWN_ERROR")
          .inc();
      }

      if (options.funnel && options.step) {
        conversionFunnelTotal
          .labels(
            options.funnel,
            options.step,
            options.result === "success" ? "completed" : "failed",
          )
          .inc();
      }
    } catch (metricError) {
      this.logger.warn(`Failed to update Prometheus metrics: ${metricError.message}`);
    }

    // 2. Structured log emission
    const payload = JSON.stringify(event);
    if (options.result === "failure") {
      this.logger.warn(`[TELEMETRY] ${payload}`);
    } else {
      this.logger.log(`[TELEMETRY] ${payload}`);
    }

    return event;
  }

  /**
   * Record a funnel step event to track conversion progression across multi-step flows.
   */
  recordFunnelStep(
    funnel: string,
    step: string,
    status: FunnelStatus,
    metadata?: Record<string, unknown>,
  ): void {
    try {
      conversionFunnelTotal.labels(funnel, step, status).inc();
    } catch (metricError) {
      this.logger.warn(`Failed to update funnel metric: ${metricError.message}`);
    }

    const event = {
      timestamp: new Date().toISOString(),
      event_type: "funnel_transition",
      funnel,
      step,
      status,
      metadata: metadata ? this.maskSensitiveData(metadata) : undefined,
    };

    this.logger.log(`[TELEMETRY_FUNNEL] ${JSON.stringify(event)}`);
  }

  /**
   * Helper to measure execution time of an operation.
   */
  startTimer(operation: string, options: StartTimerOptions = {}) {
    const start = process.hrtime.bigint();
    return (
      result: OperationResult,
      errorCode?: string,
      metadata?: Record<string, unknown>,
    ): TelemetryEvent => {
      const elapsedNs = Number(process.hrtime.bigint() - start);
      const latencyMs = elapsedNs / 1e6;
      return this.recordOperation({
        operation,
        actorType: options.actorType,
        result,
        latencyMs,
        correlationId: options.correlationId,
        errorCode,
        funnel: options.funnel,
        step: options.step,
        metadata,
      });
    };
  }

  /**
   * Record database write operation duration (save, insert, update, delete)
   * into the db_write_duration_seconds Prometheus histogram.
   */
  recordDatabaseWrite(options: RecordDbWriteOptions): void {
    const status = options.status || "success";
    const entity = options.entity || "unknown";
    try {
      dbWriteDuration
        .labels(options.operation, entity, status)
        .observe(Math.max(0, options.durationSeconds));
    } catch (metricError) {
      this.logger.warn(
        `Failed to update db_write_duration_seconds metric: ${metricError.message}`,
      );
    }
  }

  /**
   * Helper to measure execution duration of a database write call (save, insert, update, delete).
   */
  startDbWriteTimer(operation: DbWriteOperation, options: StartDbWriteTimerOptions = {}) {
    const start = process.hrtime.bigint();
    return (status: "success" | "failure" | OperationResult = "success"): void => {
      const elapsedNs = Number(process.hrtime.bigint() - start);
      const durationSeconds = elapsedNs / 1e9;
      this.recordDatabaseWrite({
        operation,
        entity: options.entity,
        durationSeconds,
        status,
      });
    };
  }

  /**
   * Instrument and execute a database write callback (save, insert, update, delete),
   * recording its latency in seconds in db_write_duration_seconds.
   */
  async trackDatabaseWrite<T>(
    operation: DbWriteOperation,
    entity: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const endTimer = this.startDbWriteTimer(operation, { entity });
    try {
      const result = await action();
      endTimer("success");
      return result;
    } catch (error) {
      endTimer("failure");
      throw error;
    }
  }
}

// Global singleton instance for decorator or non-DI environments
export const telemetryService = new TelemetryService();

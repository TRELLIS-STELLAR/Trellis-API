import {
  customOperationDuration,
  customOperationTotal,
} from "./monitoring.metrics";

/**
 * Options for the {@link Monitor} decorator.
 */
export interface MonitorOptions {
  /**
   * Metric label identifying the operation. Defaults to
   * `ClassName.methodName`. Keep this low-cardinality — do not interpolate
   * per-request values into it.
   */
  name?: string;
}

/**
 * Method decorator that records latency and success/error counts for the
 * wrapped method against the shared custom-operation metrics
 * (`trellis_operation_duration_seconds` and
 * `trellis_operation_total`).
 *
 * Works for both synchronous and Promise-returning methods: a returned promise
 * is awaited so the recorded duration reflects the full async operation, and a
 * rejection is counted as `status="error"` before being re-thrown.
 *
 * @example
 *   class PricingService {
 *     @Monitor({ name: "pricing.recompute" })
 *     async recompute() { ... }
 *   }
 */
export function Monitor(options: MonitorOptions = {}): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const original = descriptor.value;
    if (typeof original !== "function") {
      return descriptor;
    }

    const operation =
      options.name ??
      `${target?.constructor?.name ?? "Anonymous"}.${String(propertyKey)}`;

    descriptor.value = function monitored(...args: unknown[]) {
      const start = process.hrtime.bigint();

      const finish = (status: "success" | "error") => {
        const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
        customOperationDuration
          .labels(operation, status)
          .observe(durationSeconds);
        customOperationTotal.labels(operation, status).inc();
      };

      try {
        const result = original.apply(this, args);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (value) => {
              finish("success");
              return value;
            },
            (err) => {
              finish("error");
              throw err;
            },
          );
        }
        finish("success");
        return result;
      } catch (err) {
        finish("error");
        throw err;
      }
    };

    // Preserve the original name for stack traces / other decorators.
    Object.defineProperty(descriptor.value, "name", {
      value: typeof original.name === "string" ? original.name : "monitored",
      configurable: true,
    });

    return descriptor;
  };
}

/** Alias kept for readability at call sites that prefer a verb. */
export const TrackMetric = Monitor;

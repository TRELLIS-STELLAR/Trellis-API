import { telemetryService, OperationResult } from "./telemetry.service";

export interface TelemetryDecoratorOptions {
  operation: string;
  actorType?: string;
  funnel?: string;
  step?: string;
}

/**
 * Method decorator that instruments business operations with standardized
 * structured logging, latency tracking, Prometheus metrics, and error codes.
 */
export function Telemetry(options: TelemetryDecoratorOptions): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const original = descriptor.value;
    if (typeof original !== "function") {
      return descriptor;
    }

    descriptor.value = function monitored(...args: unknown[]) {
      // Attempt to extract request context from arguments
      let correlationId: string | undefined;
      let actorType = options.actorType;

      for (const arg of args) {
        if (arg && typeof arg === "object") {
          const req = arg as Record<string, any>;
          if (req.headers && typeof req.headers === "object") {
            correlationId =
              req.headers["x-correlation-id"] ||
              req.headers["correlation-id"] ||
              req.correlationId ||
              req.id;
          }
          if (req.user && typeof req.user === "object") {
            actorType = req.user.role || req.user.type || actorType;
          }
        }
      }

      const timer = telemetryService.startTimer(options.operation, {
        actorType,
        correlationId,
        funnel: options.funnel,
        step: options.step,
      });

      const handleSuccess = (value: unknown) => {
        timer("success");
        return value;
      };

      const handleFailure = (err: any) => {
        const errorCode =
          err?.errorCode ||
          err?.code ||
          err?.response?.errorCode ||
          (typeof err?.getStatus === "function"
            ? `HTTP_${err.getStatus()}`
            : undefined) ||
          err?.name ||
          "UNKNOWN_ERROR";

        timer("failure", String(errorCode), {
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      };

      try {
        const result = original.apply(this, args);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            handleSuccess,
            handleFailure,
          );
        }
        return handleSuccess(result);
      } catch (err) {
        return handleFailure(err);
      }
    };

    Object.defineProperty(descriptor.value, "name", {
      value: typeof original.name === "string" ? original.name : "telemetryMonitored",
      configurable: true,
    });

    return descriptor;
  };
}

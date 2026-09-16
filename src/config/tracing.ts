import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { JaegerExporter } from "@opentelemetry/exporter-jaeger";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  SpanExporter,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  Sampler,
} from "@opentelemetry/sdk-trace-base";
import {
  trace,
  SpanStatusCode,
  Span,
  context,
  propagation,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

const SERVICE_NAME = "trellis-api";

function buildExporters(): SpanExporter[] {
  const exporters: SpanExporter[] = [];

  // OTLP exporter (primary — works with Jaeger 1.41+ OTLP endpoint)
  exporters.push(
    new OTLPTraceExporter({
      url:
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
        "http://localhost:4318/v1/traces",
    }),
  );

  // Legacy Jaeger Thrift exporter (for older Jaeger deployments)
  if (process.env.JAEGER_AGENT_HOST || process.env.JAEGER_ENDPOINT) {
    exporters.push(
      new JaegerExporter({
        endpoint:
          process.env.JAEGER_ENDPOINT ||
          `http://${process.env.JAEGER_AGENT_HOST || "localhost"}:14268/api/traces`,
      }),
    );
  }

  return exporters;
}

const resource = resourceFromAttributes({
  "service.name": SERVICE_NAME,
  "service.version": process.env.npm_package_version || "1.0.0",
  "deployment.environment": process.env.NODE_ENV || "development",
});

let sdk: NodeSDK;

/**
 * Build a head-based sampler from `OTEL_TRACES_SAMPLER_RATIO` (0..1).
 *
 * Wrapping the ratio sampler in a `ParentBasedSampler` means a sampling
 * decision made upstream is always respected, so distributed traces are not
 * broken part-way through. A ratio of 1 keeps the previous always-on
 * behaviour; a lower value bounds tracing overhead in production.
 */
export function buildSampler(): Sampler {
  const raw = process.env.OTEL_TRACES_SAMPLER_RATIO;
  let ratio = raw === undefined ? 1 : parseFloat(raw);
  if (!Number.isFinite(ratio)) ratio = 1;
  ratio = Math.min(1, Math.max(0, ratio));

  return new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(ratio),
  });
}

function buildSdk(): NodeSDK {
  const exporters = buildExporters();
  const processors = exporters.map((exp) => new BatchSpanProcessor(exp));

  return new NodeSDK({
    resource,
    sampler: buildSampler(),
    spanProcessors: processors,
    textMapPropagator: new W3CTraceContextPropagator(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Ensure HTTP instrumentation captures request/response headers
        "@opentelemetry/instrumentation-http": {
          headersToSpanAttributes: {
            server: {
              requestHeaders: ["x-request-id", "x-correlation-id"],
              responseHeaders: ["content-type"],
            },
          },
        },
      }),
    ],
  });
}

/**
 * Whether tracing is enabled. Disabled only when `TRACING_ENABLED` is the
 * literal string "false" so the default (unset) stays on.
 */
export const isTracingEnabled = (): boolean =>
  process.env.TRACING_ENABLED !== "false";

export const startTracing = async (): Promise<void> => {
  if (!isTracingEnabled()) {
    console.log("OpenTelemetry tracing disabled (TRACING_ENABLED=false)");
    return;
  }
  try {
    sdk = buildSdk();
    sdk.start();
    console.log(
      `OpenTelemetry tracing initialized (sampler ratio=${
        process.env.OTEL_TRACES_SAMPLER_RATIO ?? "1"
      })`,
    );
  } catch (err) {
    console.error("Failed to start OpenTelemetry SDK:", err);
  }
};

export const shutdownTracing = async (): Promise<void> => {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    console.log("OpenTelemetry tracing shut down");
  } catch (error) {
    console.error("Error shutting down tracing:", error);
  }
};

export const getTracer = () =>
  trace.getTracer(SERVICE_NAME, process.env.npm_package_version || "1.0.0");

/**
 * Execute `fn` inside a new active span, automatically setting OK/ERROR
 * status and ending the span when the promise resolves or rejects.
 */
export const createSpan = async <T>(
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> => {
  return getTracer().startActiveSpan(name, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  });
};

/**
 * Extract trace context from an incoming carrier (HTTP headers, WS handshake
 * headers, message metadata, etc.) and return an active context so that child
 * spans are correctly parented to the upstream trace.
 */
export const extractContext = (carrier: Record<string, string | string[]>) => {
  return propagation.extract(ROOT_CONTEXT, carrier);
};

/**
 * Inject the current trace context into an outgoing carrier so downstream
 * services can continue the trace.
 */
export const injectContext = (
  carrier: Record<string, string>,
  ctx = context.active(),
) => {
  propagation.inject(ctx, carrier);
  return carrier;
};

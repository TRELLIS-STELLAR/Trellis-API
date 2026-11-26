import type { Journey } from "./synthetic-monitoring.service";

/**
 * Synthetic health probe for authenticated payment pipelines (#530).
 *
 * Builds a `Journey` for `SyntheticMonitoringService` that walks the live,
 * authenticated HTTP surface a payment depends on:
 *
 *   1. authenticate         GET /api/v1/auth/status          (JWT accepted, session valid)
 *   2. list-processors      GET /api/v1/payments/processors  (JWT, pipeline registry readable)
 *   3. enabled-processor    assert at least one processor is enabled
 *
 * The probe is read-only by design, so it never creates a quote, payment or
 * payout. The existing journey contract (a failed step skips the rest, and
 * failures are reported without side effects) applies unchanged.
 *
 * Failure classification (drives retry; the step message never carries the
 * token or the response body):
 *
 *  - authorization  401 / 403, or no credential configured. Not retried. The
 *                   probe refuses to send an unauthenticated request, so a
 *                   missing credential is reported as a failure, not a pass.
 *  - client         other 4xx. Not retried: the request itself is wrong.
 *  - server         5xx. Retried, because a GET is idempotent.
 *  - timeout        step exceeded `stepTimeoutMs`. Retried.
 *  - network        fetch rejected before a response. Retried.
 *
 * Recovery: a probe failure has no side effects to undo. The operator should
 * check the failing step's classification. An `authorization` failure means the
 * probe credential was rotated or revoked. Fix the credential and rerun. No
 * rollback is required.
 *
 * Credential: use a dedicated service account, never a personal token. It only
 * needs the JWT guard to pass for these two routes.
 */

export const PAYMENT_PIPELINE_JOURNEY = "payment-pipeline";

export type ProbeFailureKind =
  | "authorization"
  | "client"
  | "server"
  | "timeout"
  | "network"
  | "pipeline";

const RETRYABLE_KINDS: ReadonlySet<ProbeFailureKind> =
  new Set<ProbeFailureKind>(["server", "timeout", "network"]);

export class ProbeFailure extends Error {
  constructor(
    readonly kind: ProbeFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ProbeFailure";
  }
}

export interface PaymentPipelineProbeOptions {
  /** Base URL of the API, without a trailing path, e.g. "https://api.example.org". */
  baseUrl: string;
  /** Dedicated service credential (bearer token). */
  probeToken: string | undefined;
  /** Per-request timeout in ms. Defaults to 5000. */
  stepTimeoutMs?: number;
  /** Attempts per step for retryable failures. Defaults to 2. */
  maxAttempts?: number;
  /** Delay before a retry in ms. Defaults to 250. */
  retryDelayMs?: number;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export function classifyStatus(status: number): ProbeFailureKind | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "authorization";
  if (status >= 500) return "server";
  return "client";
}

/** Build the pipeline journey. Throws at construction time on invalid config. */
export function createPaymentPipelineJourney(
  options: PaymentPipelineProbeOptions,
): Journey {
  const baseUrl = parseBaseUrl(options.baseUrl);
  const stepTimeoutMs = options.stepTimeoutMs ?? 5000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const retryDelayMs = options.retryDelayMs ?? 250;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const token = options.probeToken?.trim() || undefined;
  let processors: { enabled?: boolean }[] | undefined;

  const requestOnce = async (path: string): Promise<unknown> => {
    if (!token) {
      throw new ProbeFailure(
        "authorization",
        "no probe credential configured; refusing to send an unauthenticated request",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), stepTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProbeFailure(
          "timeout",
          `${path} timed out after ${stepTimeoutMs}ms`,
        );
      }
      throw new ProbeFailure(
        "network",
        `${path} unreachable: ${errorName(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const kind = classifyStatus(response.status);
    if (kind) {
      throw new ProbeFailure(kind, `${path} responded ${response.status}`);
    }

    try {
      return await response.json();
    } catch {
      throw new ProbeFailure("client", `${path} returned a non-JSON body`);
    }
  };

  const withRetry = async <T>(run: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await run();
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof ProbeFailure && RETRYABLE_KINDS.has(error.kind);
        if (!retryable || attempt === maxAttempts) break;
        if (retryDelayMs > 0) await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  };

  return {
    name: PAYMENT_PIPELINE_JOURNEY,
    steps: [
      {
        name: "authenticate",
        fn: async () => {
          const body = (await withRetry(() =>
            requestOnce("/api/v1/auth/status"),
          )) as {
            isAuthenticated?: boolean;
          };
          if (body?.isAuthenticated !== true) {
            throw new ProbeFailure(
              "authorization",
              "auth/status did not report an authenticated session",
            );
          }
        },
      },
      {
        name: "list-processors",
        fn: async () => {
          const body = await withRetry(() =>
            requestOnce("/api/v1/payments/processors"),
          );
          if (!Array.isArray(body)) {
            throw new ProbeFailure(
              "client",
              "payments/processors did not return a list",
            );
          }
          // Reused by the next step so the probe makes one request, not two.
          processors = body as { enabled?: boolean }[];
        },
      },
      {
        name: "enabled-processor",
        fn: async () => {
          if (!processors) {
            throw new ProbeFailure(
              "pipeline",
              "processor list was not collected",
            );
          }
          if (!processors.some((processor) => processor.enabled === true)) {
            // Not retried: a disabled pipeline does not heal between attempts.
            throw new ProbeFailure(
              "pipeline",
              "no payment processor is enabled",
            );
          }
        },
      },
    ],
  };
}

function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`payment pipeline probe: invalid baseUrl '${raw}'`);
  }
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    throw new Error(
      "payment pipeline probe: baseUrl must use https outside localhost",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

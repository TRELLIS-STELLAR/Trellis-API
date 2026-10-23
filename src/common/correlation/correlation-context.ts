import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "crypto";

/*
 * Request correlation across the API, background workers and external calls
 * (#270). One correlation ID is resolved at the HTTP edge, carried in an
 * AsyncLocalStorage context for the rest of the request, stamped onto queued
 * jobs and retry records, and forwarded on outbound requests.
 */

/** Canonical header. `x-request-id` is still read and echoed for existing clients. */
export const CORRELATION_ID_HEADER = "x-correlation-id";
export const REQUEST_ID_HEADER = "x-request-id";

/** Job payload field that carries the correlation ID across the queue boundary. */
export const JOB_CORRELATION_FIELD = "_correlationId";

/**
 * Matches the oracle contract's correlation policy (MAX_CORRELATION_ID_LEN and
 * the alphanumeric/hyphen/underscore charset), so an API-issued ID can be passed
 * on-chain unchanged. UUIDs satisfy it.
 */
export const MAX_CORRELATION_ID_LENGTH = 64;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type CorrelationSource = "header" | "job" | "generated";

export interface CorrelationContext {
  correlationId: string;
  source: CorrelationSource;
}

export interface ResolvedCorrelation extends CorrelationContext {
  /** True when a caller-supplied value was present but rejected. */
  rejected: boolean;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/**
 * Returns the ID if it satisfies the correlation policy, otherwise null. The
 * length check runs before the pattern so oversized headers cost O(1).
 */
export function normalizeCorrelationId(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_CORRELATION_ID_LENGTH * 2)
    return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_CORRELATION_ID_LENGTH ||
    !CORRELATION_ID_PATTERN.test(trimmed)
  )
    return null;
  return trimmed;
}

export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Resolves the correlation ID for an inbound request. `x-correlation-id` wins
 * over `x-request-id`; an invalid value is replaced, never echoed, so it cannot
 * be used for header or log injection.
 */
export function resolveInboundCorrelationId(
  headers: Record<string, unknown> = {},
): ResolvedCorrelation {
  const supplied = [headers[CORRELATION_ID_HEADER], headers[REQUEST_ID_HEADER]];
  for (const candidate of supplied) {
    const correlationId = normalizeCorrelationId(candidate);
    if (correlationId)
      return { correlationId, source: "header", rejected: false };
  }
  return {
    correlationId: generateCorrelationId(),
    source: "generated",
    rejected: supplied.some((candidate) => candidate !== undefined),
  };
}

export function runWithCorrelation<T>(
  correlation: CorrelationContext | string,
  fn: () => T,
): T {
  const ctx =
    typeof correlation === "string"
      ? { correlationId: correlation, source: "generated" as const }
      : { correlationId: correlation.correlationId, source: correlation.source };
  return storage.run(ctx, fn);
}

export function getCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Adds correlation headers for an outbound call made inside a correlated
 * context. Explicit values already present (in any letter case) are kept.
 */
export function withCorrelationHeaders<T extends Record<string, string>>(
  headers: T = {} as T,
  correlationId: string | undefined = getCorrelationId(),
): T & Record<string, string> {
  if (!correlationId) return headers;
  const present = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
  const out: Record<string, string> = { ...headers };
  if (!present.has(CORRELATION_ID_HEADER))
    out[CORRELATION_ID_HEADER] = correlationId;
  if (!present.has(REQUEST_ID_HEADER)) out[REQUEST_ID_HEADER] = correlationId;
  return out as T & Record<string, string>;
}

/** Stamps the active (or given) correlation ID onto a queued job payload. */
export function withJobCorrelation<T extends Record<string, unknown>>(
  payload: T,
  correlationId: string | undefined = getCorrelationId(),
): T {
  const id = normalizeCorrelationId(correlationId);
  return id ? { ...payload, [JOB_CORRELATION_FIELD]: id } : payload;
}

/**
 * Runs a worker handler inside the correlation context stamped on its job
 * payload, or a fresh one when the job predates correlation or was tampered
 * with. Retries of the same job therefore share the original ID.
 */
export function runJobWithCorrelation<T>(
  jobData: unknown,
  fn: (correlationId: string) => T,
): T {
  const stamped =
    jobData && typeof jobData === "object"
      ? normalizeCorrelationId(
          (jobData as Record<string, unknown>)[JOB_CORRELATION_FIELD],
        )
      : null;
  const ctx: CorrelationContext = stamped
    ? { correlationId: stamped, source: "job" }
    : { correlationId: generateCorrelationId(), source: "generated" };
  return storage.run(ctx, () => fn(ctx.correlationId));
}

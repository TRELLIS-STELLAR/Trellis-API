import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { AuditLogService } from "src/infrastructure/audit/audit-log.service";
import { telemetryService } from "src/observability/telemetry.service";
import { SubmissionHistoryService } from "./services/submission-history.service";
import {
  OracleVerificationError,
  StellarOracleAdapter,
} from "./services/stellar-oracle.adapter";

export interface CanonicalizationInput {
  [key: string]: unknown;
}

export interface CanonicalizationOptions {
  /** Maximum allowed nesting depth before throwing. Defaults to 32. */
  maxDepth?: number;
  /** Maximum byte length of the output payload. Defaults to 1 MiB. */
  maxBytes?: number;
}

export class CanonicalizationError extends Error {
  constructor(
    readonly code:
      | "INVALID_TYPE"
      | "CIRCULAR_REFERENCE"
      | "MAX_DEPTH_EXCEEDED"
      | "MAX_SIZE_EXCEEDED"
      | "NON_FINITE_NUMBER"
      | "UNSUPPORTED_TYPE",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CanonicalizationError";
  }
}

export const CANONICAL_VERSION = "trellis-canonical-v1";

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_BYTES = 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizePrimitive(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value as string);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      const num = value as number;
      if (!Number.isFinite(num))
        throw new CanonicalizationError(
          "NON_FINITE_NUMBER",
          `number ${String(num)} is not finite`,
        );
      if (Object.is(num, -0)) return "0";
      return String(num);
    }
    case "bigint":
      return ((value as bigint) < 0n ? "-" : "") + (value as bigint).toString();
    case "undefined":
      return "null";
    default:
      throw new CanonicalizationError(
        "UNSUPPORTED_TYPE",
        `unsupported primitive type ${typeof value}`,
      );
  }
}

function canonicalizeValue(
  value: unknown,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
): string {
  if (depth > maxDepth)
    throw new CanonicalizationError(
      "MAX_DEPTH_EXCEEDED",
      `nesting exceeded max depth of ${maxDepth}`,
    );

  if (value === null || typeof value !== "object") {
    return normalizePrimitive(value);
  }

  if (seen.has(value as object))
    throw new CanonicalizationError(
      "CIRCULAR_REFERENCE",
      "circular reference detected during canonicalization",
    );
  seen.add(value as object);

  try {
    if (Array.isArray(value)) {
      const items = value.map((item) =>
        canonicalizeValue(item, depth + 1, maxDepth, seen),
      );
      return `[${items.join(",")}]`;
    }

    if (value instanceof Date) {
      if (Number.isNaN(value.getTime()))
        throw new CanonicalizationError(
          "UNSUPPORTED_TYPE",
          "invalid Date instance",
        );
      return JSON.stringify(value.toISOString());
    }

    if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
      const json = (value as { toJSON: () => unknown }).toJSON();
      return canonicalizeValue(json, depth + 1, maxDepth, seen);
    }

    if (!isPlainObject(value))
      throw new CanonicalizationError(
        "UNSUPPORTED_TYPE",
        `unsupported object type $${(value as object).constructor?.name ?? "unknown"}`,
      );

    const entries = Object.keys(value as Record<string, unknown>)
      .filter((key) => {
        const v = (value as Record<string, unknown>)[key];
        return v !== undefined;
      })
      .sort();

    const parts = entries.map((key) => {
      const normalizedKey = normalizePrimitive(key);
      const normalizedValue = canonicalizeValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        maxDepth,
        seen,
      );
      return `${normalizedKey}:${normalizedValue}`;
    });

    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value as object);
  }
}

/**
 * Produces a deterministic, canonical string representation of a payload suitable
 * for signing, hashing, or replay-protection decisions.
 *
 * Guarantees:
 * - Object keys are sorted by UTF-16 code unit order (ASCII-binary stable).
 * - Undefined object values are dropped; undefined array entries become null.
 * - Numbers are normalized to their decimal string form (with -0 => 0).
 * - Dates are normalized to ISO 8601 strings.
 * - BigInt values are emitted as unquoted decimal strings.
 * - Circular references, non-finite numbers, and excessive depth are rejected.
 */
export function canonicalizePayload(
  input: unknown,
  options: CanonicalizationOptions = {},
): string {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const output = canonicalizeValue(input, 0, maxDepth, new WeakSet());
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength > maxBytes)
    throw new CanonicalizationError(
      "MAX_SIZE_EXCEEDED",
      `canonical payload is ${byteLength} bytes, exceeding limit of ${maxBytes}`,
    );
  return output;
}

export function canonicalizationDigest(
  input: unknown,
  options?: CanonicalizationOptions,
): string {
  return canonicalizePayload(input, options);
}

export function buildSignedEnvelope(
  payload: unknown,
  metadata: CanonicalizationInput = {},
): {
  version: string;
  canonical: string;
  metadata: CanonicalizationInput;
} {
  const normalizedMetadata = Object.keys(metadata)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const v = metadata[key];
      if (v !== undefined) acc[key] = v;
      return acc;
    }, {});
  const canonical = canonicalizePayload({
    version: CANONICAL_VERSION,
    payload,
    metadata: normalizedMetadata,
  });
  return {
    version: CANONICAL_VERSION,
    canonical,
    metadata: normalizedMetadata,
  };
}

@Injectable()
export class SubmissionVerifierService implements OnModuleDestroy {
  private readonly logger = new Logger(SubmissionVerifierService.name);
  private readonly pollingInterval = 15000;
  private timer?: ReturnType<typeof setInterval>;
  private verifying = false;

  constructor(
    private readonly auditLogService: AuditLogService,
    private readonly submissionHistory: SubmissionHistoryService,
    private readonly adapter: StellarOracleAdapter,
  ) {}

  /**
   * Exposes the canonical serialization layer for signed/hashed/replay-protected
   * payloads that flow through the verifier. This is the single source of truth
   * for stable field order, encoding, and normalization.
   */
  canonicalize(input: unknown, options?: CanonicalizationOptions): string {
    return canonicalizePayload(input, options);
  }

  canonicalizeSubmission(submission: unknown): string {
    return canonicalizePayload(submission);
  }

  start() {
    if (!this.adapter.isEnabled) {
      this.logger.warn(
        "Submission verifier disabled: configure SOROBAN_RPC_URL and ORACLE_CONTRACT_ADDRESS",
      );
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.verifyCycle().catch((error) =>
        this.logger.error("Oracle verification cycle failed", error),
      );
    }, this.pollingInterval);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async verifyCycle() {
    if (this.verifying) return;
    this.verifying = true;
    const endTelemetry = telemetryService.startTimer(
      "oracle.verify_submission",
      {
        actorType: "service_actor",
        funnel: "oracle_sync",
        step: "submission_verify",
      },
    );
    const result = {
      timestamp: new Date(),
      totalChecked: 0,
      mismatches: [] as Array<{ id: string; error: string }>,
      missing: [] as Array<{ id: string; error: string }>,
      duplicates: [] as string[],
    };
    try {
      const submissions = await this.submissionHistory.pending();
      for (const submission of submissions) {
        result.totalChecked++;
        try {
          await this.adapter.verify(submission);
          await this.submissionHistory.setResult(submission.id, "verified");
        } catch (error) {
          if (!(error instanceof OracleVerificationError)) throw error;
          if (
            [
              "RPC_UNAVAILABLE",
              "RPC_ERROR",
              "NOT_CONFIGURED",
              "NETWORK_MISMATCH",
            ].includes(error.code)
          )
            throw error;
          if (error.retryable) {
            await this.submissionHistory.defer(submission.id, error.message);
            result.missing.push({ id: submission.id, error: error.message });
          } else {
            await this.submissionHistory.setResult(
              submission.id,
              "rejected",
              error.message,
            );
            result.mismatches.push({ id: submission.id, error: error.message });
          }
        }
      }
      await this.auditLogService.recordVerification(result);
      const failure = result.mismatches.length + result.missing.length > 0;
      if (failure)
        this.logger.warn(
          `Oracle verification needs attention: ${JSON.stringify(result)}`,
        );
      endTelemetry(
        failure ? "failure" : "success",
        failure ? "ORACLE_SUBMISSION_MISMATCH" : undefined,
        {
          mismatchesCount: result.mismatches.length,
          missingCount: result.missing.length,
          totalChecked: result.totalChecked,
        },
      );
      return result;
    } catch (error) {
      endTelemetry("failure", "ORACLE_VERIFICATION_ERROR", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.verifying = false;
    }
  }

  getStatus() {
    return {
      running: !!this.timer,
      enabled: this.adapter.isEnabled,
      interval: this.pollingInterval,
    };
  }
}

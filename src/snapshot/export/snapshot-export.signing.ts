import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, timingSafeEqual } from "crypto";

/** Injection token for the export signing-key provider seam. */
export const SNAPSHOT_EXPORT_SIGNING_KEY = Symbol("SNAPSHOT_EXPORT_SIGNING_KEY");

export class SnapshotExportSigningKeyUnavailableError extends Error {
  constructor(message = "Snapshot export signing key provider temporarily unavailable") {
    super(message);
    this.name = "SnapshotExportSigningKeyUnavailableError";
  }
}

export interface SnapshotExportSigningKeyProvider {
  getKey(): Promise<string>;
}

/**
 * Default key provider. Reads `SNAPSHOT_EXPORT_SIGNING_KEY` and falls back to
 * `SNAPSHOT_SIGNING_KEY` so an export created by one key can be verified by a
 * deployment that only knows the snapshot key. A development default is used
 * only when neither is configured.
 */
@Injectable()
export class ConfigSnapshotExportSigningKeyProvider
  implements SnapshotExportSigningKeyProvider
{
  constructor(private readonly configService: ConfigService) {}

  async getKey(): Promise<string> {
    return (
      this.configService.get<string>("SNAPSHOT_EXPORT_SIGNING_KEY") ??
      this.configService.get<string>("SNAPSHOT_SIGNING_KEY") ??
      "trellis-snapshot-export-dev-key-change-in-production"
    );
  }
}

export function snapshotExportSigningKeyProvider() {
  return {
    provide: SNAPSHOT_EXPORT_SIGNING_KEY,
    useClass: ConfigSnapshotExportSigningKeyProvider,
  };
}

/** Deterministic canonical JSON: object keys sorted recursively, array order kept. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function hashPayload(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function signPayload(key: string, payloadHash: string): string {
  return createHmac("sha256", key).update(payloadHash, "utf8").digest("hex");
}

/** Timing-safe signature comparison. Never throws. */
export function verifySignature(
  key: string,
  payloadHash: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = signPayload(key, payloadHash);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

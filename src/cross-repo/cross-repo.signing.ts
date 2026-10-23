import { createHmac, timingSafeEqual } from "crypto";
import { CrossRepoRequestEnvelope } from "./cross-repo.types";

/**
 * Deterministic canonical JSON used for request signing and hashing.
 *
 * Object keys are sorted recursively so the same logical payload always
 * produces the same string regardless of key insertion order. Arrays keep
 * their order because order is semantically meaningful.
 */
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

/** The exact string a client signs. Keep this stable — it is part of the contract. */
export function buildCrossRepoSigningPayload(envelope: CrossRepoRequestEnvelope): string {
  return [
    envelope.clientId,
    envelope.contractVersion,
    envelope.requestType,
    envelope.signedAt,
    canonicalJson(envelope.payload),
  ].join("\n");
}

export function signCrossRepoPayload(secret: string, signingPayload: string): string {
  return createHmac("sha256", secret).update(signingPayload, "utf8").digest("hex");
}

/** Timing-safe signature comparison. Never throws. */
export function verifyCrossRepoSignature(
  secret: string,
  signingPayload: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = signCrossRepoPayload(secret, signingPayload);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

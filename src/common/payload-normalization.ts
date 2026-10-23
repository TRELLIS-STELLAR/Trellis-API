import { createHash } from "node:crypto";

export type NormalizedPayload = Readonly<Record<string, unknown>>;

/** Canonicalizes signed payloads so hashing and signature verification agree. */
export function normalizeSignedPayload(value: unknown): NormalizedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("signed payload must be an object");
  }
  return normalizeObject(value as Record<string, unknown>) as NormalizedPayload;
}

export function hashSignedPayload(value: unknown): string {
  const canonical = JSON.stringify(normalizeSignedPayload(value));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizeObject(value: Record<string, unknown>): unknown {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new TypeError(`unsafe payload key: ${key}`);
    }
    output[key] = normalizeValue(value[key]);
  }
  return output;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError("signed payload numbers must be safe integers");
    }
    return value;
  }
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") return normalizeObject(value as Record<string, unknown>);
  throw new TypeError("signed payload contains an unsupported value");
}

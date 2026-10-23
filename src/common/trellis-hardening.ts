import { createHash } from "node:crypto";

export type AdminAuditReceipt = {
  action: string;
  actorId: string;
  resource: string;
  requestId: string;
  payloadHash: string;
  recordedAt: string;
};

export type RejectionExplanation = {
  code: string;
  message: string;
  nextAction?: string;
};

export type IdempotencyRecord<T> = { fingerprint: string; response: T; expiresAt: number };

/** Stable payload digest used by idempotency keys and audit receipts. */
export function canonicalPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(payload))).digest("hex");
}

export function createAdminAuditReceipt(input: Omit<AdminAuditReceipt, "payloadHash" | "recordedAt"> & { payload: unknown }): AdminAuditReceipt {
  return {
    action: input.action,
    actorId: input.actorId,
    resource: input.resource,
    requestId: input.requestId,
    payloadHash: canonicalPayloadHash(input.payload),
    recordedAt: new Date().toISOString(),
  };
}

export class IdempotencyStore<T> {
  private readonly records = new Map<string, IdempotencyRecord<T>>();

  get(key: string, now = Date.now()): T | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (record.expiresAt <= now) {
      this.records.delete(key);
      return undefined;
    }
    return record.response;
  }

  put(key: string, fingerprint: string, response: T, ttlMs: number, now = Date.now()): void {
    const existing = this.records.get(key);
    if (existing && existing.expiresAt > now && existing.fingerprint !== fingerprint) {
      throw new Error("idempotency key reused with a different request");
    }
    this.records.set(key, { fingerprint, response, expiresAt: now + ttlMs });
  }
}

export function explainRejectedAction(code: string): RejectionExplanation {
  const explanations: Record<string, RejectionExplanation> = {
    INSUFFICIENT_BALANCE: { code, message: "The available balance is below the requested amount.", nextAction: "Reduce the amount or fund the account, then retry." },
    AUTHORIZATION_REQUIRED: { code, message: "This action requires an authorized operator.", nextAction: "Sign in with an account that has the required role." },
    STALE_VERSION: { code, message: "The resource changed before this request was applied.", nextAction: "Refresh the resource and submit the action again." },
  };
  return explanations[code] ?? { code, message: "The protocol rejected this action.", nextAction: "Review the request details and try again." };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortKeys(nested)]));
  }
  return value;
}

import { sanitizeAuditPayload } from "./sensitive-actions/audit-payload.sanitizer";

/** Operational metadata is restricted to fields used by retention and impersonation investigations. */
const RETAINED_METADATA_KEYS = new Set([
  "retentionHold",
  "activeDisputeId",
  "auditCaseId",
  "settlementId",
  "targetUserId",
  "adminId",
  "reasonCode",
  "source",
]);

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const MAX_AUDIT_DETAILS_LENGTH = 500;

export function minimizeAuditMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const sanitized = sanitizeAuditPayload(metadata, {
    maxDepth: 3,
    maxStringLength: 128,
    maxArrayLength: 20,
  }).value;
  if (!sanitized) return null;

  return Object.fromEntries(
    Object.entries(sanitized).filter(([key]) => RETAINED_METADATA_KEYS.has(key)),
  );
}

export function minimizeAuditDetails(details?: string): string | null {
  if (!details) return null;
  return details
    .replace(EMAIL_PATTERN, "[email]")
    .replace(SECRET_PATTERN, "[secret]")
    .slice(0, MAX_AUDIT_DETAILS_LENGTH);
}

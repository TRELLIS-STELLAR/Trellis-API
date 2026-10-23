/**
 * Types for the signed state snapshot export (issue #356).
 *
 * The snapshot module (issue #119) creates signed snapshots in process memory.
 * This slice turns a stored snapshot into an **export document** that can be
 * written to audit storage and independently verified later: the payload is
 * canonicalised, hashed, and signed with an HMAC key, and the document carries
 * enough metadata to re-verify it without access to the original service.
 */

/** Roles allowed to create or read exports. */
export type SnapshotExportRole = "ADMIN" | "MAINTAINER";

/** Who is asking for the export. */
export interface SnapshotExportRequester {
  id: string;
  role: string;
}

/** The signed, portable export document. */
export interface SnapshotExportDocument {
  exportId: string;
  snapshotId: string;
  exportedAt: string;
  exportedBy: string;
  /** HMAC algorithm identifier. */
  algorithm: "HMAC-SHA256";
  hashAlgorithm: "sha256";
  /** SHA-256 over the canonical payload. */
  payloadHash: string;
  /** HMAC-SHA256 over `payloadHash`. */
  signature: string;
  payload: Record<string, unknown>;
  metadata: {
    scope: string;
    label?: string;
    recordCount: number;
    redactedFields: string[];
    sourceIntegrityHash: string;
  };
}

/** Secret-free summary for listing. */
export interface SnapshotExportSummary {
  exportId: string;
  snapshotId: string;
  exportedAt: string;
  exportedBy: string;
  algorithm: "HMAC-SHA256";
  payloadHash: string;
  scope: string;
  recordCount: number;
}

export interface SnapshotExportVerification {
  exportId: string;
  valid: boolean;
  hashMatch: boolean;
  signatureMatch: boolean;
  reason?: string;
  verifiedAt: string;
}

export interface SnapshotExportAuthorizationDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Types for cross-repo API request validation (issue #353).
 *
 * The Trellis platform is split across repositories (API, frontend,
 * contracts). A request that originates in another repository is a
 * "cross-repo client" request. These types define the envelope such a client
 * sends and the structured verdict the API returns, so the contract is stable
 * and machine-checkable on both sides.
 */

export type CrossRepoClientStatus = "active" | "suspended" | "revoked";

/**
 * A registered cross-repo client. `secret` is the raw HMAC key used to verify
 * request signatures. It is held in memory only and is never serialised by
 * any endpoint (see {@link CrossRepoClientSummary}).
 */
export interface CrossRepoClient {
  clientId: string;
  clientName: string;
  secret: string;
  scopes: string[];
  status: CrossRepoClientStatus;
  /** Contract versions the client is allowed to submit. */
  contractVersions: string[];
  createdAt: string;
  lastUsedAt?: string;
}

/** Public, secret-free view of a client. */
export interface CrossRepoClientSummary {
  clientId: string;
  clientName: string;
  scopes: string[];
  status: CrossRepoClientStatus;
  contractVersions: string[];
  createdAt: string;
  lastUsedAt?: string;
}

export type CrossRepoFieldType =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object";

export interface CrossRepoFieldSchema {
  name: string;
  type: CrossRepoFieldType;
  required: boolean;
  /** Regular expression a string field must match. */
  pattern?: string;
  /** Inclusive numeric bounds. */
  min?: number;
  max?: number;
  /** Allowed enum values. */
  allowed?: Array<string | number | boolean>;
}

export interface CrossRepoContractSchema {
  requestType: string;
  contractVersion: string;
  fields: CrossRepoFieldSchema[];
}

/** A versioned request submitted by a cross-repo client. */
export interface CrossRepoRequestEnvelope {
  clientId: string;
  contractVersion: string;
  requestType: string;
  payload: Record<string, unknown>;
  /** ISO timestamp the client signed the request at. */
  signedAt: string;
  /** HMAC-SHA256 hex signature over the canonical signing payload. */
  signature: string;
  idempotencyKey?: string;
}

export interface CrossRepoValidationError {
  field: string;
  /** Stable, machine-readable code. Clients branch on these. */
  code: string;
  message: string;
}

export interface CrossRepoValidationResult {
  valid: boolean;
  clientId: string;
  requestType: string;
  contractVersion: string;
  errors: CrossRepoValidationError[];
  /**
   * True when the verdict is not about the request itself but about a
   * transient dependency (the contract schema provider). The client should
   * retry after `retryAfterSeconds`.
   */
  retryable: boolean;
  retryAfterSeconds?: number;
  validatedAt: string;
  correlationId: string;
}

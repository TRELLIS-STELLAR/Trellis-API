import { SensitiveAction } from "../../../infrastructure/audit/sensitive-actions/sensitive-action.enum";

/** Default lifetime in seconds for a scoped capability token (5 minutes). */
export const DEFAULT_CAPABILITY_TTL_SECONDS = 300;

/** Minimum allowed TTL in seconds for a capability token. */
export const MIN_CAPABILITY_TTL_SECONDS = 5;

/** Maximum allowed TTL in seconds for a capability token (15 minutes). */
export const MAX_CAPABILITY_TTL_SECONDS = 900;

/** Token prefix identifying Trellis v1 capability tokens. */
export const CAPABILITY_TOKEN_PREFIX = "cap_v1";

/** Default issuer claim for Trellis capability tokens. */
export const DEFAULT_CAPABILITY_ISSUER = "trellis-capability-authority";

export type CapabilityConstraintValue = string | number | boolean;

/**
 * Fine-grained authorization scope bound into a capability token.
 */
export interface CapabilityScope {
  /**
   * Sensitive action identifier (e.g. `SensitiveAction.WITHDRAWAL_APPROVED`
   * or a domain-specific action string).
   */
  action: SensitiveAction | string;
  /** Optional target resource type (e.g. "portfolio", "wallet", "withdrawal"). */
  resourceType?: string;
  /** Optional target resource identifier (or "*" when explicitly scoped to any ID of `resourceType`). */
  resourceId?: string;
  /** Optional parameter constraints (e.g. `{ maxAmount: 1000, asset: "USDC" }`). */
  constraints?: Record<string, CapabilityConstraintValue>;
}

/**
 * Signed header segment of a capability token.
 */
export interface CapabilityTokenHeader {
  alg: "HS256";
  typ: "CAP+JWT";
  kid: string;
}

/**
 * Canonical claims payload encoded inside a capability token.
 */
export interface CapabilityTokenClaims {
  version: "v1";
  /** Unique token identifier / nonce (`jti`). */
  jti: string;
  /** Subject (user / actor ID) authorized to exercise this capability. */
  sub: string;
  /** Token issuer. */
  iss: string;
  /** Issued-at timestamp (epoch seconds). */
  iat: number;
  /** Optional not-before timestamp (epoch seconds). */
  nbf?: number;
  /** Expiration timestamp (epoch seconds). */
  exp: number;
  /** Whether the token is single-use (default: true). */
  singleUse: boolean;
  /** Maximum number of distinct consumptions allowed. */
  maxUses: number;
  /** Scoped action, resource, and parameter constraints. */
  scope: CapabilityScope;
  /** Optional audit justification captured when the capability was granted. */
  reason?: string;
  /** Optional request correlation identifier. */
  correlationId?: string;
}

/**
 * Options for issuing a new expiring capability token.
 */
export interface IssueCapabilityTokenInput {
  /** Actor / user ID to whom the capability is granted. */
  subject: string;
  /** Action and resource scope for the token. */
  scope: CapabilityScope;
  /** Lifetime in seconds (bounded between MIN_CAPABILITY_TTL_SECONDS and MAX_CAPABILITY_TTL_SECONDS). */
  ttlSeconds?: number;
  /** Optional not-before timestamp (epoch seconds). */
  notBeforeSeconds?: number;
  /** Single-use flag (defaults to true). */
  singleUse?: boolean;
  /** Maximum uses when `singleUse` is false (defaults to 1 when singleUse is true). */
  maxUses?: number;
  /** Audit reason associated with granting the capability. */
  reason?: string;
  /** Correlation ID for end-to-end tracing. */
  correlationId?: string;
  /** Override signing key ID from the configured keyring. */
  keyId?: string;
  /** Override current time in milliseconds (primarily for deterministic tests). */
  nowMs?: number;
}

/**
 * Issued capability token envelope returned to callers.
 */
export interface IssuedCapabilityToken {
  token: string;
  jti: string;
  keyId: string;
  claims: CapabilityTokenClaims;
  expiresAt: string;
}

export type CapabilityTokenErrorCode =
  | "MISSING_TOKEN"
  | "MALFORMED_TOKEN"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_KEY_ID"
  | "INVALID_SIGNATURE"
  | "TOKEN_EXPIRED"
  | "TOKEN_NOT_YET_VALID"
  | "TOKEN_REVOKED"
  | "SUBJECT_REVOKED"
  | "TOKEN_ALREADY_CONSUMED"
  | "SUBJECT_MISMATCH"
  | "SCOPE_ACTION_MISMATCH"
  | "SCOPE_RESOURCE_MISMATCH"
  | "CONSTRAINT_VIOLATION";

/**
 * Context supplied when verifying and optionally consuming a capability token.
 */
export interface VerifyCapabilityTokenContext {
  /** Expected authenticated actor / subject ID. */
  expectedSubject?: string;
  /** Sensitive action being executed. */
  requiredAction: SensitiveAction | string;
  /** Target resource type being mutated or accessed. */
  resourceType?: string;
  /** Target resource identifier being mutated or accessed. */
  resourceId?: string;
  /** Actual operation parameters to verify against token constraints (`maxAmount` or exact match). */
  operationParams?: Record<string, CapabilityConstraintValue>;
  /** Whether to consume a use of the token on successful verification (default: true). */
  consume?: boolean;
  /**
   * Optional idempotency key for safe retries.
   * Re-verifying a single-use token with the same `idempotencyKey` that originally
   * consumed it succeeds as an idempotent replay instead of failing with `TOKEN_ALREADY_CONSUMED`.
   */
  idempotencyKey?: string;
  /** Override current time in milliseconds (for deterministic tests). */
  nowMs?: number;
}

/**
 * Non-throwing verification result returned by `CapabilityTokenService.verify()`.
 */
export interface CapabilityTokenVerificationResult {
  valid: boolean;
  claims?: CapabilityTokenClaims;
  keyId?: string;
  consumed?: boolean;
  idempotentReplay?: boolean;
  remainingUses?: number;
  errorCode?: CapabilityTokenErrorCode;
  message?: string;
}

/**
 * Configuration options for `CapabilityTokenService`.
 */
export interface CapabilityTokenServiceOptions {
  /** Active key ID used to sign newly issued tokens. */
  activeKeyId?: string;
  /** Keyring mapping `keyId -> secret` to support zero-downtime key rotation. */
  keys?: Record<string, string>;
  /** Allowed clock skew in seconds when checking `exp` and `nbf` (default: 0). */
  clockSkewSeconds?: number;
  /** Issuer string embedded in tokens. */
  issuer?: string;
}

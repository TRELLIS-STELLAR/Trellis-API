/*
 * @file trellis-contract.types.ts
 *
 * Shared typed integration contract for cross-repo Trellis integrations (issue #120).
 *
 * These types are the single source of truth for shapes exchanged between
 * frontend, API, and contract-facing code.  Any breaking change here must be
 * accompanied by a contract-test update and a CHANGELOG entry.
 *
 * Consumers:
 *  - Trellis-API  (this repo — rest controllers validate against these)
 *  - Trellis-Frontend (imports from published @trellis/contract
 *  - Smart-contract adapters (import via generated SDK)
 */

// ---------------------------------------------------------------------------
// Primitive aliases — use these instead of raw `string` where the semantic
// matters so type-checkers can catch mix-ups between ids and addresses.
// ---------------------------------------------------------------------------
export type UserId = string;
export type AgentId = string;
export type PortfolioId = string;
export type WalletAddress = string;
export type OperationId = string;
export type CorrelationId = string;
export type ISODateString = string;
export type StellarTxHash = string;

// ---------------------------------------------------------------------------
// Envelope — every API response is wrapped in this shape
// ---------------------------------------------------------------------------
export interface ApiEnvelope<T> {
  data: T;
  meta: ResponseMeta;
}

export interface ResponseMeta {
  requestId: CorrelationId;
  timestamp: ISODateString;
  apiVersion: string;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  total?: number;
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
  direction?: 'forward' | 'backward';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export interface ApiErrorResponse {
  statusCode: number;
  errorCode: string;
  domain: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  recoveryGuidance?: string;
  correlationId: CorrelationId;
  timestamp: ISODateString;
  path: string;
  errors?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export interface ChallengeRequest {
  walletAddress: WalletAddress;
}

export interface ChallengeResponse {
  nonce: string;
  message: string;
  expiresAt: ISODateString;
}

export interface VerifyRequest {
  walletAddress: WalletAddress;
  signature: string;
  nonce: string;
}

export interface AuthToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  userId: UserId;
  roles: string[];
}

// ---------------------------------------------------------------------------
// Operations — core statuses shared across the platform
// ---------------------------------------------------------------------------
export enum OperationStatus {
  Pending    = 'pending',
  Processing = 'processing',
  Succeeded  = 'succeeded',
  Failed     = 'failed',
  Cancelled  = 'cancelled',
  Recoverable = 'recoverable',
  RequiresAction = 'requires_action',
}

export enum OperationType {
  Payment        = 'payment',
  Portfolio      = 'portfolio',
  AgentCompute   = 'agent_compute',
  Submission     = 'submission',
  Import         = 'import',
  Export         = 'export',
  Staking        = 'staking',
  Rebalancing    = 'rebalancing',
}

export interface OperationReceipt {
  operationId: OperationId;
  type: OperationType;
  status: OperationStatus;
  userId: UserId;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  correlationId: CorrelationId;
  metadata?: Record<string, unknown>;
  errorDetail?: OperationErrorDetail;
  recoveryAction?: RecoveryAction;
}

export interface OperationErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  occurredAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------
export interface RecoveryAction {
  actionId: string;
  label: string;
  description: string;
  endpoint: string;
  method: 'POST' | 'DELETE' | 'PATCH';
  requiresConfirmation: boolean;
}

export type RecoveryState =
  | 'unresolved'   // visible in recovery center
  | 'in_progress'  // user/system actively handling it
  | 'resolved'     // no longer requires action
  | 'dismissed';   // user explicitly dismissed

export interface RecoveryEntry {
  id: string;
  operationId: OperationId;
  operationType: OperationType;
  userId: UserId;
  state: RecoveryState;
  title: string;
  description: string;
  availableActions: RecoveryAction[];
  createdAt: ISODateString;
  resolvedAt?: ISODateString;
}

// ---------------------------------------------------------------------------
// Rate-limit headers & responses
// ---------------------------------------------------------------------------
export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: ISODateString;
  retryAfterMs?: number;
  scope: string;
}

export interface RateLimitExceededResponse {
  errorCode: 'RATE_LIMITED';
  message: string;
  limit: number;
  remaining: 0;
  resetAt: ISODateString;
  retryAfterMs: number;
  scope: string;
}

// ---------------------------------------------------------------------------
// Snapshot (issue #119 contract surface)
// ---------------------------------------------------------------------------
export interface SnapshotSummary {
  id: string;
  label?: string;
  scope: string;
  createdAt: ISODateString;
  integrityHash: string;
  recordCount: number;
  redactedFields: string[];
}

export interface SnapshotVerification {
  snapshotId: string;
  valid: boolean;
  hashMatch: boolean;
  signatureMatch: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Secure import pipeline (issue #120)
//
// Contract surface for previewed, validated, quarantined, traceable imports
// with documented rollback/retry guidance.  All shapes are additive and
// backward compatible with CONTRACT_VERSION 1.0.0 (MINOR bump to 1.1.0).
// ---------------------------------------------------------------------------

/** Lifecycle of an import job as observed by API and frontend. */
export enum ImportJobStatus {
  /** Rows parsed, awaiting preview acknowledgement. */
  Previewed        = 'previewed',
  /** Preview acknowledged; accepted rows are being applied. */
  Committing       = 'committing',
  /** All accepted rows applied; quarantined rows remain for review. */
  Committed       = 'committed',
  /** Commit failed partway; rollback guidance is attached. */
  Failed           = 'failed',
  /** Commit was rolled back (automatic or operator-initiated). */
  RolledBack       = 'rolled_back',
  /** Job abandoned before commit; no rows were applied. */
  Cancelled       = 'cancelled',
}

/** Per-row validation outcome surfaced in preview and post-commit reports. */
export enum ImportRowStatus {
  /** Row passed validation and will be / was applied. */
  Accepted         = 'accepted',
  /** Row failed validation and is held for review; never applied. */
  Quarantined      = 'quarantined',
  /** Row was accepted and successfully applied. */
  Applied          = 'applied',
  /** Row was accepted but application failed; retryable per row. */
  ApplyFailed      = 'apply_failed',
  /** Row was applied then reverted during rollback. */
  Reverted         = 'reverted',
}

/** Stable, machine-readable reason a row was quarantined. */
export type ImportQuarantineReason =
  | 'schema_mismatch'
  | 'missing_required_field'
  | 'invalid_type'
  | 'invalid_wallet_address'
  | 'invalid_amount'
  | 'duplicate_row'
  | 'unknown_reference'
  | 'policy_violation'
  | 'size_limit_exceeded';

/** A single validated/quarantined row with traceability back to source. */
export interface ImportRowResult {
  /** 1-based line number in the uploaded source file. */
  sourceLine: number;
  /** Deterministic row fingerprint (hash of normalized source row). */
  rowHash: string;
  status: ImportRowStatus;
  /** Present when status is Quarantined or ApplyFailed. */
  quarantineReason?: ImportQuarantineReason;
  /** Human-readable validation messages keyed by field path. */
  fieldErrors?: Record<string, string[]>;
  /** Operation id created for this row when applied (traceability). */
  operationId?: OperationId;
}

/** Aggregate counts for a preview or commit report. */
export interface ImportRowSummary {
  total: number;
  accepted: number;
  quarantined: number;
  applied: number;
  applyFailed: number;
  reverted: number;
}

/** Preview response: nothing has been applied yet. */
export interface ImportPreview {
  importJobId: OperationId;
  status: ImportJobStatus.Previewed;
  sourceName: string;
  sourceHash: string;
  summary: ImportRowSummary;
  /** Bounded sample of rows (accepted + quarantined) for UI review. */
  rows: ImportRowResult[];
  /** True when the caller may proceed to commit. */
  canCommit: boolean;
  createdAt: ISODateString;
  correlationId: CorrelationId;
}

/** Commit result: accepted rows applied, quarantined rows held. */
export interface ImportCommitResult {
  importJobId: OperationId;
  status: ImportJobStatus.Committed | ImportJobStatus.Failed;
  summary: ImportRowSummary;
  /** Operation ids created for applied rows, for downstream tracing. */
  appliedOperationIds: OperationId[];
  /** Present when status is Failed; drives recovery center entry. */
  errorDetail?: OperationErrorDetail;
  recoveryAction?: RecoveryAction;
  committedAt?: ISODateString;
  correlationId: CorrelationId;
}

/** Rollback guidance attached to failed or rolled-back imports. */
export interface ImportRollbackGuidance {
  importJobId: OperationId;
  /** Whether rollback is automatic, operator-initiated, or unavailable. */
  mode: 'automatic' | 'manual' | 'unavailable';
  /** Steps an operator must follow, in order. */
  steps: string[];
  /** Endpoint to trigger rollback, when mode is 'manual'. */
  rollbackAction?: RecoveryAction;
  /** Endpoint to retry only quarantined rows after correction. */
  retryAction?: RecoveryAction;
  /** Edge cases and failure modes operators should be aware of. */
  edgeCases: string[];
}

// ---------------------------------------------------------------------------
// Version guard
// ---------------------------------------------------------------------------
/**
 * CONTRACT_VERSION is a semver string.  Increment MAJOR on breaking changes,
 * MINOR for new optional fields, PATCH for corrections/docs only.
 *
 * Consumers should assert `CONTRACT_VERSION` matches their expected range at
 * startup to detect drift early.
 */
export const CONTRACT_VERSION = '1.1.0';

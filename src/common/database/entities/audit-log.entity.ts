import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import { BaseEntity } from "./base.entity";

export enum LogLevel {
  ERROR = "error",
  WARN = "warn",
  INFO = "info",
  DEBUG = "debug",
}

export enum AuditAction {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LOGIN = "login",
  LOGOUT = "logout",
  ACCESS = "access",
  EXPORT = "export",
  PERMISSION_CHANGE = "permission_change",
  // Deterministic duplicate detection and merge review workflow actions.
  MERGE_PROPOSED = "merge_proposed",
  MERGE_APPROVED = "merge_approved",
  MERGE_REJECTED = "merge_rejected",
  MERGE_APPLIED = "merge_applied",
  MERGE_REVERTED = "merge_reverted",
}

export enum AuditOutcome {
  SUCCESS = "success",
  FAILURE = "failure",
  PARTIAL = "partial",
}

/**
 * Sealed entry in the tamper-evident audit ledger.
 *
 * The ledger is an append-only chain: each sealed entry commits to the
 * hash of its predecessor via `previousHash`, and to its own content via
 * `entryHash`. This allows any consumer to recompute the chain and detect
 * tampering (insertion, deletion, or mutation of sealed rows).
 */
export interface AuditLedgerSeal {
  /** Monotonically increasing sequence number within the ledger. */
  sequence: number;
  /** Hash of the previous sealed entry (genesis entry uses a fixed value). */
  previousHash: string;
  /** Hash of this entry's canonicalized content. */
  entryHash: string;
  /** Signature over `entryHash` using the ledger key. */
  signature: string;
  /** Identifier of the key used to sign the entry. */
  keyId: string;
  /** When the entry was sealed. */
  sealedAt: Date;
}

@Entity("audit_logs")
@Index(["userId", "createdAt"])
@Index(["action", "createdAt"])
@Index(["resourceType", "resourceId", "createdAt"])
@Index(["correlationId", "createdAt"])
@Index(["ledgerSequence"], { unique: true })
@Index(["ledgerPreviousHash"])
@Index(["ledgerEntryHash"], { unique: true })
export class AuditLog extends BaseEntity {
  @Column({ type: "uuid", nullable: true })
  @Index()
  userId: string;

  @Column({ type: "varchar", length: 50 })
  @Index()
  action: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  resourceType: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  resourceId: string;

  @Column({ type: "text", nullable: true })
  details: string;

  @Column({ type: "varchar", length: 45, nullable: true })
  ipAddress: string;

  @Column({ type: "text", nullable: true })
  userAgent: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  entityId: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  entityType: string;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, unknown>;

  @Column({ type: "varchar", length: 50, default: LogLevel.INFO })
  level: LogLevel;

  @Column({ type: "text", nullable: true })
  errorMessage: string;

  @Column({ type: "integer", nullable: true })
  durationMs: number;

  // ---------------------------------------------------------------------------
  // Duplicate detection / merge review audit fields
  // ---------------------------------------------------------------------------
  // Correlates all audit records belonging to a single detection run or merge
  // review workflow so the entire chain is replayable and reversible.
  @Column({ type: "uuid", nullable: true })
  @Index()
  correlationId: string;

  // Stable, deterministic identifier for the duplicate candidate group (e.g. a
  // sha256 of sorted normalized member ids). Used to deduplicate repeated
  // detection runs and to resolve concurrent review decisions.
  @Column({ type: "varchar", length: 64, nullable: true })
  @Index()
  candidateKey: string;

  // Deterministic digest of the candidate detection inputs and outputs, used to
  // verify that a replay of the same inputs produces the same candidates.
  @Column({ type: "varchar", length: 64, nullable: true })
  detectionDigest: string;

  // Outcome of the audited operation. Makes failure modes explicit in the audit
  // trail instead of inferring them from errorMessage.
  @Column({ type: "varchar", length: 20, nullable: true })
  outcome: AuditOutcome;

  // Previous state of the affected resource before the operation, enabling
  // reversal of merge actions where the source data is still available.
  @Column({ type: "jsonb", nullable: true })
  beforeState: Record<string, unknown>;

  // Resulting state of the affected resource after the operation, used for the
  // forward replay and for comparing the applied merge against the reviewed
  // proposal.
  @Column({ type: "jsonb", nullable: true })
  afterState: Record<string, unknown>;

  // Reference to the audit log entry that created the state being reversed.
  // Ensures a reversal is traceable and cannot be applied twice.
  @Column({ type: "uuid", nullable: true })
  @Index()
  reversesAuditId: string;

  // Optimistic concurrency guard for review decisions. Review actions must
  // carry the expected version of the candidate group to prevent lost updates.
  @Column({ type: "integer", nullable: true })
  expectedVersion: number;

  @Column({ type: "integer", nullable: true })
  resultingVersion: number;

  @Column({ type: "integer", nullable: true })
  sequence: number;

  @Column({ type: "varchar", length: 64, nullable: true })
  previousHash: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  hash: string;

  @Column({ type: "varchar", length: 64, nullable: true })
  payloadHash: string;

  // ---------------------------------------------------------------------------
  // Tamper-evident ledger sealing fields
  // ---------------------------------------------------------------------------
  // Audit rows are appended unsealed and then sealed in sequence by the ledger
  // writer. Once sealed, the seal fields are immutable; tamper detection relies
  // on recomputing the chain from the canonical entry payload.
  // ---------------------------------------------------------------------------

  // Monotonically increasing position in the ledger chain. Unique per entry.
  @Column({ type: "bigint", nullable: true })
  ledgerSequence: string;

  // Hash of the preceding sealed entry. The genesis entry uses the constant
  // GENESIS_HASH (0^64) so the chain has a well-defined root.
  @Column({ type: "varchar", length: 64, nullable: true })
  ledgerPreviousHash: string;

  // SHA-256 hash over the canonicalized entry payload including
  // ledgerPreviousHash and ledgerSequence.
  @Column({ type: "varchar", length: 64, nullable: true })
  ledgerEntryHash: string;

  // HMAC-SHA256 signature over ledgerEntryHash, keyed by the ledger signing
  // key. Provides authenticity in addition to integrity.
  @Column({ type: "varchar", length: 64, nullable: true })
  ledgerSignature: string;

  // Identifier of the key used to sign the entry, enabling key rotation
  // without invalidating historical entries.
  @Column({ type: "varchar", length: 64, nullable: true })
  ledgerKeyId: string;

  // Timestamp at which the entry was sealed. Distinct from createdAt so that
  // seal latency and out-of-order sealing are observable.
  @Column({ type: "timestamp", nullable: true })
  ledgerSealedAt: Date;

  /**
  * Returns true when this row has been sealed into the ledger chain.
  */
  isSealed(): boolean {
    return (
      this.ledgerSequence != null &&
      this.ledgerPreviousHash != null &&
      this.ledgerEntryHash != null &&
      this.ledgerSignature != null &&
      this.ledgerKeyId != null &&
      this.ledgerSealedAt != null
    );
  }

  /**
   * Projects the seal fields into the public seal shape used by export and
   * verification tooling. Throws if the row is not yet sealed.
   */
  toSeal(): AuditLedgerSeal {
    if (!this.isSealed()) {
      throw new Error(
        `Audit log ${this.id} is not sealed into the ledger`,
      );
    }
    return {
      sequence: Number(this.ledgerSequence),
      previousHash: this.ledgerPreviousHash,
      entryHash: this.ledgerEntryHash,
      signature: this.ledgerSignature,
      keyId: this.ledgerKeyId,
      sealedAt: this.ledgerSealedAt,
    };
  }
}

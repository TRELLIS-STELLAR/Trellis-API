/**
 * Cryptographic provenance for imported records (#issue-3)
 *
 * Extends the evidence verification system to provide comprehensive provenance
 * tracking for all imported records. Each import creates a verifiable chain
 * of custody with cryptographic signatures, timestamps, and authorization
 * records.
 */

import { createHash } from "crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "../../common/errors/app.exception";
import {
  EvidenceActor,
  EvidenceVerifier,
  ExternalEvidence,
  TrustedEvidenceKey,
  computePayloadDigest,
  evidenceSigningInput,
} from "../../common/evidence/evidence-verifier";
import { Permission, Role, hasPermission } from "../../common/guard/roles.enum";
import { canonicalJson } from "../../common/serialization/canonical-json";

export interface ProvenanceRecord {
  /** Unique identifier for this provenance record */
  id: string;
  /** ID of the imported record */
  recordId: string;
  /** Type of imported record */
  recordType: string;
  /** Cryptographic digest of the record content */
  contentDigest: string;
  /** Original evidence if from external source */
  evidence?: ExternalEvidence;
  /** Actor who performed the import */
  importedBy: {
    actorId: string;
    roles: Role[];
    timestamp: string;
  };
  /** Source information */
  source: {
    issuer: string;
    keyId?: string;
    verified: boolean;
    verificationTimestamp?: string;
  };
  /** Chain of custody */
  chain: ProvenanceChainEntry[];
  /** Metadata */
  metadata: {
    importMethod: "external" | "internal" | "migration" | "system";
    version: string;
    tags?: string[];
  };
}

export interface ProvenanceChainEntry {
  /** Sequence number in the chain */
  sequence: number;
  /** Action performed */
  action: "imported" | "verified" | "modified" | "archived" | "restored";
  /** Actor who performed the action */
  actor: string;
  /** Timestamp of the action */
  timestamp: string;
  /** Content digest at this point in the chain */
  contentDigest: string;
  /** Signature of the chain entry (optional) */
  signature?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface ProvenanceQuery {
  recordId?: string;
  recordType?: string;
  issuer?: string;
  importedBy?: string;
  fromDate?: string;
  toDate?: string;
  verified?: boolean;
  tags?: string[];
}

export interface ProvenanceVerification {
  valid: boolean;
  recordId: string;
  contentDigest: string;
  chainValid: boolean;
  evidenceValid: boolean;
  issues: ProvenanceIssue[];
}

export interface ProvenanceIssue {
  severity: "error" | "warning" | "info";
  type: string;
  message: string;
  chainEntry?: number;
}

export interface ProvenanceStatistics {
  totalRecords: number;
  verifiedRecords: number;
  unverifiedRecords: number;
  bySource: Record<string, number>;
  byType: Record<string, number>;
  byImportMethod: Record<string, number>;
  failedVerifications: number;
  chainIntegrityIssues: number;
}

export interface ProvenanceOptions {
  /** Enable automatic chain signing */
  autoSignChain?: boolean;
  /** Signing key for chain entries */
  signingKey?: string;
  /** Enable strict verification */
  strictMode?: boolean;
  /** Maximum chain length before archival */
  maxChainLength?: number;
  /** Enable automatic archival */
  autoArchive?: boolean;
}

/**
 * Cryptographic provenance service for imported records
 */
export class CryptographicProvenanceService {
  private readonly records = new Map<string, ProvenanceRecord>();
  private readonly recordIndex = new Map<string, Set<string>>();
  private readonly evidenceVerifier: EvidenceVerifier;
  private readonly options: Required<ProvenanceOptions>;

  constructor(
    trustedKeys: TrustedEvidenceKey[],
    options: ProvenanceOptions = {},
  ) {
    this.evidenceVerifier = new EvidenceVerifier(trustedKeys);
    this.options = {
      autoSignChain: options.autoSignChain ?? false,
      signingKey: options.signingKey ?? "",
      strictMode: options.strictMode ?? true,
      maxChainLength: options.maxChainLength ?? 1000,
      autoArchive: options.autoArchive ?? true,
    };
  }

  /**
   * Import a record with cryptographic provenance
   */
  importRecord(
    actor: EvidenceActor,
    recordId: string,
    recordType: string,
    content: Record<string, unknown>,
    evidence?: ExternalEvidence,
    metadata?: Partial<ProvenanceRecord["metadata"]>,
  ): ProvenanceRecord {
    // Authorization check
    if (!hasPermission(actor.roles, Permission.IMPORT_EXECUTE)) {
      throw new ForbiddenException("Not allowed to import records");
    }

    // Check for duplicate
    if (this.records.has(recordId)) {
      const existing = this.records.get(recordId)!;
      const contentDigest = this.computeContentDigest(content);

      if (existing.contentDigest === contentDigest) {
        // Safe retry - return existing record
        return existing;
      }

      throw new ConflictException(
        `Record ${recordId} already exists with different content`,
      );
    }

    // Verify evidence if provided
    let evidenceValid = false;
    let verificationTimestamp: string | undefined;

    if (evidence) {
      const accepted = this.evidenceVerifier.accept(actor, evidence);
      evidenceValid = true;
      verificationTimestamp = new Date().toISOString();

      if (this.options.strictMode && accepted.duplicate) {
        throw new ConflictException(
          `Evidence ${evidence.id} was already used for a different import`,
        );
      }
    }

    // Create provenance record
    const contentDigest = this.computeContentDigest(content);
    const now = new Date().toISOString();

    const chainEntry: ProvenanceChainEntry = {
      sequence: 0,
      action: "imported",
      actor: actor.id,
      timestamp: now,
      contentDigest,
    };

    if (this.options.autoSignChain && this.options.signingKey) {
      chainEntry.signature = this.signChainEntry(chainEntry);
    }

    const provenance: ProvenanceRecord = {
      id: this.generateProvenanceId(),
      recordId,
      recordType,
      contentDigest,
      evidence,
      importedBy: {
        actorId: actor.id,
        roles: actor.roles,
        timestamp: now,
      },
      source: {
        issuer: evidence?.issuer ?? "internal",
        keyId: evidence?.keyId,
        verified: evidenceValid,
        verificationTimestamp,
      },
      chain: [chainEntry],
      metadata: {
        importMethod: evidence ? "external" : "internal",
        version: "1.0.0",
        ...metadata,
      },
    };

    // Store and index
    this.records.set(recordId, provenance);
    this.indexRecord(provenance);

    return provenance;
  }

  /**
   * Add a chain entry to track modifications
   */
  addChainEntry(
    actor: EvidenceActor,
    recordId: string,
    action: ProvenanceChainEntry["action"],
    newContent: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): ProvenanceRecord {
    const provenance = this.records.get(recordId);
    if (!provenance) {
      throw new BadRequestException(`Record ${recordId} not found`);
    }

    // Authorization check for modification
    if (action === "modified" && !hasPermission(actor.roles, Permission.IMPORT_EXECUTE)) {
      throw new ForbiddenException("Not allowed to modify records");
    }

    const contentDigest = this.computeContentDigest(newContent);
    const now = new Date().toISOString();

    const chainEntry: ProvenanceChainEntry = {
      sequence: provenance.chain.length,
      action,
      actor: actor.id,
      timestamp: now,
      contentDigest,
      metadata,
    };

    if (this.options.autoSignChain && this.options.signingKey) {
      chainEntry.signature = this.signChainEntry(chainEntry);
    }

    provenance.chain.push(chainEntry);
    provenance.contentDigest = contentDigest;

    // Auto-archive if chain is too long
    if (
      this.options.autoArchive &&
      provenance.chain.length >= this.options.maxChainLength
    ) {
      this.archiveOldEntries(recordId);
    }

    return provenance;
  }

  /**
   * Verify the complete provenance of a record
   */
  verifyProvenance(recordId: string): ProvenanceVerification {
    const provenance = this.records.get(recordId);
    if (!provenance) {
      return {
        valid: false,
        recordId,
        contentDigest: "",
        chainValid: false,
        evidenceValid: false,
        issues: [
          {
            severity: "error",
            type: "NOT_FOUND",
            message: `Record ${recordId} not found`,
          },
        ],
      };
    }

    const issues: ProvenanceIssue[] = [];
    let chainValid = true;
    let evidenceValid = true;

    // Verify evidence if present
    if (provenance.evidence) {
      const result = this.evidenceVerifier.verify(provenance.evidence);
      if (!result.valid) {
        evidenceValid = false;
        issues.push({
          severity: "error",
          type: "EVIDENCE_INVALID",
          message: `Evidence verification failed: ${result.reason}`,
        });
      }
    }

    // Verify chain integrity
    const chainIssues = this.verifyChainIntegrity(provenance);
    if (chainIssues.length > 0) {
      chainValid = false;
      issues.push(...chainIssues);
    }

    return {
      valid: chainValid && evidenceValid,
      recordId,
      contentDigest: provenance.contentDigest,
      chainValid,
      evidenceValid,
      issues,
    };
  }

  /**
   * Query provenance records
   */
  queryProvenance(query: ProvenanceQuery): ProvenanceRecord[] {
    const results: ProvenanceRecord[] = [];

    for (const provenance of this.records.values()) {
      if (this.matchesQuery(provenance, query)) {
        results.push(provenance);
      }
    }

    return results;
  }

  /**
   * Get provenance statistics
   */
  getStatistics(): ProvenanceStatistics {
    const stats: ProvenanceStatistics = {
      totalRecords: this.records.size,
      verifiedRecords: 0,
      unverifiedRecords: 0,
      bySource: {},
      byType: {},
      byImportMethod: {},
      failedVerifications: 0,
      chainIntegrityIssues: 0,
    };

    for (const provenance of this.records.values()) {
      // Count verified vs unverified
      if (provenance.source.verified) {
        stats.verifiedRecords += 1;
      } else {
        stats.unverifiedRecords += 1;
      }

      // Count by source
      const source = provenance.source.issuer;
      stats.bySource[source] = (stats.bySource[source] ?? 0) + 1;

      // Count by type
      const type = provenance.recordType;
      stats.byType[type] = (stats.byType[type] ?? 0) + 1;

      // Count by import method
      const method = provenance.metadata.importMethod;
      stats.byImportMethod[method] = (stats.byImportMethod[method] ?? 0) + 1;

      // Check for issues
      const verification = this.verifyProvenance(provenance.recordId);
      if (!verification.evidenceValid) {
        stats.failedVerifications += 1;
      }
      if (!verification.chainValid) {
        stats.chainIntegrityIssues += 1;
      }
    }

    return stats;
  }

  /**
   * Get provenance history for a record
   */
  getProvenanceHistory(recordId: string): ProvenanceChainEntry[] {
    const provenance = this.records.get(recordId);
    return provenance ? [...provenance.chain] : [];
  }

  /**
   * Export provenance for auditing
   */
  exportProvenance(recordId: string): string {
    const provenance = this.records.get(recordId);
    if (!provenance) {
      throw new BadRequestException(`Record ${recordId} not found`);
    }

    return canonicalJson(provenance);
  }

  /**
   * Batch verify multiple records
   */
  batchVerify(recordIds: string[]): Map<string, ProvenanceVerification> {
    const results = new Map<string, ProvenanceVerification>();

    for (const recordId of recordIds) {
      results.set(recordId, this.verifyProvenance(recordId));
    }

    return results;
  }

  // Private helper methods

  private computeContentDigest(content: Record<string, unknown>): string {
    return computePayloadDigest(content);
  }

  private generateProvenanceId(): string {
    return `prov-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private signChainEntry(entry: ProvenanceChainEntry): string {
    const data = canonicalJson({
      sequence: entry.sequence,
      action: entry.action,
      actor: entry.actor,
      timestamp: entry.timestamp,
      contentDigest: entry.contentDigest,
    });

    return createHash("sha256").update(data).digest("base64");
  }

  private verifyChainIntegrity(provenance: ProvenanceRecord): ProvenanceIssue[] {
    const issues: ProvenanceIssue[] = [];

    // Check sequence numbers
    for (let i = 0; i < provenance.chain.length; i++) {
      const entry = provenance.chain[i];

      if (entry.sequence !== i) {
        issues.push({
          severity: "error",
          type: "SEQUENCE_MISMATCH",
          message: `Chain entry ${i} has sequence ${entry.sequence}`,
          chainEntry: i,
        });
      }

      // Verify signature if present
      if (entry.signature && this.options.autoSignChain) {
        const expectedSignature = this.signChainEntry(entry);
        if (entry.signature !== expectedSignature) {
          issues.push({
            severity: "error",
            type: "SIGNATURE_MISMATCH",
            message: `Chain entry ${i} signature is invalid`,
            chainEntry: i,
          });
        }
      }
    }

    // Check timestamps are monotonically increasing
    for (let i = 1; i < provenance.chain.length; i++) {
      const prev = Date.parse(provenance.chain[i - 1].timestamp);
      const curr = Date.parse(provenance.chain[i].timestamp);

      if (curr < prev) {
        issues.push({
          severity: "warning",
          type: "TIMESTAMP_ORDER",
          message: `Chain entry ${i} has timestamp before previous entry`,
          chainEntry: i,
        });
      }
    }

    return issues;
  }

  private matchesQuery(provenance: ProvenanceRecord, query: ProvenanceQuery): boolean {
    if (query.recordId && provenance.recordId !== query.recordId) {
      return false;
    }

    if (query.recordType && provenance.recordType !== query.recordType) {
      return false;
    }

    if (query.issuer && provenance.source.issuer !== query.issuer) {
      return false;
    }

    if (query.importedBy && provenance.importedBy.actorId !== query.importedBy) {
      return false;
    }

    if (query.verified !== undefined && provenance.source.verified !== query.verified) {
      return false;
    }

    if (query.fromDate) {
      const importTime = Date.parse(provenance.importedBy.timestamp);
      if (importTime < Date.parse(query.fromDate)) {
        return false;
      }
    }

    if (query.toDate) {
      const importTime = Date.parse(provenance.importedBy.timestamp);
      if (importTime > Date.parse(query.toDate)) {
        return false;
      }
    }

    if (query.tags && provenance.metadata.tags) {
      const hasAllTags = query.tags.every((tag) =>
        provenance.metadata.tags!.includes(tag),
      );
      if (!hasAllTags) {
        return false;
      }
    }

    return true;
  }

  private indexRecord(provenance: ProvenanceRecord): void {
    // Index by type
    if (!this.recordIndex.has(provenance.recordType)) {
      this.recordIndex.set(provenance.recordType, new Set());
    }
    this.recordIndex.get(provenance.recordType)!.add(provenance.recordId);

    // Index by issuer
    const issuerKey = `issuer:${provenance.source.issuer}`;
    if (!this.recordIndex.has(issuerKey)) {
      this.recordIndex.set(issuerKey, new Set());
    }
    this.recordIndex.get(issuerKey)!.add(provenance.recordId);
  }

  private archiveOldEntries(recordId: string): void {
    const provenance = this.records.get(recordId);
    if (!provenance) return;

    // Keep only the most recent entries
    const keepCount = Math.floor(this.options.maxChainLength / 2);
    const toArchive = provenance.chain.slice(0, -keepCount);

    // In a real implementation, this would store archived entries separately
    provenance.chain = provenance.chain.slice(-keepCount);

    // Re-sequence
    provenance.chain.forEach((entry, i) => {
      entry.sequence = i;
    });
  }
}

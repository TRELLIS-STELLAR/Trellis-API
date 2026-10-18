import {
  Injectable,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SearchService } from '../search/search.service';
import {
  SNAPSHOT_REDACTED_FIELDS,
  REDACTED_PLACEHOLDER,
  SNAPSHOT_HASH_ALGORITHM,
  SNAPSHOT_HMAC_ALGORITHM,
  SNAPSHOT_MAX_RECORDS,
} from './snapshot.constants';
import { RequestSnapshotDto, VerifySnapshotDto } from './dto/snapshot.dto';

export interface SnapshotRecord {
  id: string;
  label?: string;
  scope: string;
  createdAt: string;
  payload: Record<string, unknown>;
  integrityHash: string;
  signature: string;
  redactedFields: string[];
  recordCount: number;
}

export interface SnapshotVerificationResult {
  snapshotId: string;
  valid: boolean;
  hashMatch: boolean;
  signatureMatch: boolean;
  reason?: string;
}

export interface SnapshotRestoreVerificationResult {
  snapshotId: string;
  valid: boolean;
  integrityValid: boolean;
  criticalData: {
    matches: boolean;
    expectedCounts: Record<string, number>;
    actualCounts: Record<string, number>;
    mismatches: string[];
  };
  derivedIndexes: {
    search: { expected: number; rebuilt: number; verified: boolean };
  };
  repairSteps: string[];
}

const CRITICAL_TABLES = [
  'users',
  'portfolios',
  'portfolio_assets',
  'transactions',
  'agent_reviews',
  'agent_events',
  'background_jobs',
  'retry_operations',
  'audit_logs',
  'sensitive_action_events',
  'provenance_records',
  'search_records',
] as const;

interface SnapshotRestoreManifest {
  criticalTableCounts: Record<string, number>;
  activeSearchRecords: number;
}

@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly signingKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly searchService: SearchService,
  ) {
    this.signingKey =
      this.config.get<string>('SNAPSHOT_SIGNING_KEY') ??
      'trellis-snapshot-dev-key-change-in-production';
  }

  /**
   * Generate a signed state snapshot.
   * Secrets are redacted before hashing to prevent leakage.
   */
  async createSnapshot(dto: RequestSnapshotDto, requesterId: string): Promise<SnapshotRecord> {
    const limit = Math.min(dto.limit ?? 500, SNAPSHOT_MAX_RECORDS);
    const rawPayload = await this.collectPayload(dto.scope, dto.resourceIds, limit);
    rawPayload.restoreManifest = await this.captureRestoreManifest();
    const { redacted, removedFields } = this.redactPayload(rawPayload);

    // Canonical JSON (sorted keys) so hash is deterministic regardless of insertion order
    const canonical = this.canonicalise(redacted);
    const integrityHash = this.hash(canonical);
    const signature = this.sign(integrityHash);

    const record: SnapshotRecord = {
      id: crypto.randomUUID(),
      label: dto.label,
      scope: dto.scope,
      createdAt: new Date().toISOString(),
      payload: redacted,
      integrityHash,
      signature,
      redactedFields: removedFields,
      recordCount: this.countRecords(redacted),
    };

    this.snapshots.set(record.id, record);
    this.logger.log(`Snapshot ${record.id} created by ${requesterId} — scope=${dto.scope} records=${record.recordCount}`);
    return record;
  }

  /** Verify a stored snapshot hasn't been tampered with. */
  async verifySnapshot(dto: VerifySnapshotDto): Promise<SnapshotVerificationResult> {
    const record = this.snapshots.get(dto.snapshotId);
    if (!record) {
      return { snapshotId: dto.snapshotId, valid: false, hashMatch: false, signatureMatch: false, reason: 'Snapshot not found' };
    }

    const canonical = this.canonicalise(record.payload);
    const recomputed = this.hash(canonical);
    const payloadHashMatches = recomputed === record.integrityHash;
    const recordCountMatches =
      this.countRecords(record.payload) === record.recordCount;
    const hashMatch = payloadHashMatches && recordCountMatches;
    const expectedSig = this.sign(recomputed);
    const signatureMatch =
      dto.expectedSignature
        ? this.timingSafeCompare(dto.expectedSignature, record.signature)
        : this.timingSafeCompare(expectedSig, record.signature);

    return {
      snapshotId: dto.snapshotId,
      valid: hashMatch && signatureMatch,
      hashMatch,
      signatureMatch,
      reason: !payloadHashMatches ? 'Integrity hash mismatch — payload was modified after export' :
              !recordCountMatches ? 'Record count mismatch — snapshot payload is incomplete or inconsistent' :
              !signatureMatch ? 'Signature mismatch — snapshot may have been tampered with' :
              undefined,
    };
  }

  /**
   * Verify critical row-count invariants for a restored snapshot and rebuild
   * the Elasticsearch search projection from its PostgreSQL source of truth.
   */
  async verifyRestoredSnapshot(
    dto: VerifySnapshotDto,
  ): Promise<SnapshotRestoreVerificationResult> {
    const snapshot = this.snapshots.get(dto.snapshotId);
    const emptyCounts: Record<string, number> = {};
    const result: SnapshotRestoreVerificationResult = {
      snapshotId: dto.snapshotId,
      valid: false,
      integrityValid: false,
      criticalData: {
        matches: false,
        expectedCounts: emptyCounts,
        actualCounts: emptyCounts,
        mismatches: [],
      },
      derivedIndexes: {
        search: { expected: 0, rebuilt: 0, verified: false },
      },
      repairSteps: [],
    };

    if (!snapshot) {
      result.repairSteps.push(
        'Load the retained snapshot record into this service and retry verification; the current snapshot store is process-local.',
      );
      return result;
    }

    const integrity = await this.verifySnapshot(dto);
    result.integrityValid = integrity.valid;
    if (!integrity.valid) {
      result.repairSteps.push(
        'Restore an unmodified snapshot with a valid signature before rebuilding derived data.',
      );
      return result;
    }

    const manifest = snapshot.payload.restoreManifest as
      | SnapshotRestoreManifest
      | undefined;
    if (!manifest) {
      result.repairSteps.push(
        'Create a new snapshot so its critical-table and search-index manifest is included.',
      );
      return result;
    }

    let actualManifest: SnapshotRestoreManifest;
    try {
      actualManifest = await this.captureRestoreManifest();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result.repairSteps.push(
        `Critical data verification failed: ${detail}. Restore the missing schema or database connection, then retry.`,
      );
      return result;
    }
    result.criticalData.expectedCounts = manifest.criticalTableCounts;
    result.criticalData.actualCounts = actualManifest.criticalTableCounts;
    result.criticalData.mismatches = CRITICAL_TABLES.filter(
      (table) =>
        manifest.criticalTableCounts[table] !==
        actualManifest.criticalTableCounts[table],
    ).map(
      (table) =>
        `${table}: expected ${manifest.criticalTableCounts[table]}, found ${actualManifest.criticalTableCounts[table]}`,
    );
    if (manifest.activeSearchRecords !== actualManifest.activeSearchRecords) {
      result.criticalData.mismatches.push(
        `active search records: expected ${manifest.activeSearchRecords}, found ${actualManifest.activeSearchRecords}`,
      );
    }
    result.criticalData.matches = result.criticalData.mismatches.length === 0;
    result.derivedIndexes.search.expected = actualManifest.activeSearchRecords;

    try {
      const repair = await this.searchService.repairIndex();
      result.derivedIndexes.search.rebuilt = repair.indexed;
      result.derivedIndexes.search.verified = repair.verified;
      if (repair.indexed !== actualManifest.activeSearchRecords) {
        result.repairSteps.push(
          'Reconcile search_records in PostgreSQL with the snapshot, then retry the search-index rebuild.',
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result.repairSteps.push(
        `Search index rebuild failed: ${detail}. Restore Elasticsearch connectivity and rerun verification.`,
      );
    }

    if (!result.criticalData.matches) {
      result.repairSteps.push(
        'Restore the listed critical tables from the same snapshot; do not serve writes until the counts match.',
      );
    }
    result.valid =
      result.integrityValid &&
      result.criticalData.matches &&
      result.derivedIndexes.search.verified &&
      result.derivedIndexes.search.rebuilt ===
        result.derivedIndexes.search.expected;
    return result;
  }

  getSnapshot(id: string): SnapshotRecord | undefined {
    return this.snapshots.get(id);
  }

  listSnapshots(): Omit<SnapshotRecord, 'payload'>[] {
    return [...this.snapshots.values()].map(({ payload: _p, ...rest }) => rest);
  }

  private async captureRestoreManifest(): Promise<SnapshotRestoreManifest> {
    const metadataByTable = new Map(
      this.dataSource.entityMetadatas.map((metadata) => [
        metadata.tableName,
        metadata,
      ]),
    );
    const criticalTableCounts: Record<string, number> = {};
    for (const table of CRITICAL_TABLES) {
      const metadata = metadataByTable.get(table);
      if (!metadata) {
        throw new Error(
          `Cannot verify snapshot: critical table ${table} is not registered with TypeORM`,
        );
      }
      criticalTableCounts[table] = await this.dataSource
        .getRepository(metadata.target)
        .count({ withDeleted: true });
    }

    return {
      criticalTableCounts,
      activeSearchRecords: await this.searchService.countActiveRecords(),
    };
  }

  // --- Private helpers ---

  private async collectPayload(
    scope: string,
    resourceIds?: string[],
    limit = 500,
  ): Promise<Record<string, unknown>> {
    // In production this would query real repositories.
    // This stub returns an envelope that is deterministic and safe to hash.
    const base: Record<string, unknown> = {
      scope,
      capturedAt: new Date().toISOString(),
      environment: process.env.NODE_ENV ?? 'unknown',
    };

    if (resourceIds?.length) {
      base.resourceIds = resourceIds;
    }

    base.meta = { limit, note: 'live data injected by repository layer in production' };
    return base;
  }

  /** Deep-clone and strip any key whose name is on the redact list. */
  private redactPayload(obj: unknown, removedFields: Set<string> = new Set()): { redacted: Record<string, unknown>; removedFields: string[] } {
    const redacted = this.deepRedact(obj, removedFields) as Record<string, unknown>;
    return { redacted, removedFields: [...removedFields] };
  }

  private deepRedact(value: unknown, removed: Set<string>): unknown {
    if (Array.isArray(value)) return value.map(v => this.deepRedact(v, removed));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SNAPSHOT_REDACTED_FIELDS.includes(k.toLowerCase()) || SNAPSHOT_REDACTED_FIELDS.includes(k)) {
          out[k] = REDACTED_PLACEHOLDER;
          removed.add(k);
        } else {
          out[k] = this.deepRedact(v, removed);
        }
      }
      return out;
    }
    return value;
  }

  /** Sort all object keys recursively so JSON serialisation is canonical. */
  private canonicalise(obj: unknown): string {
    return JSON.stringify(obj, (_, v) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)))
        : v,
    );
  }

  private hash(data: string): string {
    return crypto.createHash(SNAPSHOT_HASH_ALGORITHM).update(data, 'utf8').digest('hex');
  }

  private sign(hash: string): string {
    return crypto.createHmac(SNAPSHOT_HMAC_ALGORITHM, this.signingKey).update(hash).digest('hex');
  }

  private timingSafeCompare(a: string, b: string): boolean {
    try {
      const ba = Buffer.from(a);
      const bb = Buffer.from(b);
      if (ba.length !== bb.length) return false;
      return crypto.timingSafeEqual(ba, bb);
    } catch {
      return false;
    }
  }

  private countRecords(obj: unknown): number {
    if (Array.isArray(obj)) return obj.length;
    if (obj !== null && typeof obj === 'object') {
      return Object.values(obj as object).reduce((sum: number, v) => sum + this.countRecords(v), 0);
    }
    return 1;
  }
}

import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource, Repository, IsNull, EntityManager, LessThan, MoreThan } from "typeorm";
import { BaseRepository, FindOptions, BaseEntity } from "./base.repository";
import { AuditLog, LogLevel, AuditAction } from "../entities/audit-log.entity";
import { createHash, timingSafeEqual } from "crypto";

export interface CreateAuditLogDto {
  userId?: string;
  action: AuditAction;
  resourceType?: string;
  resourceId?: string;
  details?: string;
  ipAddress?: string;
  userAgent?: string;
  entityId?: string;
  entityType?: string;
  metadata?: Record<string, unknown>;
  level?: LogLevel;
  errorMessage?: string;
  durationMs?: number;
}

export interface AuditLedgerEntry {
  id: string;
  sequence: number;
  previousHash: string | null;
  hash: string;
  payloadHash: string;
  createdAt: Date;
}

export interface AuditLedgerVerificationResult {
  valid: boolean;
  entriesChecked: number;
  brokenAtId?: string;
  brokenAt?: string;
  brokenAtSequence?: number;
  reason?: string;
}

export interface AuditLedgerExport {
  generatedAt: string;
  entries: AuditLedgerEntry[];
  verification: AuditLedgerVerificationResult;
}

const GENESIS_HASH_ALGORITHM = "sha256";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash(GENESIS_HASH_ALGORITHM)
    .update(stableStringify(payload))
    .digest("hex");
}

function computeChainHash(
  payloadHash: string,
  previousHash: string | null,
  sequence: number,
): string {
  return createHash(GENESIS_HASH_ALGORITHM)
    .update(`${sequence}:${previousHash ?? ""}:${payloadHash}`)
    .digest("hex");
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(0);
}

@Injectable()
export class AuditLogRepository extends BaseRepository<AuditLog> {
  constructor(dataSource: DataSource) {
    super(dataSource, AuditLog);
  }

  /**
   * Create an audit log and append it to the tamper-evident hash chain.
   *
   * The chain is append-only: each row stores its sequence number, the
   * previous entry hash, a deterministic payload hash, and the chain hash.
   * Concurrent writes are serialized using a pessimistic row lock on the
   * latest entry within a transaction.
   */
  async createLog(dto: CreateAuditLogDto): Promise<AuditLog> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AuditLog);
      const latest = await repo
        .createQueryBuilder("log")
        .orderBy("log.sequence", "DESC")
        .setLock("pessimistic_write")
        .getOne();

      const sequence = (latest?.sequence ?? 0) + 1;
      const previousHash = latest?.hash ?? null;
      const createdAt = new Date();

      const payload: Record<string, unknown> = {
        sequence,
        previousHash,
        userId: dto.userId ?? null,
        action: dto.action || AuditAction.ACCESS,
        resourceType: dto.resourceType ?? null,
        resourceId: dto.resourceId ?? null,
        details: dto.details ?? null,
        ipAddress: dto.ipAddress ?? null,
        userAgent: dto.userAgent ?? null,
        entityId: dto.entityId ?? null,
        entityType: dto.entityType ?? null,
        metadata: dto.metadata ?? null,
        level: dto.level || LogLevel.INFO,
        errorMessage: dto.errorMessage ?? null,
        durationMs: dto.durationMs ?? null,
        createdAt: createdAt.toISOString(),
      };

      const payloadHash = hashPayload(payload);
      const hash = computeChainHash(payloadHash, previousHash, sequence);

      const entity = repo.create({
        ...(dto as any),
        action: dto.action || AuditAction.ACCESS,
        level: dto.level || LogLevel.INFO,
        sequence,
        previousHash,
        payloadHash,
        hash,
        createdAt,
      });

      return repo.save(entity) as unknown as Promise<AuditLog>;
    });
  }

  /**
   * Verify the integrity of the hash chain between two sequences (inclusive).
   * Returns the first broken entry if tampering is detected.
   */
  async verifyChain(
    fromSequence?: number,
    toSequence?: number,
  ): Promise<AuditLedgerVerificationResult> {
    const repo = this.repository;
    const qb = repo.createQueryBuilder("log").orderBy("log.sequence", "ASC");
    if (typeof fromSequence === "number") {
      qb.andWhere("log.sequence >= :fromSequence", { fromSequence });
    }
    if (typeof toSequence === "number") {
      qb.andWhere("log.sequence <= :toSequence", { toSequence });
    }
    const entries = await qb.getMany();

    let expectedSequence = entries.length > 0 ? entries[0].sequence : 1;
    let previousHash: string | null = null;

    if (entries.length > 0 && entries[0].sequence > 1) {
      const preceding = await repo.findOne({
        where: { sequence: entries[0].sequence - 1 } as any,
      });
      previousHash = preceding?.hash ?? null;
    }

    for (const entry of entries) {
      if (entry.sequence !== expectedSequence) {
        return {
          valid: false,
          entriesChecked: entries.length,
          brokenAt: entry.id,
          brokenAtId: entry.id,
          brokenAtSequence: entry.sequence,
          reason: `sequence gap: expected ${expectedSequence}, got ${entry.sequence}`,
        };
      }
      if ((entry.previousHash ?? null) !== previousHash) {
        return {
          valid: false,
          entriesChecked: entries.length,
          brokenAt: entry.id,
          brokenAtId: entry.id,
          brokenAtSequence: entry.sequence,
          reason: "previous hash mismatch",
        };
      }

      const payload = this.buildPayload(entry);
      const payloadHash = hashPayload(payload);
      if (!timingSafeEqual(Buffer.from(payloadHash), Buffer.from(entry.payloadHash || ""))) {
        return {
          valid: false,
          entriesChecked: entries.length,
          brokenAt: entry.id,
          brokenAtId: entry.id,
          brokenAtSequence: entry.sequence,
          reason: "payload hash mismatch (content tampered)",
        };
      }

      const expectedChainHash = computeChainHash(
        entry.payloadHash,
        entry.previousHash ?? null,
        entry.sequence,
      );
      if (!timingSafeEqual(Buffer.from(expectedChainHash), Buffer.from(entry.hash || ""))) {
        return {
          valid: false,
          entriesChecked: entries.length,
          brokenAt: entry.id,
          brokenAtId: entry.id,
          brokenAtSequence: entry.sequence,
          reason: "chain hash mismatch",
        };
      }

      previousHash = entry.hash;
      expectedSequence += 1;
    }

    return { valid: true, entriesChecked: entries.length };
  }

  /**
   * Export the ledger as a verifiable JSON document including a verification
   * result. The export is deterministic for a given range so it can be
   * re-hashed by an external auditor.
   */
  async exportLedger(
    fromSequence?: number,
    toSequence?: number,
  ): Promise<AuditLedgerExport> {
    const repo = this.repository;
    const qb = repo.createQueryBuilder("log").orderBy("log.sequence", "ASC");
    if (typeof fromSequence === "number") {
      qb.andWhere("log.sequence >= :fromSequence", { fromSequence });
    }
    if (typeof toSequence === "number") {
      qb.andWhere("log.sequence <= :toSequence", { toSequence });
    }
    const rows = await qb.getMany();
    const entries: AuditLedgerEntry[] = rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      previousHash: row.previousHash ?? null,
      hash: row.hash,
      payloadHash: row.payloadHash,
      createdAt: toDate(row.createdAt),
    }));
    const verification = await this.verifyChain(fromSequence, toSequence);
    return {
      generatedAt: new Date().toISOString(),
      entries,
      verification,
    };
  }

  async exportChain(
    fromSequence?: number,
    toSequence?: number,
  ): Promise<AuditLedgerEntry[]> {
    const exported = await this.exportLedger(fromSequence, toSequence);
    return exported.entries;
  }

  private buildPayload(entry: AuditLog): Record<string, unknown> {
    return {
      sequence: entry.sequence,
      previousHash: entry.previousHash ?? null,
      userId: entry.userId ?? null,
      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      details: entry.details ?? null,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      entityId: entry.entityId ?? null,
      entityType: entry.entityType ?? null,
      metadata: entry.metadata ?? null,
      level: entry.level,
      errorMessage: entry.errorMessage ?? null,
      durationMs: entry.durationMs ?? null,
      createdAt: toDate(entry.createdAt).toISOString(),
    };
  }

  async findByUserId(
    userId: string,
    options: FindOptions = {},
  ): Promise<AuditLog[]> {
    return this.findAll({
      ...options,
      where: { ...options.where, userId } as any,
    });
  }

  async findByAction(
    action: AuditAction,
    options: FindOptions = {},
  ): Promise<AuditLog[]> {
    return this.findAll({
      ...options,
      where: { ...options.where, action } as any,
    });
  }

  async findByDateRange(
    startDate: Date,
    endDate: Date,
    options: FindOptions = {},
  ): Promise<AuditLog[]> {
    const repo = this.repository;
    const query = repo.createQueryBuilder("log");
    query.andWhere("log.createdAt >= :startDate", { startDate });
    query.andWhere("log.createdAt <= :endDate", { endDate });
    if (options.where) {
      Object.entries(options.where).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          query.andWhere(`log.${key} = :${key}`, { [key]: value });
        }
      });
    }
    if (options.order) {
      Object.entries(options.order).forEach(([field, direction]) => {
        query.orderBy(`log.${field}`, direction);
      });
    }
    if (options.skip) query.skip(options.skip);
    if (options.take) query.take(options.take);
    if (options.relations?.length) {
      options.relations.forEach((relation) => {
        query.leftJoinAndSelect(`log.${relation}`, relation);
      });
    }
    return query.getMany();
  }

  async findByEntity(
    entityType: string,
    entityId: string,
    options: FindOptions = {},
  ): Promise<AuditLog[]> {
    return this.findAll({
      ...options,
      where: { ...options.where, entityType, entityId } as any,
    });
  }

  async findErrorLogs(options: FindOptions = {}): Promise<AuditLog[]> {
    return this.findAll({
      ...options,
      where: { ...options.where, level: LogLevel.ERROR } as any,
    });
  }

  async countByAction(action: AuditAction): Promise<number> {
    return this.count({ action } as any);
  }

  /**
   * Delete old logs. This is destructive and breaks the hash chain for any
   * subsequent entries. Callers must ensure an archival export has been
   * produced and retained before invoking this. The method is retained for
   * backward compatibility but is guarded to prevent accidental chain breaks.
   */
  async deleteOldLogs(cutoffDate: Date): Promise<number> {
    const repo = this.repository;
    const oldest = await repo.findOne({
      where: { createdAt: LessThan(cutoffDate) } as any,
      order: { sequence: "ASC" } as any,
    });
    if (!oldest) return 0;
    const newer = await repo.findOne({
      where: { sequence: MoreThan(oldest.sequence) } as any,
    });
    if (newer) {
      throw new Error(
        "Refusing to delete audit logs that would break the hash chain; archive and rotate instead.",
      );
    }
    const result = await repo
      .createQueryBuilder()
      .delete()
      .from(AuditLog)
      .where("createdAt < :cutoffDate", { cutoffDate })
      .execute();
    return result.affected ?? 0;
  }
}

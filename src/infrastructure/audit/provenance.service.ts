import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, Between, FindOptionsWhere, SelectQueryBuilder } from "typeorm";
import { ethers } from "ethers";
import { ConfigService } from "@nestjs/config";
import {
  ProvenanceRecord,
  ProvenanceStatus,
} from "./entities/provenance-record.entity";
import { CreateProvenanceRecordDto } from "./dto/create-provenance-record.dto";
import { QueryProvenanceDto } from "./dto/query-provenance.dto";
import {
  ProvenanceResponseDto,
  ProvenanceListResponseDto,
  ProvenanceVerificationResultDto,
  ProvenanceTimelineResponseDto,
} from "./dto/provenance-response.dto";

@Injectable()
export class ProvenanceService {
  private readonly logger = new Logger(ProvenanceService.name);
  private readonly signingKey: string;
  private static readonly EXPORT_BATCH_SIZE = 250;

  /** Deliberately excludes input/output, error, metadata, signature and recordHash. */
  private static readonly EXPORT_COLUMNS = [
    "id",
    "agentId",
    "userId",
    "action",
    "status",
    "provider",
    "providerModel",
    "createdAt",
    "onChainTxHash",
    "processingDurationMs",
  ] as const;

  constructor(
    @InjectRepository(ProvenanceRecord)
    private readonly provenanceRepository: Repository<ProvenanceRecord>,
    private readonly configService: ConfigService,
  ) {
    // Use a system signing key for provenance signatures
    // In production, this should be securely managed (e.g., AWS KMS, HashiCorp Vault)
    this.signingKey =
      this.configService.get<string>("PROVENANCE_SIGNING_KEY") ||
      "0x" + "1".repeat(64); // Fallback for development only
  }

  /**
   * Create a new provenance record with cryptographic signature
   */
  async createProvenanceRecord(
    dto: CreateProvenanceRecordDto,
  ): Promise<ProvenanceResponseDto> {
    // Generate hash of the record data
    const recordHash = this.hashRecordData(dto);

    // Generate cryptographic signature
    const signature = this.generateSignature(recordHash);

    // Create the provenance record
    const provenance = this.provenanceRepository.create({
      ...dto,
      recordHash,
      signature,
    });

    const saved = await this.provenanceRepository.save(provenance);
    this.logger.log(
      `Created provenance record ${saved.id} for agent ${saved.agentId}`,
    );

    return this.toResponseDto(saved);
  }

  /**
   * Get a provenance record by ID
   */
  async getProvenanceById(id: string): Promise<ProvenanceResponseDto> {
    const record = await this.provenanceRepository.findOne({
      where: { id },
      relations: ["user"],
    });

    if (!record) {
      throw new NotFoundException(`Provenance record ${id} not found`);
    }

    return this.toResponseDto(record);
  }

  /**
   * Query provenance records with filters and pagination
   */
  async queryProvenance(
    query: QueryProvenanceDto,
  ): Promise<ProvenanceListResponseDto> {
    const where: FindOptionsWhere<ProvenanceRecord> = {};

    if (query.agentId) {
      where.agentId = query.agentId;
    }

    if (query.userId) {
      where.userId = query.userId;
    }

    if (query.action) {
      where.action = query.action;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.provider) {
      where.provider = query.provider;
    }

    if (query.onChainTxHash) {
      where.onChainTxHash = query.onChainTxHash;
    }

    if (query.fromDate && query.toDate) {
      where.createdAt = Between(
        new Date(query.fromDate),
        new Date(query.toDate),
      );
    } else if (query.fromDate) {
      where.createdAt = Between(new Date(query.fromDate), new Date());
    } else if (query.toDate) {
      where.createdAt = Between(new Date(0), new Date(query.toDate));
    }

    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const [records, total] = await this.provenanceRepository.findAndCount({
      where,
      relations: ["user"],
      order: {
        [query.sortBy || "createdAt"]: query.sortOrder || "DESC",
      },
      skip,
      take: limit,
    });

    return {
      data: records.map((r) => this.toResponseDto(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get provenance records for a specific agent
   */
  async getProvenanceByAgentId(
    agentId: string,
    query: QueryProvenanceDto,
  ): Promise<ProvenanceListResponseDto> {
    return this.queryProvenance({ ...query, agentId });
  }

  /**
   * Get provenance records for a specific user
   */
  async getProvenanceByUserId(
    userId: string,
    query: QueryProvenanceDto,
  ): Promise<ProvenanceListResponseDto> {
    return this.queryProvenance({ ...query, userId });
  }

  /**
   * Get chronological timeline of provenance for an agent
   */
  async getProvenanceTimeline(
    agentId: string,
    fromDate?: string,
    toDate?: string,
  ): Promise<ProvenanceTimelineResponseDto> {
    const where: FindOptionsWhere<ProvenanceRecord> = { agentId };

    if (fromDate && toDate) {
      where.createdAt = Between(new Date(fromDate), new Date(toDate));
    }

    const records = await this.provenanceRepository.find({
      where,
      relations: ["user"],
      order: { createdAt: "ASC" },
    });

    const from =
      fromDate ||
      records[0]?.createdAt.toISOString() ||
      new Date(0).toISOString();
    const to = toDate || new Date().toISOString();

    return {
      agentId,
      timeline: records.map((r) => this.toResponseDto(r)),
      total: records.length,
      fromDate: from,
      toDate: to,
    };
  }

  /**
   * Export provenance records to JSON format
   */
  async exportProvenanceToJson(id: string): Promise<string> {
    const record = await this.getProvenanceById(id);
    return JSON.stringify(record, null, 2);
  }

  /**
   * Export multiple provenance records to CSV format
   */
  async exportProvenanceToCsv(query: QueryProvenanceDto): Promise<string> {
    const { data: records } = await this.queryProvenance({
      ...query,
      limit: 1000, // Max limit for CSV export
    });

    if (records.length === 0) {
      return `${ProvenanceService.EXPORT_COLUMNS.join(",")}\n`;
    }

    const headers = [...ProvenanceService.EXPORT_COLUMNS];

    const rows = records.map((r) => [
      r.id,
      r.agentId,
      r.userId || "",
      r.action,
      r.status,
      r.provider || "",
      r.providerModel || "",
      r.createdAt.toISOString(),
      r.onChainTxHash || "",
      r.processingDurationMs ?? "",
    ]);

    return [headers.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
  }

  async exportProvenanceRecordToCsv(id: string): Promise<string> {
    const record = await this.provenanceRepository.findOne({ where: { id } });
    if (!record) throw new NotFoundException(`Provenance record ${id} not found`);
    const values = [
      record.id,
      record.agentId,
      record.userId || "",
      record.action,
      record.status,
      record.provider || "",
      record.providerModel || "",
      record.createdAt.toISOString(),
      record.onChainTxHash || "",
      record.processingDurationMs ?? "",
    ];
    return `${ProvenanceService.EXPORT_COLUMNS.join(",")}\n${values.map(csvCell).join(",")}`;
  }

  /**
   * Stream an unbounded provenance CSV in keyset-paginated batches. Export
   * columns are an explicit allowlist so private payloads and signing material
   * cannot accidentally be exposed by adding entity fields later.
   */
  async *streamProvenanceCsv(
    query: QueryProvenanceDto,
    batchSize = ProvenanceService.EXPORT_BATCH_SIZE,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const size = Math.max(1, Math.min(batchSize, ProvenanceService.EXPORT_BATCH_SIZE));
    const columns = [...ProvenanceService.EXPORT_COLUMNS];
    yield `${columns.join(",")}\n`;

    let cursor: { createdAt: Date; id: string } | undefined;
    while (true) {
      if (signal?.aborted) return;
      const builder = this.buildExportQuery(query);
      if (cursor) {
        builder.andWhere(
          "(provenance.createdAt < :cursorCreatedAt OR (provenance.createdAt = :cursorCreatedAt AND provenance.id < :cursorId))",
          { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
        );
      }
      const records = await builder
        .orderBy("provenance.createdAt", "DESC")
        .addOrderBy("provenance.id", "DESC")
        .take(size)
        .getMany();

      if (signal?.aborted) return;
      if (records.length === 0) return;
      for (const record of records) {
        if (signal?.aborted) return;
        yield [
          record.id,
          record.agentId,
          record.userId || "",
          record.action,
          record.status,
          record.provider || "",
          record.providerModel || "",
          record.createdAt.toISOString(),
          record.onChainTxHash || "",
          record.processingDurationMs ?? "",
        ].map(csvCell).join(",") + "\n";
      }

      const last = records[records.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
      if (records.length < size) return;
    }
  }

  private buildExportQuery(
    query: QueryProvenanceDto,
  ): SelectQueryBuilder<ProvenanceRecord> {
    const builder = this.provenanceRepository
      .createQueryBuilder("provenance")
      .select(ProvenanceService.EXPORT_COLUMNS.map((column) => `provenance.${column}`));

    if (query.agentId) builder.andWhere("provenance.agentId = :agentId", { agentId: query.agentId });
    if (query.userId) builder.andWhere("provenance.userId = :userId", { userId: query.userId });
    if (query.action) builder.andWhere("provenance.action = :action", { action: query.action });
    if (query.status) builder.andWhere("provenance.status = :status", { status: query.status });
    if (query.provider) builder.andWhere("provenance.provider = :provider", { provider: query.provider });
    if (query.onChainTxHash) {
      builder.andWhere("provenance.onChainTxHash = :onChainTxHash", {
        onChainTxHash: query.onChainTxHash,
      });
    }
    if (query.fromDate) {
      builder.andWhere("provenance.createdAt >= :fromDate", { fromDate: new Date(query.fromDate) });
    }
    if (query.toDate) {
      builder.andWhere("provenance.createdAt <= :toDate", { toDate: new Date(query.toDate) });
    }
    return builder;
  }

  /**
   * Verify the cryptographic signature of a provenance record
   */
  async verifySignature(id: string): Promise<ProvenanceVerificationResultDto> {
    const record = await this.provenanceRepository.findOne({ where: { id } });

    if (!record) {
      return {
        isValid: false,
        recordId: id,
        recordHash: "",
        error: "Record not found",
      };
    }

    try {
      // Recreate the hash from stored data
      const dto: CreateProvenanceRecordDto = {
        agentId: record.agentId,
        userId: record.userId || undefined,
        action: record.action,
        input: record.input,
        output: record.output || undefined,
        provider: record.provider || undefined,
        providerModel: record.providerModel || undefined,
        status: record.status,
        error: record.error || undefined,
        onChainTxHash: record.onChainTxHash || undefined,
        processingDurationMs: record.processingDurationMs || undefined,
        metadata: record.metadata || undefined,
        clientIp: record.clientIp || undefined,
        userAgent: record.userAgent || undefined,
      };

      const computedHash = this.hashRecordData(dto);

      // Verify the hash matches
      if (computedHash !== record.recordHash) {
        return {
          isValid: false,
          recordId: id,
          recordHash: record.recordHash,
          error: "Record hash mismatch - data may have been tampered with",
        };
      }

      // Verify the signature
      const isValid = this.verifySignatureAgainstHash(
        record.recordHash,
        record.signature,
      );

      return {
        isValid,
        recordId: id,
        recordHash: record.recordHash,
        error: isValid ? undefined : "Invalid signature",
      };
    } catch (error) {
      return {
        isValid: false,
        recordId: id,
        recordHash: record.recordHash,
        error: `Verification error: ${error.message}`,
      };
    }
  }

  /**
   * Update an existing provenance record (only allows updating output, status, error, onChainTxHash)
   * This is used to complete a pending record after processing
   */
  async updateProvenanceRecord(
    id: string,
    updates: Partial<{
      output: Record<string, any>;
      status: ProvenanceStatus;
      error: string;
      onChainTxHash: string;
      processingDurationMs: number;
    }>,
  ): Promise<ProvenanceResponseDto> {
    const record = await this.provenanceRepository.findOne({ where: { id } });

    if (!record) {
      throw new NotFoundException(`Provenance record ${id} not found`);
    }

    // Only allow updating certain fields
    if (updates.output !== undefined) record.output = updates.output;
    if (updates.status !== undefined) record.status = updates.status;
    if (updates.error !== undefined) record.error = updates.error;
    if (updates.onChainTxHash !== undefined)
      record.onChainTxHash = updates.onChainTxHash;
    if (updates.processingDurationMs !== undefined)
      record.processingDurationMs = updates.processingDurationMs;

    const updated = await this.provenanceRepository.save(record);
    this.logger.log(`Updated provenance record ${id}`);

    return this.toResponseDto(updated);
  }

  /**
   * Generate a deterministic hash of record data
   */
  private hashRecordData(dto: CreateProvenanceRecordDto): string {
    const dataToHash = {
      agentId: dto.agentId,
      userId: dto.userId,
      action: dto.action,
      input: this.normalizeForHash(dto.input),
      provider: dto.provider,
      providerModel: dto.providerModel,
      status: dto.status,
      timestamp: Date.now(),
    };

    const sortedString = JSON.stringify(
      dataToHash,
      Object.keys(dataToHash).sort(),
    );
    return ethers.keccak256(ethers.toUtf8Bytes(sortedString));
  }

  /**
   * Generate cryptographic signature for a hash
   */
  private generateSignature(hash: string): string {
    try {
      const wallet = new ethers.Wallet(this.signingKey);
      return wallet.signMessageSync(hash);
    } catch (error) {
      this.logger.error("Failed to generate signature", error);
      // Return a placeholder signature for development
      return "0x" + "0".repeat(130);
    }
  }

  /**
   * Verify a signature against a hash
   */
  private verifySignatureAgainstHash(hash: string, signature: string): boolean {
    try {
      const recoveredAddress = ethers.verifyMessage(hash, signature);
      const wallet = new ethers.Wallet(this.signingKey);
      return recoveredAddress.toLowerCase() === wallet.address.toLowerCase();
    } catch (error) {
      return false;
    }
  }

  /**
   * Normalize data for consistent hashing
   */
  private normalizeForHash(data: any): any {
    if (data === null || typeof data !== "object") {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.normalizeForHash(item));
    }

    const normalized: any = {};
    const keys = Object.keys(data).sort();

    for (const key of keys) {
      // Skip non-deterministic fields
      if (!["timestamp", "createdAt", "updatedAt", "id"].includes(key)) {
        normalized[key] = this.normalizeForHash(data[key]);
      }
    }

    return normalized;
  }

  /**
   * Convert entity to response DTO
   */
  private toResponseDto(record: ProvenanceRecord): ProvenanceResponseDto {
    return {
      id: record.id,
      agentId: record.agentId,
      userId: record.userId || undefined,
      action: record.action,
      input: record.input,
      output: record.output || undefined,
      provider: record.provider || undefined,
      providerModel: record.providerModel || undefined,
      status: record.status,
      error: record.error || undefined,
      onChainTxHash: record.onChainTxHash || undefined,
      signature: record.signature,
      recordHash: record.recordHash,
      processingDurationMs: record.processingDurationMs || undefined,
      metadata: record.metadata || undefined,
      createdAt: record.createdAt,
      clientIp: record.clientIp || undefined,
      userAgent: record.userAgent || undefined,
    };
  }
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet formula execution in user-controlled text columns.
  if (typeof value === "string" && /^[\t\r ]*[=+@-]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

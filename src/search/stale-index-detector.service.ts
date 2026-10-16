import { Injectable, Logger, Optional } from "@nestjs/common";
import { ElasticsearchService } from "@nestjs/elasticsearch";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SearchRecord, SearchVisibility } from "./entities/search-record.entity";
import { SearchService } from "./search.service";
import {
  DiscrepancyItem,
  DiscrepancySeverity,
  DiscrepancyType,
  RepairActionType,
  RepairExecutionResult,
  RepairRecommendation,
  StaleAuditReport,
} from "./stale-detection.types";
import { randomUUID } from "crypto";

export interface ICacheNamespacePurger {
  invalidatePrefix(namespace: string): Promise<number>;
}

@Injectable()
export class StaleIndexDetectorService {
  private readonly logger = new Logger(StaleIndexDetectorService.name);
  private lastReport: StaleAuditReport | null = null;

  constructor(
    @InjectRepository(SearchRecord)
    private readonly recordsRepo: Repository<SearchRecord>,
    private readonly esService: ElasticsearchService,
    private readonly searchService: SearchService,
    @Optional() private readonly cachePurger?: ICacheNamespacePurger,
  ) {}

  /**
   * Performs an audit of the Elasticsearch search index against Postgres source-of-truth.
   */
  async auditSearchIndex(indexName = "posts"): Promise<StaleAuditReport> {
    this.logger.log(`Starting stale detection audit for index '${indexName}'...`);

    // 1. Fetch DB records (including soft-deleted)
    const dbRecords = await this.recordsRepo.find({ withDeleted: true });
    const dbActiveMap = new Map<string, SearchRecord>();
    const dbStaleMap = new Map<string, SearchRecord>();

    for (const record of dbRecords) {
      if (record.deletedAt || record.revokedAt) {
        dbStaleMap.set(record.id, record);
      } else {
        dbActiveMap.set(record.id, record);
      }
    }

    // 2. Fetch current Elasticsearch docs
    const esDocs = await this.fetchElasticsearchDocs(indexName);
    const esDocMap = new Map<string, any>();
    for (const doc of esDocs) {
      esDocMap.set(doc.id, doc);
    }

    const discrepancies: DiscrepancyItem[] = [];

    // Check active DB records vs ES
    for (const [id, dbRecord] of dbActiveMap.entries()) {
      const esDoc = esDocMap.get(id);
      if (!esDoc) {
        discrepancies.push({
          id,
          entityType: "SearchRecord",
          type: DiscrepancyType.MISSING_IN_INDEX,
          reason: `Record is active in database but missing from '${indexName}' index`,
          detectedAt: new Date(),
        });
      } else {
        // Compare content
        const titleMismatch = esDoc.title !== dbRecord.title;
        const contentMismatch = esDoc.content !== dbRecord.content;
        const visibilityMismatch = esDoc.visibility !== dbRecord.visibility;
        if (titleMismatch || contentMismatch || visibilityMismatch) {
          discrepancies.push({
            id,
            entityType: "SearchRecord",
            type: DiscrepancyType.CONTENT_MISMATCH,
            reason: `Content divergence detected: ${[
              titleMismatch ? "title" : null,
              contentMismatch ? "content" : null,
              visibilityMismatch ? "visibility" : null,
            ]
              .filter(Boolean)
              .join(", ")} mismatch`,
            detectedAt: new Date(),
          });
        }
      }
    }

    // Check ES docs that are either deleted/revoked or not in DB at all
    for (const [id, esDoc] of esDocMap.entries()) {
      if (dbStaleMap.has(id)) {
        const staleRecord = dbStaleMap.get(id)!;
        const reason = staleRecord.deletedAt ? "soft-deleted" : "revoked";
        discrepancies.push({
          id,
          entityType: "SearchRecord",
          type: DiscrepancyType.ZOMBIE_IN_INDEX,
          reason: `Record was ${reason} in database at ${
            staleRecord.deletedAt || staleRecord.revokedAt
          } but is still present in search index`,
          detectedAt: new Date(),
        });
      } else if (!dbActiveMap.has(id)) {
        discrepancies.push({
          id,
          entityType: "SearchRecord",
          type: DiscrepancyType.ZOMBIE_IN_INDEX,
          reason: `Orphaned index entry: document exists in search index but not found in database`,
          detectedAt: new Date(),
        });
      }
    }

    const totalDb = dbActiveMap.size;
    const discrepancyCount = discrepancies.length;
    const driftRatio = totalDb > 0 ? discrepancyCount / totalDb : discrepancyCount > 0 ? 1 : 0;

    const recommendations = this.generateRecommendations(
      `search:${indexName}`,
      totalDb,
      discrepancies,
      driftRatio,
    );

    const report: StaleAuditReport = {
      checkedAt: new Date(),
      targetScope: `search:${indexName}`,
      totalDbRecords: totalDb,
      totalIndexEntries: esDocs.length,
      discrepancyCount,
      driftRatio: Math.round(driftRatio * 1000) / 1000,
      discrepancies,
      recommendations,
    };

    this.lastReport = report;
    this.logger.log(
      `Audit completed for '${indexName}': ${discrepancyCount} discrepancies found across ${totalDb} active records (drift ${(
        driftRatio * 100
      ).toFixed(1)}%).`,
    );

    return report;
  }

  /**
   * Generates actionable repair recommendations based on drift metrics and discrepancy patterns.
   */
  generateRecommendations(
    targetScope: string,
    totalRecords: number,
    discrepancies: DiscrepancyItem[],
    driftRatio: number,
  ): RepairRecommendation[] {
    const recommendations: RepairRecommendation[] = [];
    if (discrepancies.length === 0) {
      return recommendations;
    }

    const missingItems = discrepancies.filter((d) => d.type === DiscrepancyType.MISSING_IN_INDEX);
    const zombieItems = discrepancies.filter((d) => d.type === DiscrepancyType.ZOMBIE_IN_INDEX);
    const mismatchItems = discrepancies.filter((d) => d.type === DiscrepancyType.CONTENT_MISMATCH);

    // Rule 1: Catastrophic or severe drift (> 25% or > 100 discrepancies) -> FULL_REINDEX
    if (driftRatio > 0.25 || discrepancies.length >= 100) {
      recommendations.push({
        id: randomUUID(),
        action: RepairActionType.FULL_REINDEX,
        severity: DiscrepancySeverity.CRITICAL,
        targetScope,
        affectedCount: discrepancies.length,
        description: `Severe drift (${(driftRatio * 100).toFixed(1)}%) detected across ${discrepancies.length} entries. High discrepancy volume warrants an atomic full re-index.`,
        automatedRepairPossible: true,
        estimatedImpact: "Moderate system load: rebuilds entire index from PostgreSQL source of truth.",
        suggestedCommand: `POST /search/repair/execute { action: "FULL_REINDEX" }`,
        targetIds: discrepancies.map((d) => d.id),
      });
      return recommendations;
    }

    // Rule 2: Moderate drift (between 8% and 25%) -> BATCH_REINDEX
    if (driftRatio > 0.08) {
      recommendations.push({
        id: randomUUID(),
        action: RepairActionType.BATCH_REINDEX,
        severity: DiscrepancySeverity.HIGH,
        targetScope,
        affectedCount: discrepancies.length,
        description: `Moderate drift (${(driftRatio * 100).toFixed(1)}%) detected. Batch re-index recommended for ${discrepancies.length} identified records.`,
        automatedRepairPossible: true,
        estimatedImpact: "Low-to-medium: selectively re-indexes affected batches.",
        suggestedCommand: `POST /search/repair/execute { action: "BATCH_REINDEX", targetIds: [...] }`,
        targetIds: discrepancies.map((d) => d.id),
      });
      return recommendations;
    }

    // Rule 3: Targeted / isolated discrepancies -> INLINE_PURGE and INLINE_SYNC
    if (zombieItems.length > 0) {
      recommendations.push({
        id: randomUUID(),
        action: RepairActionType.INLINE_PURGE,
        severity: DiscrepancySeverity.MEDIUM,
        targetScope,
        affectedCount: zombieItems.length,
        description: `Found ${zombieItems.length} zombie/revoked records persisting in search index. Purge needed to avoid stale visibility.`,
        automatedRepairPossible: true,
        estimatedImpact: "Minimal: targeted document deletion in Elasticsearch.",
        suggestedCommand: `POST /search/repair/execute { action: "INLINE_PURGE", targetIds: [${zombieItems.map((z) => `"${z.id}"`).join(", ")}] }`,
        targetIds: zombieItems.map((z) => z.id),
      });
    }

    const resyncTargets = [...missingItems, ...mismatchItems];
    if (resyncTargets.length > 0) {
      recommendations.push({
        id: randomUUID(),
        action: RepairActionType.INLINE_SYNC,
        severity: DiscrepancySeverity.LOW,
        targetScope,
        affectedCount: resyncTargets.length,
        description: `Found ${resyncTargets.length} records needing re-synchronization (${missingItems.length} missing, ${mismatchItems.length} divergent).`,
        automatedRepairPossible: true,
        estimatedImpact: "Minimal: inline document upsert from database.",
        suggestedCommand: `POST /search/repair/execute { action: "INLINE_SYNC", targetIds: [${resyncTargets.map((r) => `"${r.id}"`).join(", ")}] }`,
        targetIds: resyncTargets.map((r) => r.id),
      });
    }

    return recommendations;
  }

  /**
   * Executes a repair recommendation with dry-run support.
   */
  async executeRepair(
    recommendation: RepairRecommendation,
    options: { dryRun?: boolean } = {},
  ): Promise<RepairExecutionResult> {
    const dryRun = options.dryRun ?? false;
    this.logger.log(
      `Executing repair for recommendation ${recommendation.id} (${recommendation.action}, dryRun=${dryRun})...`,
    );

    if (dryRun) {
      return {
        recommendationId: recommendation.id,
        action: recommendation.action,
        dryRun: true,
        success: true,
        repairedCount: recommendation.affectedCount,
        message: `[DRY-RUN] Would execute ${recommendation.action} affecting ${recommendation.affectedCount} items in scope ${recommendation.targetScope}`,
      };
    }

    try {
      let repairedCount = 0;

      switch (recommendation.action) {
        case RepairActionType.FULL_REINDEX: {
          const result = await this.searchService.repairIndex();
          repairedCount = result.indexed + result.removed;
          break;
        }

        case RepairActionType.INLINE_PURGE: {
          const ids = recommendation.targetIds ?? [];
          for (const id of ids) {
            try {
              await this.esService.delete({ index: "posts", id });
              repairedCount++;
            } catch (err: any) {
              if (err?.statusCode !== 404) throw err;
            }
          }
          break;
        }

        case RepairActionType.INLINE_SYNC:
        case RepairActionType.BATCH_REINDEX: {
          const ids = recommendation.targetIds ?? [];
          if (ids.length > 0) {
            const records = await this.recordsRepo
              .createQueryBuilder("record")
              .where("record.id IN (:...ids)", { ids })
              .andWhere("record.deletedAt IS NULL")
              .andWhere("record.revokedAt IS NULL")
              .getMany();

            for (const record of records) {
              await this.esService.index({
                index: "posts",
                id: record.id,
                document: {
                  title: record.title,
                  content: record.content,
                  ownerId: record.ownerId,
                  visibility: record.visibility,
                  isActive: true,
                },
              });
              repairedCount++;
            }
          }
          break;
        }

        case RepairActionType.CACHE_PURGE_NAMESPACE: {
          if (this.cachePurger) {
            const purged = await this.cachePurger.invalidatePrefix(
              recommendation.targetScope.replace("cache:", ""),
            );
            repairedCount = purged;
          }
          break;
        }
      }

      return {
        recommendationId: recommendation.id,
        action: recommendation.action,
        dryRun: false,
        success: true,
        repairedCount,
        message: `Successfully executed ${recommendation.action} for ${repairedCount} items`,
      };
    } catch (error: any) {
      this.logger.error(`Repair execution failed: ${error.message}`, error.stack);
      return {
        recommendationId: recommendation.id,
        action: recommendation.action,
        dryRun: false,
        success: false,
        repairedCount: 0,
        message: `Repair failed: ${error.message}`,
        errors: [error.message],
      };
    }
  }

  getLastReport(): StaleAuditReport | null {
    return this.lastReport;
  }

  private async fetchElasticsearchDocs(index: string): Promise<any[]> {
    try {
      const response = await this.esService.search({
        index,
        query: { match_all: {} },
        size: 500,
      });
      return (response.hits.hits || []).map((hit: any) => ({
        id: hit._id,
        ...(hit._source as object),
      }));
    } catch (error: any) {
      if (
        error?.statusCode === 404 ||
        error?.meta?.body?.error?.type === "index_not_found_exception"
      ) {
        return [];
      }
      throw error;
    }
  }
}

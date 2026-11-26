import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import {
  RepairAdapter,
  RepairPage,
  RepairFinding,
} from "./repair-job";

export interface OrphanRecord {
  id: string;
  tableName: string;
  foreignKey: string;
  foreignKeyValue: string | null;
  referencedTable: string;
  referencedColumn: string;
  createdAt?: Date;
  updatedAt?: Date;
  metadata?: Record<string, any>;
}

export interface OrphanRepairConfig {
  /**
   * Tables to scan for orphaned foreign keys.
   * Format: { table: 'table_name', fk: 'foreign_key_column', references: 'parent_table' }
   */
  relationships: Array<{
    table: string;
    fk: string;
    references: string;
    referencedColumn?: string; // defaults to 'id'
  }>;
  
  /**
   * Repair strategy: 'set_null', 'delete', or 'custom'
   */
  strategy: "set_null" | "delete" | "custom";
  
  /**
   * Custom repair function (required if strategy is 'custom')
   */
  customRepair?: (record: OrphanRecord) => Promise<void>;
}

/**
 * Adapter for detecting and repairing orphaned database records.
 * 
 * An orphan is a record with a foreign key pointing to a non-existent parent.
 * This adapter:
 * - Scans configured tables for FK violations
 * - Detects orphans via LEFT JOIN + IS NULL pattern
 * - Repairs via SET NULL, DELETE, or custom strategy
 * - Journals before-images for rollback
 * 
 * Issue #266: Resumable orphan-repair command with checkpoints
 */
@Injectable()
export class OrphanRepairAdapter implements RepairAdapter<OrphanRecord> {
  private readonly logger = new Logger(OrphanRepairAdapter.name);
  private readonly config: OrphanRepairConfig;
  private currentRelationshipIndex = 0;
  private currentOffset = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: OrphanRepairConfig,
  ) {
    this.config = config;
  }

  /**
   * Scan for orphaned records across configured relationships.
   * Cursor format: "relationshipIndex:offset"
   */
  async scan(
    cursor: string | null,
    limit: number,
  ): Promise<RepairPage<OrphanRecord>> {
    // Parse cursor
    if (cursor) {
      const [relIdx, offset] = cursor.split(":").map(Number);
      this.currentRelationshipIndex = relIdx;
      this.currentOffset = offset;
    } else {
      this.currentRelationshipIndex = 0;
      this.currentOffset = 0;
    }

    // Check if we've scanned all relationships
    if (this.currentRelationshipIndex >= this.config.relationships.length) {
      return { records: [], nextCursor: null };
    }

    const rel = this.config.relationships[this.currentRelationshipIndex];
    const refCol = rel.referencedColumn || "id";

    // Query for orphans using LEFT JOIN pattern
    const query = `
      SELECT 
        child.id,
        child.${rel.fk} as foreign_key_value,
        child.created_at,
        child.updated_at
      FROM ${rel.table} child
      LEFT JOIN ${rel.references} parent 
        ON child.${rel.fk} = parent.${refCol}
      WHERE child.${rel.fk} IS NOT NULL
        AND parent.${refCol} IS NULL
      ORDER BY child.id
      LIMIT $1 OFFSET $2
    `;

    try {
      const rows = await this.dataSource.query(query, [limit, this.currentOffset]);

      const records: OrphanRecord[] = rows.map((row: any) => ({
        id: String(row.id),
        tableName: rel.table,
        foreignKey: rel.fk,
        foreignKeyValue: row.foreign_key_value,
        referencedTable: rel.references,
        referencedColumn: refCol,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: { relationshipIndex: this.currentRelationshipIndex },
      }));

      // Calculate next cursor
      let nextCursor: string | null = null;
      if (rows.length === limit) {
        // More records in current relationship
        nextCursor = `${this.currentRelationshipIndex}:${this.currentOffset + limit}`;
      } else if (this.currentRelationshipIndex < this.config.relationships.length - 1) {
        // Move to next relationship
        nextCursor = `${this.currentRelationshipIndex + 1}:0`;
      }

      this.logger.debug({
        relationship: `${rel.table}.${rel.fk} -> ${rel.references}`,
        found: records.length,
        cursor,
        nextCursor,
        message: "Orphan scan batch completed",
      });

      return { records, nextCursor };
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? error.message : String(error),
        relationship: `${rel.table}.${rel.fk} -> ${rel.references}`,
        message: "Orphan scan failed",
      });
      throw error;
    }
  }

  /**
   * Detect if record is an orphan (always true since scan only returns orphans).
   */
  detect(record: OrphanRecord): RepairFinding | null {
    return {
      recordId: `${record.tableName}:${record.id}`,
      kind: "orphaned",
      reason: `${record.tableName}.${record.foreignKey}=${record.foreignKeyValue} references non-existent ${record.referencedTable}.${record.referencedColumn}`,
    };
  }

  /**
   * Repair orphaned record according to configured strategy.
   * Returns before-image for rollback.
   */
  async repair(
    record: OrphanRecord,
    _finding: RepairFinding,
  ): Promise<unknown> {
    // Capture before-image
    const beforeQuery = `SELECT * FROM ${record.tableName} WHERE id = $1`;
    const before = await this.dataSource.query(beforeQuery, [record.id]);
    
    if (!before.length) {
      throw new Error(`Record ${record.tableName}:${record.id} not found`);
    }

    // Apply repair strategy
    switch (this.config.strategy) {
      case "set_null":
        await this.dataSource.query(
          `UPDATE ${record.tableName} SET ${record.foreignKey} = NULL WHERE id = $1`,
          [record.id],
        );
        this.logger.log({
          recordId: `${record.tableName}:${record.id}`,
          strategy: "set_null",
          foreignKey: record.foreignKey,
          message: "Orphan repaired - FK set to NULL",
        });
        break;

      case "delete":
        await this.dataSource.query(
          `DELETE FROM ${record.tableName} WHERE id = $1`,
          [record.id],
        );
        this.logger.log({
          recordId: `${record.tableName}:${record.id}`,
          strategy: "delete",
          message: "Orphan repaired - record deleted",
        });
        break;

      case "custom":
        if (!this.config.customRepair) {
          throw new Error("Custom repair strategy requires customRepair function");
        }
        await this.config.customRepair(record);
        this.logger.log({
          recordId: `${record.tableName}:${record.id}`,
          strategy: "custom",
          message: "Orphan repaired - custom strategy applied",
        });
        break;

      default:
        throw new Error(`Unknown repair strategy: ${this.config.strategy}`);
    }

    return {
      table: record.tableName,
      record: before[0],
      strategy: this.config.strategy,
    };
  }

  /**
   * Restore record from before-image (rollback).
   */
  async restore(recordId: string, before: unknown): Promise<void> {
    const beforeImage = before as {
      table: string;
      record: any;
      strategy: string;
    };

    if (beforeImage.strategy === "delete") {
      // Re-insert deleted record
      const columns = Object.keys(beforeImage.record);
      const values = columns.map((col) => beforeImage.record[col]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      
      const query = `
        INSERT INTO ${beforeImage.table} (${columns.join(", ")})
        VALUES (${placeholders})
      `;
      
      await this.dataSource.query(query, values);
      
      this.logger.log({
        recordId,
        strategy: "restore_deleted",
        message: "Rollback - record re-inserted",
      });
    } else {
      // Restore updated record
      const columns = Object.keys(beforeImage.record).filter((col) => col !== "id");
      const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(", ");
      const values = [beforeImage.record.id, ...columns.map((col) => beforeImage.record[col])];
      
      const query = `UPDATE ${beforeImage.table} SET ${setClause} WHERE id = $1`;
      
      await this.dataSource.query(query, values);
      
      this.logger.log({
        recordId,
        strategy: "restore_updated",
        message: "Rollback - record restored",
      });
    }
  }
}

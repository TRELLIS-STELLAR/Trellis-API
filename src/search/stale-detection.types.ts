export enum DiscrepancyType {
  MISSING_IN_INDEX = "MISSING_IN_INDEX",
  ZOMBIE_IN_INDEX = "ZOMBIE_IN_INDEX",
  CONTENT_MISMATCH = "CONTENT_MISMATCH",
  ORPHANED_CACHE_ENTRY = "ORPHANED_CACHE_ENTRY",
}

export enum DiscrepancySeverity {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

export enum RepairActionType {
  INLINE_SYNC = "INLINE_SYNC",
  INLINE_PURGE = "INLINE_PURGE",
  BATCH_REINDEX = "BATCH_REINDEX",
  FULL_REINDEX = "FULL_REINDEX",
  CACHE_PURGE_NAMESPACE = "CACHE_PURGE_NAMESPACE",
}

export interface DiscrepancyItem {
  id: string;
  type: DiscrepancyType;
  reason: string;
  entityType: string;
  dbVersion?: number | string;
  indexVersion?: number | string;
  detectedAt: Date;
}

export interface RepairRecommendation {
  id: string;
  action: RepairActionType;
  severity: DiscrepancySeverity;
  targetScope: string;
  affectedCount: number;
  description: string;
  automatedRepairPossible: boolean;
  estimatedImpact: string;
  suggestedCommand: string;
  targetIds?: string[];
}

export interface StaleAuditReport {
  checkedAt: Date;
  targetScope: string;
  totalDbRecords: number;
  totalIndexEntries: number;
  discrepancyCount: number;
  driftRatio: number; // discrepancyCount / totalDbRecords (0.0 to 1.0)
  discrepancies: DiscrepancyItem[];
  recommendations: RepairRecommendation[];
}

export interface RepairExecutionResult {
  recommendationId: string;
  action: RepairActionType;
  dryRun: boolean;
  success: boolean;
  repairedCount: number;
  message: string;
  errors?: string[];
}

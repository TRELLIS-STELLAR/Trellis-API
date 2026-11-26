/**
 * Schema migration compatibility matrix (#issue-2)
 *
 * Provides a comprehensive matrix for testing schema migration compatibility
 * across different database states, including normal upgrades, rollbacks,
 * partial failures, and authorization checks.
 */

import { VersionedMigrationNote } from "./migration-notes.types";

export type MigrationImpact = "non-breaking" | "breaking" | "data-destructive";
export type MigrationCategory =
  | "schema"
  | "data"
  | "index"
  | "constraint"
  | "procedure"
  | "security";

export interface MigrationMatrixEntry {
  /** Migration identifier */
  id: string;
  /** Numeric timestamp */
  timestamp: number;
  /** Human-readable description */
  description: string;
  /** Impact level */
  impact: MigrationImpact;
  /** Migration category */
  category: MigrationCategory;
  /** Can be automatically rolled back */
  reversible: boolean;
  /** Dependencies (other migration IDs) */
  dependencies: string[];
  /** Incompatible with (migration IDs that conflict) */
  incompatibleWith: string[];
  /** Estimated execution time in milliseconds */
  estimatedDuration: number;
  /** Requires downtime */
  requiresDowntime: boolean;
  /** Minimum required role */
  requiredRole?: "admin" | "operator" | "migrator";
  /** Special notes or warnings */
  warnings?: string[];
}

export interface CompatibilityPath {
  /** Starting schema version */
  from: string | null;
  /** Target schema version */
  to: string;
  /** Migration sequence to apply */
  path: string[];
  /** Total estimated duration */
  estimatedDuration: number;
  /** Whether this path has breaking changes */
  hasBreakingChanges: boolean;
  /** Whether entire path is reversible */
  isReversible: boolean;
  /** Maximum downtime required */
  requiresDowntime: boolean;
}

export interface MigrationCompatibilityMatrix {
  /** All known migrations */
  migrations: Record<string, MigrationMatrixEntry>;
  /** Valid upgrade paths */
  upgradePaths: CompatibilityPath[];
  /** Valid rollback paths */
  rollbackPaths: CompatibilityPath[];
  /** Known incompatibilities */
  incompatibilities: Array<{
    migrations: string[];
    reason: string;
  }>;
}

/**
 * Comprehensive migration matrix with realistic scenarios
 */
export const SCHEMA_MIGRATION_MATRIX: MigrationCompatibilityMatrix = {
  migrations: {
    "1787313600000-create-module-registry": {
      id: "1787313600000-create-module-registry",
      timestamp: 1787313600000,
      description: "Create module registry tables for pluggable modules",
      impact: "non-breaking",
      category: "schema",
      reversible: true,
      dependencies: [],
      incompatibleWith: [],
      estimatedDuration: 500,
      requiresDowntime: false,
    },
    "1787400000000-add-asset-search-indexes": {
      id: "1787400000000-add-asset-search-indexes",
      timestamp: 1787400000000,
      description: "Add trigram indexes for asset search optimization",
      impact: "non-breaking",
      category: "index",
      reversible: true,
      dependencies: ["1787313600000-create-module-registry"],
      incompatibleWith: [],
      estimatedDuration: 3000,
      requiresDowntime: false,
      warnings: ["Large tables may take longer to index"],
    },
    "1787600000000-add-refresh-token-family": {
      id: "1787600000000-add-refresh-token-family",
      timestamp: 1787600000000,
      description: "Add refresh token family for enhanced security",
      impact: "breaking",
      category: "schema",
      reversible: false,
      dependencies: ["1787313600000-create-module-registry"],
      incompatibleWith: [],
      estimatedDuration: 1000,
      requiresDowntime: true,
      requiredRole: "admin",
      warnings: ["Existing refresh tokens will be invalidated"],
    },
    "1790467200000-create-payment-operations": {
      id: "1790467200000-create-payment-operations",
      timestamp: 1790467200000,
      description: "Create payment operations audit trail",
      impact: "non-breaking",
      category: "schema",
      reversible: true,
      dependencies: ["1787600000000-add-refresh-token-family"],
      incompatibleWith: [],
      estimatedDuration: 800,
      requiresDowntime: false,
    },
    "1790553600000-create-sensitive-action-chain": {
      id: "1790553600000-create-sensitive-action-chain",
      timestamp: 1790553600000,
      description: "Create sensitive action authorization chain",
      impact: "non-breaking",
      category: "security",
      reversible: true,
      dependencies: ["1790467200000-create-payment-operations"],
      incompatibleWith: [],
      estimatedDuration: 600,
      requiresDowntime: false,
      requiredRole: "admin",
    },
    "1790630400000-target-allocation-versions": {
      id: "1790630400000-target-allocation-versions",
      timestamp: 1790630400000,
      description: "Add versioning to target allocation snapshots",
      impact: "non-breaking",
      category: "schema",
      reversible: true,
      dependencies: ["1790553600000-create-sensitive-action-chain"],
      incompatibleWith: [],
      estimatedDuration: 1200,
      requiresDowntime: false,
    },
    "1790630401000-oracle-submission-history": {
      id: "1790630401000-oracle-submission-history",
      timestamp: 1790630401000,
      description: "Create oracle submission history with provenance",
      impact: "non-breaking",
      category: "schema",
      reversible: true,
      dependencies: ["1790630400000-target-allocation-versions"],
      incompatibleWith: [],
      estimatedDuration: 900,
      requiresDowntime: false,
    },
    "1791072000000-add-inbound-webhook-replay": {
      id: "1791072000000-add-inbound-webhook-replay",
      timestamp: 1791072000000,
      description: "Add webhook replay capability with deduplication",
      impact: "non-breaking",
      category: "schema",
      reversible: true,
      dependencies: ["1790630401000-oracle-submission-history"],
      incompatibleWith: [],
      estimatedDuration: 700,
      requiresDowntime: false,
    },
    "1792339200000-create-approval-intents": {
      id: "1792339200000-create-approval-intents",
      timestamp: 1792339200000,
      description: "Create approval intent workflow tables",
      impact: "breaking",
      category: "schema",
      reversible: false,
      dependencies: ["1791072000000-add-inbound-webhook-replay"],
      incompatibleWith: [],
      estimatedDuration: 1500,
      requiresDowntime: true,
      requiredRole: "admin",
      warnings: ["Requires application restart after migration"],
    },
    "1792342800000-add-approval-intent-receipts": {
      id: "1792342800000-add-approval-intent-receipts",
      timestamp: 1792342800000,
      description: "Add cryptographic receipt documents to approval intents",
      impact: "non-breaking",
      category: "data",
      reversible: true,
      dependencies: ["1792339200000-create-approval-intents"],
      incompatibleWith: [],
      estimatedDuration: 400,
      requiresDowntime: false,
    },
    "1792500000000-data-retention-policies": {
      id: "1792500000000-data-retention-policies",
      timestamp: 1792500000000,
      description: "Implement data retention and archival policies",
      impact: "data-destructive",
      category: "data",
      reversible: false,
      dependencies: ["1792342800000-add-approval-intent-receipts"],
      incompatibleWith: [],
      estimatedDuration: 10000,
      requiresDowntime: true,
      requiredRole: "admin",
      warnings: [
        "Will archive old data based on retention policies",
        "Backup database before running",
      ],
    },
  },
  upgradePaths: [
    {
      from: null,
      to: "1787313600000-create-module-registry",
      path: ["1787313600000-create-module-registry"],
      estimatedDuration: 500,
      hasBreakingChanges: false,
      isReversible: true,
      requiresDowntime: false,
    },
    {
      from: "1787313600000-create-module-registry",
      to: "1787600000000-add-refresh-token-family",
      path: [
        "1787400000000-add-asset-search-indexes",
        "1787600000000-add-refresh-token-family",
      ],
      estimatedDuration: 4000,
      hasBreakingChanges: true,
      isReversible: false,
      requiresDowntime: true,
    },
    {
      from: "1787600000000-add-refresh-token-family",
      to: "1790630401000-oracle-submission-history",
      path: [
        "1790467200000-create-payment-operations",
        "1790553600000-create-sensitive-action-chain",
        "1790630400000-target-allocation-versions",
        "1790630401000-oracle-submission-history",
      ],
      estimatedDuration: 3500,
      hasBreakingChanges: false,
      isReversible: true,
      requiresDowntime: false,
    },
    {
      from: "1790630401000-oracle-submission-history",
      to: "1792342800000-add-approval-intent-receipts",
      path: [
        "1791072000000-add-inbound-webhook-replay",
        "1792339200000-create-approval-intents",
        "1792342800000-add-approval-intent-receipts",
      ],
      estimatedDuration: 2600,
      hasBreakingChanges: true,
      isReversible: false,
      requiresDowntime: true,
    },
    {
      from: null,
      to: "1792342800000-add-approval-intent-receipts",
      path: [
        "1787313600000-create-module-registry",
        "1787400000000-add-asset-search-indexes",
        "1787600000000-add-refresh-token-family",
        "1790467200000-create-payment-operations",
        "1790553600000-create-sensitive-action-chain",
        "1790630400000-target-allocation-versions",
        "1790630401000-oracle-submission-history",
        "1791072000000-add-inbound-webhook-replay",
        "1792339200000-create-approval-intents",
        "1792342800000-add-approval-intent-receipts",
      ],
      estimatedDuration: 10600,
      hasBreakingChanges: true,
      isReversible: false,
      requiresDowntime: true,
    },
  ],
  rollbackPaths: [
    {
      from: "1787400000000-add-asset-search-indexes",
      to: "1787313600000-create-module-registry",
      path: ["1787400000000-add-asset-search-indexes"],
      estimatedDuration: 1000,
      hasBreakingChanges: false,
      isReversible: true,
      requiresDowntime: false,
    },
    {
      from: "1790630401000-oracle-submission-history",
      to: "1790467200000-create-payment-operations",
      path: [
        "1790630401000-oracle-submission-history",
        "1790630400000-target-allocation-versions",
        "1790553600000-create-sensitive-action-chain",
      ],
      estimatedDuration: 2700,
      hasBreakingChanges: false,
      isReversible: true,
      requiresDowntime: false,
    },
  ],
  incompatibilities: [
    {
      migrations: [
        "1787600000000-add-refresh-token-family",
        "1792339200000-create-approval-intents",
      ],
      reason: "Cannot rollback breaking changes without data loss",
    },
    {
      migrations: ["1792500000000-data-retention-policies"],
      reason: "Data-destructive migration cannot be reversed",
    },
  ],
};

/**
 * Find the optimal migration path between two versions
 */
export function findMigrationPath(
  matrix: MigrationCompatibilityMatrix,
  from: string | null,
  to: string,
): CompatibilityPath | null {
  // Try direct path first
  const directPath = matrix.upgradePaths.find(
    (path) => path.from === from && path.to === to,
  );
  if (directPath) return directPath;

  // For complex scenarios, build path from migration chain
  const migrations = Object.values(matrix.migrations).sort(
    (a, b) => a.timestamp - b.timestamp,
  );

  const fromIndex =
    from === null ? -1 : migrations.findIndex((m) => m.id === from);
  const toIndex = migrations.findIndex((m) => m.id === to);

  if (fromIndex === -1 && from !== null) return null;
  if (toIndex === -1) return null;
  if (fromIndex >= toIndex) return null;

  const path = migrations.slice(fromIndex + 1, toIndex + 1).map((m) => m.id);
  const pathMigrations = path.map((id) => matrix.migrations[id]);

  return {
    from,
    to,
    path,
    estimatedDuration: pathMigrations.reduce(
      (sum, m) => sum + m.estimatedDuration,
      0,
    ),
    hasBreakingChanges: pathMigrations.some((m) => m.impact === "breaking"),
    isReversible: pathMigrations.every((m) => m.reversible),
    requiresDowntime: pathMigrations.some((m) => m.requiresDowntime),
  };
}

/**
 * Validate migration dependencies are satisfied
 */
export function validateMigrationDependencies(
  matrix: MigrationCompatibilityMatrix,
  migrationId: string,
  appliedMigrations: string[],
): { valid: boolean; missing: string[] } {
  const migration = matrix.migrations[migrationId];
  if (!migration) {
    return { valid: false, missing: [] };
  }

  const appliedSet = new Set(appliedMigrations);
  const missing = migration.dependencies.filter((dep) => !appliedSet.has(dep));

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Check for incompatibilities in a migration sequence
 */
export function checkMigrationIncompatibilities(
  matrix: MigrationCompatibilityMatrix,
  migrationIds: string[],
): Array<{ migrations: string[]; reason: string }> {
  const issues: Array<{ migrations: string[]; reason: string }> = [];
  const migrationSet = new Set(migrationIds);

  // Check known incompatibilities
  for (const incompatibility of matrix.incompatibilities) {
    const conflicting = incompatibility.migrations.filter((id) =>
      migrationSet.has(id),
    );
    if (conflicting.length > 1) {
      issues.push({
        migrations: conflicting,
        reason: incompatibility.reason,
      });
    }
  }

  // Check individual migration incompatibilities
  for (const migrationId of migrationIds) {
    const migration = matrix.migrations[migrationId];
    if (!migration) continue;

    const conflicts = migration.incompatibleWith.filter((id) =>
      migrationSet.has(id),
    );
    if (conflicts.length > 0) {
      issues.push({
        migrations: [migrationId, ...conflicts],
        reason: `Migration ${migrationId} is incompatible with ${conflicts.join(", ")}`,
      });
    }
  }

  return issues;
}

/**
 * Estimate total migration duration for a path
 */
export function estimateMigrationDuration(
  matrix: MigrationCompatibilityMatrix,
  migrationIds: string[],
): {
  totalDuration: number;
  byCategory: Record<MigrationCategory, number>;
  requiresDowntime: boolean;
} {
  const byCategory: Record<MigrationCategory, number> = {
    schema: 0,
    data: 0,
    index: 0,
    constraint: 0,
    procedure: 0,
    security: 0,
  };

  let totalDuration = 0;
  let requiresDowntime = false;

  for (const migrationId of migrationIds) {
    const migration = matrix.migrations[migrationId];
    if (!migration) continue;

    totalDuration += migration.estimatedDuration;
    byCategory[migration.category] += migration.estimatedDuration;

    if (migration.requiresDowntime) {
      requiresDowntime = true;
    }
  }

  return { totalDuration, byCategory, requiresDowntime };
}

/**
 * Generate migration notes for a compatibility report
 */
export function generateMigrationNotes(
  matrix: MigrationCompatibilityMatrix,
  migrationIds: string[],
): Record<string, VersionedMigrationNote> {
  const notes: Record<string, VersionedMigrationNote> = {};

  for (const migrationId of migrationIds) {
    const migration = matrix.migrations[migrationId];
    if (!migration) continue;

    notes[migrationId] = {
      version: migrationId,
      impact: migration.impact as "non-breaking" | "breaking",
      description: migration.description,
      reversible: migration.reversible,
      estimatedDuration: `${migration.estimatedDuration}ms`,
      warnings: migration.warnings,
      requiredRole: migration.requiredRole,
    };
  }

  return notes;
}

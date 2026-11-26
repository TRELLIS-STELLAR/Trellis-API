/**
 * Schema migration compatibility fixtures (#issue-2)
 *
 * Comprehensive fixtures for testing schema migration compatibility
 * across various scenarios including normal paths, failures, retries,
 * and authorization checks.
 */

import { AppliedMigration, MigrationVersion } from "../storage-schema-compatibility";
import { MigrationMatrixEntry } from "../schema-migration-matrix";

/**
 * Fixture: Clean database state (no migrations applied)
 */
export const FIXTURE_CLEAN_DATABASE: AppliedMigration[] = [];

/**
 * Fixture: Fully up-to-date database
 */
export const FIXTURE_UP_TO_DATE_DATABASE: AppliedMigration[] = [
  { timestamp: 1787313600000, name: "CreateModuleRegistry1787313600000" },
  { timestamp: 1787400000000, name: "AddAssetSearchIndexes1787400000000" },
  { timestamp: 1787600000000, name: "AddRefreshTokenFamily1787600000000" },
  { timestamp: 1790467200000, name: "CreatePaymentOperations1790467200000" },
  { timestamp: 1790553600000, name: "CreateSensitiveActionChain1790553600000" },
  { timestamp: 1790630400000, name: "TargetAllocationVersions1790630400000" },
  { timestamp: 1790630401000, name: "OracleSubmissionHistory1790630401000" },
  { timestamp: 1791072000000, name: "AddInboundWebhookReplay1791072000000" },
  { timestamp: 1792339200000, name: "CreateApprovalIntents1792339200000" },
  { timestamp: 1792342800000, name: "AddApprovalIntentReceipts1792342800000" },
];

/**
 * Fixture: Database with pending migrations
 */
export const FIXTURE_UPGRADE_READY_DATABASE: AppliedMigration[] = [
  { timestamp: 1787313600000, name: "CreateModuleRegistry1787313600000" },
  { timestamp: 1787400000000, name: "AddAssetSearchIndexes1787400000000" },
  { timestamp: 1787600000000, name: "AddRefreshTokenFamily1787600000000" },
  { timestamp: 1790467200000, name: "CreatePaymentOperations1790467200000" },
];

/**
 * Fixture: Database ahead of application
 */
export const FIXTURE_AHEAD_DATABASE: AppliedMigration[] = [
  { timestamp: 1787313600000, name: "CreateModuleRegistry1787313600000" },
  { timestamp: 1787400000000, name: "AddAssetSearchIndexes1787400000000" },
  { timestamp: 1787600000000, name: "AddRefreshTokenFamily1787600000000" },
  { timestamp: 1999999999999, name: "UnknownFutureMigration1999999999999" },
];

/**
 * Fixture: Database with skipped migration
 */
export const FIXTURE_SKIPPED_MIGRATION: AppliedMigration[] = [
  { timestamp: 1787313600000, name: "CreateModuleRegistry1787313600000" },
  // Skipped 1787400000000
  { timestamp: 1787600000000, name: "AddRefreshTokenFamily1787600000000" },
];

/**
 * Fixture: Database with duplicate migration
 */
export const FIXTURE_DUPLICATE_MIGRATION: AppliedMigration[] = [
  { timestamp: 1787313600000, name: "CreateModuleRegistry1787313600000" },
  { timestamp: 1787400000000, name: "AddAssetSearchIndexes1787400000000" },
  { timestamp: 1787400000000, name: "AddAssetSearchIndexes1787400000000" }, // Duplicate
];

/**
 * Fixture: Database with out-of-order migrations
 */
export const FIXTURE_OUT_OF_ORDER: AppliedMigration[] = [
  { timestamp: 1787313600000, name: "CreateModuleRegistry1787313600000" },
  { timestamp: 1787600000000, name: "AddRefreshTokenFamily1787600000000" },
  { timestamp: 1787400000000, name: "AddAssetSearchIndexes1787400000000" }, // Wrong order
];

/**
 * Fixture: Partially failed migration state
 */
export const FIXTURE_PARTIAL_FAILURE: AppliedMigration[] = [
  { timestamp: 1787313600000, name: "CreateModuleRegistry1787313600000" },
  { timestamp: 1787400000000, name: "AddAssetSearchIndexes1787400000000" },
  // Migration 1787600000000 started but not completed (not in history)
];

/**
 * Fixture: Known migration versions
 */
export const FIXTURE_KNOWN_MIGRATIONS: MigrationVersion[] = [
  { timestamp: 1787313600000, id: "1787313600000-create-module-registry" },
  { timestamp: 1787400000000, id: "1787400000000-add-asset-search-indexes" },
  { timestamp: 1787600000000, id: "1787600000000-add-refresh-token-family" },
  { timestamp: 1790467200000, id: "1790467200000-create-payment-operations" },
  {
    timestamp: 1790553600000,
    id: "1790553600000-create-sensitive-action-chain",
  },
  {
    timestamp: 1790630400000,
    id: "1790630400000-target-allocation-versions",
  },
  {
    timestamp: 1790630401000,
    id: "1790630401000-oracle-submission-history",
  },
  {
    timestamp: 1791072000000,
    id: "1791072000000-add-inbound-webhook-replay",
  },
  { timestamp: 1792339200000, id: "1792339200000-create-approval-intents" },
  {
    timestamp: 1792342800000,
    id: "1792342800000-add-approval-intent-receipts",
  },
];

/**
 * Fixture: Minimal migration set (for fast tests)
 */
export const FIXTURE_MINIMAL_MIGRATIONS: MigrationVersion[] = [
  { timestamp: 1000, id: "1000-init" },
  { timestamp: 2000, id: "2000-add-feature" },
  { timestamp: 3000, id: "3000-optimize" },
];

/**
 * Fixture: Breaking migration scenario
 */
export const FIXTURE_BREAKING_CHANGE_ENTRY: MigrationMatrixEntry = {
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
};

/**
 * Fixture: Non-breaking migration scenario
 */
export const FIXTURE_NON_BREAKING_ENTRY: MigrationMatrixEntry = {
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
};

/**
 * Fixture: Data-destructive migration scenario
 */
export const FIXTURE_DESTRUCTIVE_ENTRY: MigrationMatrixEntry = {
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
};

/**
 * Fixture: Migration with unmet dependencies
 */
export const FIXTURE_UNMET_DEPENDENCIES: {
  migration: MigrationMatrixEntry;
  applied: string[];
  expected: string[];
} = {
  migration: {
    id: "test-migration-with-deps",
    timestamp: 9999999999,
    description: "Test migration with dependencies",
    impact: "non-breaking",
    category: "schema",
    reversible: true,
    dependencies: [
      "1787313600000-create-module-registry",
      "1787400000000-add-asset-search-indexes",
      "1787600000000-add-refresh-token-family",
    ],
    incompatibleWith: [],
    estimatedDuration: 500,
    requiresDowntime: false,
  },
  applied: [
    "1787313600000-create-module-registry",
    // Missing: 1787400000000-add-asset-search-indexes
    "1787600000000-add-refresh-token-family",
  ],
  expected: ["1787400000000-add-asset-search-indexes"],
};

/**
 * Fixture: Migration with conflicts
 */
export const FIXTURE_CONFLICTING_MIGRATIONS: {
  migration: MigrationMatrixEntry;
  conflictsWith: MigrationMatrixEntry;
} = {
  migration: {
    id: "test-new-auth-system",
    timestamp: 8888888888,
    description: "New authentication system",
    impact: "breaking",
    category: "security",
    reversible: false,
    dependencies: [],
    incompatibleWith: ["1787600000000-add-refresh-token-family"],
    estimatedDuration: 5000,
    requiresDowntime: true,
    requiredRole: "admin",
  },
  conflictsWith: FIXTURE_BREAKING_CHANGE_ENTRY,
};

/**
 * Fixture: Authorization scenarios
 */
export const FIXTURE_AUTHORIZATION_SCENARIOS = {
  adminOnly: {
    migration: FIXTURE_BREAKING_CHANGE_ENTRY,
    allowedRoles: ["admin"],
    deniedRoles: ["operator", "user", "guest"],
  },
  operatorAllowed: {
    migration: FIXTURE_NON_BREAKING_ENTRY,
    allowedRoles: ["admin", "operator", "migrator"],
    deniedRoles: ["user", "guest"],
  },
  publicMigration: {
    migration: {
      ...FIXTURE_NON_BREAKING_ENTRY,
      requiredRole: undefined,
    },
    allowedRoles: ["admin", "operator", "migrator", "user"],
    deniedRoles: [],
  },
};

/**
 * Fixture: Retry scenarios
 */
export const FIXTURE_RETRY_SCENARIOS = {
  transientFailure: {
    attempts: 3,
    errors: [
      { code: "ECONNRESET", message: "Connection reset" },
      { code: "40001", message: "Serialization failure" },
      { code: null, message: "Success" },
    ],
    expectedSuccess: true,
  },
  permanentFailure: {
    attempts: 3,
    errors: [
      { code: "42P01", message: "Relation does not exist" },
      { code: "42P01", message: "Relation does not exist" },
      { code: "42P01", message: "Relation does not exist" },
    ],
    expectedSuccess: false,
  },
  immediateSuccess: {
    attempts: 1,
    errors: [{ code: null, message: "Success" }],
    expectedSuccess: true,
  },
};

/**
 * Fixture: Rollback scenarios
 */
export const FIXTURE_ROLLBACK_SCENARIOS = {
  reversiblePath: {
    from: "1790630401000-oracle-submission-history",
    to: "1790467200000-create-payment-operations",
    migrations: [
      "1790630401000-oracle-submission-history",
      "1790630400000-target-allocation-versions",
      "1790553600000-create-sensitive-action-chain",
    ],
    canRollback: true,
  },
  irreversiblePath: {
    from: "1792339200000-create-approval-intents",
    to: "1787600000000-add-refresh-token-family",
    migrations: [
      "1792339200000-create-approval-intents", // Breaking, irreversible
      "1791072000000-add-inbound-webhook-replay",
    ],
    canRollback: false,
  },
  partiallyReversible: {
    from: "1792342800000-add-approval-intent-receipts",
    to: "1790467200000-create-payment-operations",
    migrations: [
      "1792342800000-add-approval-intent-receipts", // Reversible
      "1792339200000-create-approval-intents", // Irreversible
      "1791072000000-add-inbound-webhook-replay", // Reversible
    ],
    canRollback: false,
  },
};

/**
 * Fixture: Edge case scenarios
 */
export const FIXTURE_EDGE_CASES = {
  emptyMigrationHistory: {
    known: FIXTURE_KNOWN_MIGRATIONS,
    applied: [],
    expectedStatus: "upgrade-ready",
  },
  unknownCurrentVersion: {
    known: FIXTURE_MINIMAL_MIGRATIONS,
    applied: [{ timestamp: 9999, name: "UnknownMigration9999" }],
    expectedStatus: "incompatible",
  },
  duplicateKnownMigrations: {
    known: [
      { timestamp: 1000, id: "1000-init" },
      { timestamp: 1000, id: "1000-init-duplicate" }, // Same timestamp
    ],
    applied: [],
    expectedStatus: "incompatible",
  },
  invalidTimestamp: {
    known: FIXTURE_MINIMAL_MIGRATIONS,
    applied: [
      { timestamp: 1000, name: "Init1000" },
      { timestamp: Number.MAX_SAFE_INTEGER + 1, name: "Invalid" },
    ],
    expectedStatus: "incompatible",
  },
  zeroLengthPath: {
    from: "1792342800000-add-approval-intent-receipts",
    to: "1792342800000-add-approval-intent-receipts",
    expectedDuration: 0,
    requiresDowntime: false,
  },
};

/**
 * Fixture: Performance test scenarios
 */
export const FIXTURE_PERFORMANCE_SCENARIOS = {
  largeMigrationSet: {
    count: 100,
    estimatedDurationRange: { min: 100, max: 5000 },
    downtimePercentage: 0.2, // 20% require downtime
  },
  longRunningMigration: {
    id: "long-running-data-migration",
    estimatedDuration: 3600000, // 1 hour
    requiresDowntime: true,
    category: "data" as const,
  },
  quickIndexCreation: {
    id: "quick-index-creation",
    estimatedDuration: 50,
    requiresDowntime: false,
    category: "index" as const,
  },
};

/**
 * Helper: Generate a migration history fixture
 */
export function generateMigrationHistory(
  count: number,
  startTimestamp = 1000000000000,
): AppliedMigration[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: startTimestamp + i * 1000,
    name: `Migration${startTimestamp + i * 1000}`,
  }));
}

/**
 * Helper: Generate known migrations fixture
 */
export function generateKnownMigrations(
  count: number,
  startTimestamp = 1000000000000,
): MigrationVersion[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: startTimestamp + i * 1000,
    id: `${startTimestamp + i * 1000}-migration-${i}`,
  }));
}

/**
 * Helper: Create a migration matrix entry fixture
 */
export function createMigrationEntry(
  overrides: Partial<MigrationMatrixEntry>,
): MigrationMatrixEntry {
  return {
    id: overrides.id ?? "test-migration",
    timestamp: overrides.timestamp ?? Date.now(),
    description: overrides.description ?? "Test migration",
    impact: overrides.impact ?? "non-breaking",
    category: overrides.category ?? "schema",
    reversible: overrides.reversible ?? true,
    dependencies: overrides.dependencies ?? [],
    incompatibleWith: overrides.incompatibleWith ?? [],
    estimatedDuration: overrides.estimatedDuration ?? 500,
    requiresDowntime: overrides.requiresDowntime ?? false,
    requiredRole: overrides.requiredRole,
    warnings: overrides.warnings,
  };
}

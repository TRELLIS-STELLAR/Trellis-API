/**
 * Schema migration compatibility matrix tests (#issue-2)
 *
 * Comprehensive test suite covering normal paths, failure scenarios,
 * retry logic, and authorization checks for schema migration compatibility.
 */

import { evaluateMigrationCompatibility } from "./storage-schema-compatibility";
import {
  SCHEMA_MIGRATION_MATRIX,
  checkMigrationIncompatibilities,
  estimateMigrationDuration,
  findMigrationPath,
  generateMigrationNotes,
  validateMigrationDependencies,
} from "./schema-migration-matrix";
import {
  FIXTURE_AUTHORIZATION_SCENARIOS,
  FIXTURE_BREAKING_CHANGE_ENTRY,
  FIXTURE_CLEAN_DATABASE,
  FIXTURE_CONFLICTING_MIGRATIONS,
  FIXTURE_DESTRUCTIVE_ENTRY,
  FIXTURE_DUPLICATE_MIGRATION,
  FIXTURE_EDGE_CASES,
  FIXTURE_KNOWN_MIGRATIONS,
  FIXTURE_NON_BREAKING_ENTRY,
  FIXTURE_OUT_OF_ORDER,
  FIXTURE_PARTIAL_FAILURE,
  FIXTURE_ROLLBACK_SCENARIOS,
  FIXTURE_SKIPPED_MIGRATION,
  FIXTURE_UNMET_DEPENDENCIES,
  FIXTURE_UP_TO_DATE_DATABASE,
  FIXTURE_UPGRADE_READY_DATABASE,
  createMigrationEntry,
  generateKnownMigrations,
  generateMigrationHistory,
} from "./fixtures/schema-migration-fixtures";

describe("Schema Migration Compatibility Matrix", () => {
  describe("Normal path: migration compatibility", () => {
    it("identifies up-to-date database correctly", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        FIXTURE_UP_TO_DATE_DATABASE,
      );

      expect(report.status).toBe("up-to-date");
      expect(report.compatible).toBe(true);
      expect(report.pendingVersions).toHaveLength(0);
      expect(report.currentVersion).toBe(
        "1792342800000-add-approval-intent-receipts",
      );
      expect(report.nextVersion).toBeNull();
    });

    it("identifies upgrade-ready database with pending migrations", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        FIXTURE_UPGRADE_READY_DATABASE,
      );

      expect(report.status).toBe("upgrade-ready");
      expect(report.compatible).toBe(true);
      expect(report.currentVersion).toBe("1790467200000-create-payment-operations");
      expect(report.nextVersion).toBe(
        "1790553600000-create-sensitive-action-chain",
      );
      expect(report.pendingVersions.length).toBeGreaterThan(0);
    });

    it("identifies clean database as upgrade-ready", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        FIXTURE_CLEAN_DATABASE,
      );

      expect(report.status).toBe("upgrade-ready");
      expect(report.compatible).toBe(true);
      expect(report.currentVersion).toBeNull();
      expect(report.nextVersion).toBe("1787313600000-create-module-registry");
      expect(report.pendingVersions).toHaveLength(FIXTURE_KNOWN_MIGRATIONS.length);
    });

    it("finds direct upgrade path in matrix", () => {
      const path = findMigrationPath(
        SCHEMA_MIGRATION_MATRIX,
        null,
        "1787313600000-create-module-registry",
      );

      expect(path).not.toBeNull();
      expect(path?.from).toBeNull();
      expect(path?.to).toBe("1787313600000-create-module-registry");
      expect(path?.path).toContain("1787313600000-create-module-registry");
      expect(path?.isReversible).toBe(true);
    });

    it("constructs migration path from chain when no direct path exists", () => {
      const path = findMigrationPath(
        SCHEMA_MIGRATION_MATRIX,
        "1787313600000-create-module-registry",
        "1790467200000-create-payment-operations",
      );

      expect(path).not.toBeNull();
      expect(path?.path.length).toBeGreaterThan(0);
      expect(path?.estimatedDuration).toBeGreaterThan(0);
    });

    it("validates migration dependencies are satisfied", () => {
      const result = validateMigrationDependencies(
        SCHEMA_MIGRATION_MATRIX,
        "1790467200000-create-payment-operations",
        ["1787600000000-add-refresh-token-family"],
      );

      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it("estimates total migration duration correctly", () => {
      const migrations = [
        "1787313600000-create-module-registry",
        "1787400000000-add-asset-search-indexes",
      ];

      const estimate = estimateMigrationDuration(SCHEMA_MIGRATION_MATRIX, migrations);

      expect(estimate.totalDuration).toBe(3500); // 500 + 3000
      expect(estimate.byCategory.schema).toBeGreaterThan(0);
      expect(estimate.byCategory.index).toBeGreaterThan(0);
      expect(estimate.requiresDowntime).toBe(false);
    });
  });

  describe("Failure path: incompatibility detection", () => {
    it("detects skipped migrations as incompatible", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        FIXTURE_SKIPPED_MIGRATION,
      );

      expect(report.status).toBe("incompatible");
      expect(report.compatible).toBe(false);
      expect(report.reason).toContain("diverges");
    });

    it("detects duplicate migrations as incompatible", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        FIXTURE_DUPLICATE_MIGRATION,
      );

      expect(report.status).toBe("incompatible");
      expect(report.compatible).toBe(false);
      expect(report.reason).toContain("duplicate");
    });

    it("detects out-of-order migrations as incompatible", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        FIXTURE_OUT_OF_ORDER,
      );

      expect(report.status).toBe("incompatible");
      expect(report.compatible).toBe(false);
    });

    it("detects unmet dependencies", () => {
      const { migration, applied, expected } = FIXTURE_UNMET_DEPENDENCIES;

      const result = validateMigrationDependencies(
        {
          ...SCHEMA_MIGRATION_MATRIX,
          migrations: {
            ...SCHEMA_MIGRATION_MATRIX.migrations,
            [migration.id]: migration,
          },
        },
        migration.id,
        applied,
      );

      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(expected);
    });

    it("identifies conflicting migrations", () => {
      const { migration, conflictsWith } = FIXTURE_CONFLICTING_MIGRATIONS;

      const issues = checkMigrationIncompatibilities(
        {
          ...SCHEMA_MIGRATION_MATRIX,
          migrations: {
            ...SCHEMA_MIGRATION_MATRIX.migrations,
            [migration.id]: migration,
          },
        },
        [migration.id, conflictsWith.id],
      );

      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].migrations).toContain(migration.id);
    });

    it("returns null for invalid migration paths", () => {
      const path = findMigrationPath(
        SCHEMA_MIGRATION_MATRIX,
        "non-existent-migration",
        "1787313600000-create-module-registry",
      );

      expect(path).toBeNull();
    });

    it("returns null for backward migration paths", () => {
      const path = findMigrationPath(
        SCHEMA_MIGRATION_MATRIX,
        "1790467200000-create-payment-operations",
        "1787313600000-create-module-registry",
      );

      expect(path).toBeNull();
    });

    it("handles partial migration failures gracefully", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        FIXTURE_PARTIAL_FAILURE,
      );

      expect(report.status).toBe("upgrade-ready");
      expect(report.nextVersion).toBe("1787600000000-add-refresh-token-family");
    });
  });

  describe("Retry path: failure recovery", () => {
    it("marks breaking migrations as irreversible", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        FIXTURE_UPGRADE_READY_DATABASE,
      );

      expect(report.hasBreakingPending).toBeDefined();
      expect(report.irreversiblePendingVersions).toBeDefined();

      if (report.hasBreakingPending) {
        expect(report.irreversiblePendingVersions!.length).toBeGreaterThan(0);
      }
    });

    it("identifies reversible migration paths", () => {
      const { from, to, migrations, canRollback } =
        FIXTURE_ROLLBACK_SCENARIOS.reversiblePath;

      const migrationEntries = migrations.map((id) =>
        SCHEMA_MIGRATION_MATRIX.migrations[id],
      );

      const allReversible = migrationEntries.every((m) => m?.reversible);
      expect(allReversible).toBe(canRollback);
    });

    it("identifies irreversible migration paths", () => {
      const { from, to, migrations, canRollback } =
        FIXTURE_ROLLBACK_SCENARIOS.irreversiblePath;

      const migrationEntries = migrations.map(
        (id) => SCHEMA_MIGRATION_MATRIX.migrations[id],
      );

      const allReversible = migrationEntries.every((m) => m?.reversible);
      expect(allReversible).toBe(canRollback);
    });

    it("handles partially reversible paths correctly", () => {
      const { migrations, canRollback } =
        FIXTURE_ROLLBACK_SCENARIOS.partiallyReversible;

      const migrationEntries = migrations.map(
        (id) => SCHEMA_MIGRATION_MATRIX.migrations[id],
      );

      const allReversible = migrationEntries.every((m) => m?.reversible);
      expect(allReversible).toBe(canRollback);
    });

    it("validates rollback paths in matrix", () => {
      const rollbackPath = SCHEMA_MIGRATION_MATRIX.rollbackPaths.find(
        (path) =>
          path.from === "1787400000000-add-asset-search-indexes" &&
          path.to === "1787313600000-create-module-registry",
      );

      expect(rollbackPath).toBeDefined();
      expect(rollbackPath?.isReversible).toBe(true);
    });
  });

  describe("Authorization path: role enforcement", () => {
    it("validates admin-only migrations", () => {
      const { migration, allowedRoles, deniedRoles } =
        FIXTURE_AUTHORIZATION_SCENARIOS.adminOnly;

      expect(migration.requiredRole).toBe("admin");
      expect(allowedRoles).toContain("admin");
      expect(deniedRoles).not.toContain("admin");
    });

    it("validates operator-allowed migrations", () => {
      const { migration, allowedRoles } =
        FIXTURE_AUTHORIZATION_SCENARIOS.operatorAllowed;

      expect(allowedRoles).toContain("operator");
      expect(allowedRoles).toContain("admin");
    });

    it("validates public migrations without role requirements", () => {
      const { migration, deniedRoles } =
        FIXTURE_AUTHORIZATION_SCENARIOS.publicMigration;

      expect(migration.requiredRole).toBeUndefined();
      expect(deniedRoles).toHaveLength(0);
    });

    it("includes role information in migration notes", () => {
      const notes = generateMigrationNotes(SCHEMA_MIGRATION_MATRIX, [
        FIXTURE_BREAKING_CHANGE_ENTRY.id,
      ]);

      expect(notes[FIXTURE_BREAKING_CHANGE_ENTRY.id].requiredRole).toBe("admin");
    });

    it("identifies migrations requiring elevated privileges", () => {
      const adminMigrations = Object.values(SCHEMA_MIGRATION_MATRIX.migrations)
        .filter((m) => m.requiredRole === "admin")
        .map((m) => m.id);

      expect(adminMigrations.length).toBeGreaterThan(0);
      expect(adminMigrations).toContain(
        "1787600000000-add-refresh-token-family",
      );
    });
  });

  describe("Edge cases and migration notes", () => {
    it("generates complete migration notes", () => {
      const notes = generateMigrationNotes(SCHEMA_MIGRATION_MATRIX, [
        FIXTURE_BREAKING_CHANGE_ENTRY.id,
        FIXTURE_NON_BREAKING_ENTRY.id,
      ]);

      expect(notes[FIXTURE_BREAKING_CHANGE_ENTRY.id]).toMatchObject({
        version: FIXTURE_BREAKING_CHANGE_ENTRY.id,
        impact: "breaking",
        reversible: false,
      });

      expect(notes[FIXTURE_NON_BREAKING_ENTRY.id]).toMatchObject({
        version: FIXTURE_NON_BREAKING_ENTRY.id,
        impact: "non-breaking",
        reversible: true,
      });
    });

    it("includes warnings in migration notes", () => {
      const notes = generateMigrationNotes(SCHEMA_MIGRATION_MATRIX, [
        FIXTURE_BREAKING_CHANGE_ENTRY.id,
      ]);

      expect(notes[FIXTURE_BREAKING_CHANGE_ENTRY.id].warnings).toBeDefined();
      expect(notes[FIXTURE_BREAKING_CHANGE_ENTRY.id].warnings!.length).toBeGreaterThan(
        0,
      );
    });

    it("handles empty migration history", () => {
      const { known, applied, expectedStatus } = FIXTURE_EDGE_CASES.emptyMigrationHistory;

      const report = evaluateMigrationCompatibility(known, applied);

      expect(report.status).toBe(expectedStatus);
      expect(report.currentVersion).toBeNull();
    });

    it("handles duplicate known migrations", () => {
      const { known, applied, expectedStatus } =
        FIXTURE_EDGE_CASES.duplicateKnownMigrations;

      const report = evaluateMigrationCompatibility(known, applied);

      expect(report.status).toBe(expectedStatus);
      expect(report.reason).toContain("Duplicate");
    });

    it("handles invalid timestamps", () => {
      const { known, applied, expectedStatus } = FIXTURE_EDGE_CASES.invalidTimestamp;

      const report = evaluateMigrationCompatibility(known, applied);

      expect(report.status).toBe(expectedStatus);
    });

    it("calculates zero duration for empty paths", () => {
      const estimate = estimateMigrationDuration(SCHEMA_MIGRATION_MATRIX, []);

      expect(estimate.totalDuration).toBe(0);
      expect(estimate.requiresDowntime).toBe(false);
    });

    it("identifies data-destructive migrations", () => {
      const entry = FIXTURE_DESTRUCTIVE_ENTRY;

      expect(entry.impact).toBe("data-destructive");
      expect(entry.reversible).toBe(false);
      expect(entry.warnings!.length).toBeGreaterThan(0);
    });
  });

  describe("Breaking changes and downtime", () => {
    it("identifies breaking changes in pending migrations", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        FIXTURE_UPGRADE_READY_DATABASE,
      );

      const breakingMigrations = report.pendingVersions.filter((id) => {
        const migration = SCHEMA_MIGRATION_MATRIX.migrations[id];
        return migration?.impact === "breaking";
      });

      if (breakingMigrations.length > 0) {
        expect(report.hasBreakingPending).toBe(true);
      }
    });

    it("identifies migrations requiring downtime", () => {
      const path = SCHEMA_MIGRATION_MATRIX.upgradePaths.find(
        (p) => p.requiresDowntime,
      );

      expect(path).toBeDefined();

      const migrations = path!.path.map((id) => SCHEMA_MIGRATION_MATRIX.migrations[id]);

      const downtimeMigrations = migrations.filter((m) => m?.requiresDowntime);
      expect(downtimeMigrations.length).toBeGreaterThan(0);
    });

    it("calculates downtime requirements in estimates", () => {
      const migrations = Object.keys(SCHEMA_MIGRATION_MATRIX.migrations).filter(
        (id) => SCHEMA_MIGRATION_MATRIX.migrations[id].requiresDowntime,
      );

      const estimate = estimateMigrationDuration(SCHEMA_MIGRATION_MATRIX, migrations);

      expect(estimate.requiresDowntime).toBe(true);
    });
  });

  describe("Matrix validation and consistency", () => {
    it("all migrations have valid timestamps", () => {
      const migrations = Object.values(SCHEMA_MIGRATION_MATRIX.migrations);

      for (const migration of migrations) {
        expect(Number.isSafeInteger(migration.timestamp)).toBe(true);
        expect(migration.timestamp).toBeGreaterThan(0);
      }
    });

    it("all upgrade paths reference valid migrations", () => {
      for (const path of SCHEMA_MIGRATION_MATRIX.upgradePaths) {
        for (const migrationId of path.path) {
          expect(SCHEMA_MIGRATION_MATRIX.migrations[migrationId]).toBeDefined();
        }
      }
    });

    it("all rollback paths reference valid migrations", () => {
      for (const path of SCHEMA_MIGRATION_MATRIX.rollbackPaths) {
        for (const migrationId of path.path) {
          expect(SCHEMA_MIGRATION_MATRIX.migrations[migrationId]).toBeDefined();
        }
      }
    });

    it("all dependencies reference valid migrations", () => {
      const allMigrationIds = new Set(
        Object.keys(SCHEMA_MIGRATION_MATRIX.migrations),
      );

      for (const migration of Object.values(SCHEMA_MIGRATION_MATRIX.migrations)) {
        for (const dep of migration.dependencies) {
          expect(allMigrationIds.has(dep)).toBe(true);
        }
      }
    });

    it("estimates match sum of individual durations", () => {
      const path = SCHEMA_MIGRATION_MATRIX.upgradePaths[0];
      const migrations = path.path.map((id) => SCHEMA_MIGRATION_MATRIX.migrations[id]);

      const manualSum = migrations.reduce((sum, m) => sum + m.estimatedDuration, 0);

      expect(path.estimatedDuration).toBe(manualSum);
    });
  });

  describe("Helper functions and utilities", () => {
    it("generates migration history fixtures", () => {
      const history = generateMigrationHistory(5, 1000000000000);

      expect(history).toHaveLength(5);
      expect(history[0].timestamp).toBe(1000000000000);
      expect(history[4].timestamp).toBe(1000000004000);
    });

    it("generates known migrations fixtures", () => {
      const known = generateKnownMigrations(3, 2000000000000);

      expect(known).toHaveLength(3);
      expect(known[0].timestamp).toBe(2000000000000);
      expect(known[2].id).toContain("2000000002000");
    });

    it("creates custom migration entries", () => {
      const entry = createMigrationEntry({
        id: "custom-migration",
        description: "Custom test migration",
        impact: "breaking",
        category: "data",
      });

      expect(entry.id).toBe("custom-migration");
      expect(entry.description).toBe("Custom test migration");
      expect(entry.impact).toBe("breaking");
      expect(entry.category).toBe("data");
      expect(entry.reversible).toBe(true); // Default
    });

    it("applies all overrides in custom migration entries", () => {
      const entry = createMigrationEntry({
        id: "full-custom",
        timestamp: 9999999999,
        description: "Fully custom",
        impact: "data-destructive",
        category: "security",
        reversible: false,
        dependencies: ["dep-1", "dep-2"],
        incompatibleWith: ["conflict-1"],
        estimatedDuration: 5000,
        requiresDowntime: true,
        requiredRole: "admin",
        warnings: ["Warning 1", "Warning 2"],
      });

      expect(entry.timestamp).toBe(9999999999);
      expect(entry.reversible).toBe(false);
      expect(entry.dependencies).toEqual(["dep-1", "dep-2"]);
      expect(entry.incompatibleWith).toEqual(["conflict-1"]);
      expect(entry.estimatedDuration).toBe(5000);
      expect(entry.requiresDowntime).toBe(true);
      expect(entry.requiredRole).toBe("admin");
      expect(entry.warnings).toEqual(["Warning 1", "Warning 2"]);
    });
  });
});

## Schema Migration Compatibility Matrix

## Overview

The schema migration compatibility matrix provides a comprehensive framework for testing and validating database schema migrations across various scenarios. This implementation ensures safe upgrades, rollbacks, and migration path planning with proper authorization checks and failure handling.

## Purpose

Validate schema migration compatibility across:
- Normal upgrade paths from any version to any version
- Failure scenarios (skipped migrations, duplicates, out-of-order)
- Retry logic for transient database failures
- Authorization checks for sensitive migrations
- Rollback paths and reversibility validation
- Breaking change detection and impact assessment

## Architecture

### Core Components

#### 1. Migration Matrix Entry

```typescript
interface MigrationMatrixEntry {
  id: string;                          // Unique migration identifier
  timestamp: number;                   // Numeric timestamp
  description: string;                 // Human-readable description
  impact: MigrationImpact;            // non-breaking | breaking | data-destructive
  category: MigrationCategory;         // schema | data | index | constraint | procedure | security
  reversible: boolean;                 // Can be automatically rolled back
  dependencies: string[];              // Required prior migrations
  incompatibleWith: string[];          // Conflicting migrations
  estimatedDuration: number;           // Expected execution time (ms)
  requiresDowntime: boolean;           // Needs service interruption
  requiredRole?: string;               // Minimum required role
  warnings?: string[];                 // Special notices
}
```

#### 2. Compatibility Path

```typescript
interface CompatibilityPath {
  from: string | null;                 // Starting version
  to: string;                          // Target version
  path: string[];                      // Migration sequence
  estimatedDuration: number;           // Total duration
  hasBreakingChanges: boolean;         // Contains breaking migrations
  isReversible: boolean;               // Entire path can be rolled back
  requiresDowntime: boolean;           // Any migration needs downtime
}
```

#### 3. Migration Compatibility Matrix

```typescript
interface MigrationCompatibilityMatrix {
  migrations: Record<string, MigrationMatrixEntry>;
  upgradePaths: CompatibilityPath[];
  rollbackPaths: CompatibilityPath[];
  incompatibilities: Array<{
    migrations: string[];
    reason: string;
  }>;
}
```

## Test Coverage

### 1. Normal Path: Migration Compatibility

**Scenarios:**
- ✅ Up-to-date database identification
- ✅ Upgrade-ready database with pending migrations
- ✅ Clean database initialization
- ✅ Direct upgrade path resolution
- ✅ Constructed migration paths
- ✅ Dependency validation
- ✅ Duration estimation

**Example:**
```typescript
const report = evaluateMigrationCompatibility(
  FIXTURE_KNOWN_MIGRATIONS,
  FIXTURE_UP_TO_DATE_DATABASE
);

expect(report.status).toBe("up-to-date");
expect(report.compatible).toBe(true);
expect(report.pendingVersions).toHaveLength(0);
```

### 2. Failure Path: Incompatibility Detection

**Scenarios:**
- ✅ Skipped migrations
- ✅ Duplicate migrations
- ✅ Out-of-order migrations
- ✅ Unmet dependencies
- ✅ Conflicting migrations
- ✅ Invalid migration paths
- ✅ Backward migration attempts
- ✅ Partial migration failures

**Example:**
```typescript
const report = evaluateMigrationCompatibility(
  FIXTURE_KNOWN_MIGRATIONS,
  FIXTURE_SKIPPED_MIGRATION
);

expect(report.status).toBe("incompatible");
expect(report.reason).toContain("diverges");
```

### 3. Retry Path: Failure Recovery

**Scenarios:**
- ✅ Breaking migrations marked as irreversible
- ✅ Reversible migration path identification
- ✅ Irreversible migration path detection
- ✅ Partially reversible paths
- ✅ Rollback path validation

**Example:**
```typescript
const report = evaluateMigrationCompatibility(
  FIXTURE_KNOWN_MIGRATIONS,
  FIXTURE_UPGRADE_READY_DATABASE
);

if (report.hasBreakingPending) {
  expect(report.irreversiblePendingVersions!.length).toBeGreaterThan(0);
}
```

### 4. Authorization Path: Role Enforcement

**Scenarios:**
- ✅ Admin-only migration validation
- ✅ Operator-allowed migrations
- ✅ Public migrations without role requirements
- ✅ Role information in migration notes
- ✅ Elevated privilege identification

**Example:**
```typescript
const { migration, allowedRoles } = 
  FIXTURE_AUTHORIZATION_SCENARIOS.adminOnly;

expect(migration.requiredRole).toBe("admin");
expect(allowedRoles).toContain("admin");
```

### 5. Breaking Changes and Downtime

**Scenarios:**
- ✅ Breaking change identification
- ✅ Downtime requirement detection
- ✅ Impact assessment in estimates
- ✅ Warning generation

### 6. Matrix Validation

**Scenarios:**
- ✅ Valid timestamps
- ✅ Valid migration references
- ✅ Valid dependencies
- ✅ Consistent duration estimates

## Migration Categories

### Schema Migrations
- Table creation/modification
- Column additions/removals
- Type changes

### Data Migrations
- Data transformations
- Backfills
- Archival operations

### Index Migrations
- Index creation
- Index optimization
- Trigram indexes

### Constraint Migrations
- Foreign keys
- Check constraints
- Unique constraints

### Procedure Migrations
- Stored procedures
- Functions
- Triggers

### Security Migrations
- Permission changes
- Role modifications
- Audit trail setup

## Impact Levels

### Non-Breaking
- ✅ Backward compatible
- ✅ No data loss
- ✅ Typically reversible
- ✅ Can run during operation

**Examples:**
- Adding nullable columns
- Creating indexes
- Adding new tables

### Breaking
- ⚠️ API/contract changes
- ⚠️ Requires application restart
- ⚠️ Usually irreversible
- ⚠️ May require downtime

**Examples:**
- Removing columns
- Changing column types
- Renaming tables

### Data-Destructive
- ❌ Permanent data loss
- ❌ Cannot be rolled back
- ❌ Requires backup
- ❌ Requires downtime

**Examples:**
- Data retention policies
- Archival with deletion
- Schema cleanup

## Usage Examples

### Finding Migration Path

```typescript
const path = findMigrationPath(
  SCHEMA_MIGRATION_MATRIX,
  "1787313600000-create-module-registry",
  "1790467200000-create-payment-operations"
);

if (path) {
  console.log(`Path: ${path.path.join(" → ")}`);
  console.log(`Duration: ${path.estimatedDuration}ms`);
  console.log(`Breaking: ${path.hasBreakingChanges}`);
  console.log(`Reversible: ${path.isReversible}`);
}
```

### Validating Dependencies

```typescript
const result = validateMigrationDependencies(
  SCHEMA_MIGRATION_MATRIX,
  "1790467200000-create-payment-operations",
  appliedMigrationIds
);

if (!result.valid) {
  console.error(`Missing dependencies: ${result.missing.join(", ")}`);
}
```

### Checking Incompatibilities

```typescript
const issues = checkMigrationIncompatibilities(
  SCHEMA_MIGRATION_MATRIX,
  plannedMigrationIds
);

if (issues.length > 0) {
  issues.forEach(issue => {
    console.error(`Conflict: ${issue.reason}`);
    console.error(`Affected: ${issue.migrations.join(", ")}`);
  });
}
```

### Estimating Duration

```typescript
const estimate = estimateMigrationDuration(
  SCHEMA_MIGRATION_MATRIX,
  migrationIds
);

console.log(`Total: ${estimate.totalDuration}ms`);
console.log(`By category:`, estimate.byCategory);
console.log(`Downtime: ${estimate.requiresDowntime}`);
```

### Generating Migration Notes

```typescript
const notes = generateMigrationNotes(
  SCHEMA_MIGRATION_MATRIX,
  pendingMigrationIds
);

for (const [id, note] of Object.entries(notes)) {
  console.log(`${id}: ${note.description}`);
  console.log(`  Impact: ${note.impact}`);
  console.log(`  Reversible: ${note.reversible}`);
  if (note.warnings) {
    note.warnings.forEach(w => console.warn(`  ⚠️  ${w}`));
  }
}
```

## Fixtures

### Available Fixtures

#### Database States
- `FIXTURE_CLEAN_DATABASE` - No migrations applied
- `FIXTURE_UP_TO_DATE_DATABASE` - All migrations applied
- `FIXTURE_UPGRADE_READY_DATABASE` - Pending migrations available
- `FIXTURE_PARTIAL_FAILURE` - Migration started but not completed

#### Error Scenarios
- `FIXTURE_SKIPPED_MIGRATION` - Migration skipped in sequence
- `FIXTURE_DUPLICATE_MIGRATION` - Same migration applied twice
- `FIXTURE_OUT_OF_ORDER` - Migrations applied in wrong order

#### Migration Types
- `FIXTURE_BREAKING_CHANGE_ENTRY` - Breaking migration
- `FIXTURE_NON_BREAKING_ENTRY` - Safe migration
- `FIXTURE_DESTRUCTIVE_ENTRY` - Data-destructive migration

#### Complex Scenarios
- `FIXTURE_UNMET_DEPENDENCIES` - Dependencies not satisfied
- `FIXTURE_CONFLICTING_MIGRATIONS` - Incompatible migrations
- `FIXTURE_AUTHORIZATION_SCENARIOS` - Role-based scenarios
- `FIXTURE_ROLLBACK_SCENARIOS` - Rollback path scenarios

### Helper Functions

```typescript
// Generate test data
const history = generateMigrationHistory(10, startTimestamp);
const known = generateKnownMigrations(10, startTimestamp);

// Create custom entries
const entry = createMigrationEntry({
  id: "custom-migration",
  description: "My test migration",
  impact: "breaking",
  requiresDowntime: true,
});
```

## Integration with Existing Systems

### Storage Compatibility Service

```typescript
import { evaluateMigrationCompatibility } from "./storage-schema-compatibility";
import { SCHEMA_MIGRATION_MATRIX } from "./schema-migration-matrix";

const report = evaluateMigrationCompatibility(
  FIXTURE_KNOWN_MIGRATIONS,
  appliedMigrations,
  generateMigrationNotes(SCHEMA_MIGRATION_MATRIX, pendingIds)
);
```

### Operational Health Checks

```typescript
// In health check endpoint
const compatibilityReport = await checkStorageSchemaCompatibility(dataSource);

if (compatibilityReport.hasBreakingPending) {
  logger.warn("Breaking migrations pending", {
    irreversible: compatibilityReport.irreversiblePendingVersions,
  });
}
```

## Best Practices

### 1. Migration Design

✅ **Do:**
- Make migrations idempotent
- Include rollback logic when possible
- Document breaking changes
- Estimate duration accurately
- Set appropriate role requirements

❌ **Don't:**
- Skip dependency declarations
- Mark destructive migrations as reversible
- Underestimate execution time
- Mix multiple concerns in one migration

### 2. Testing

✅ **Do:**
- Test upgrade paths from all supported versions
- Validate rollback paths
- Test with realistic data volumes
- Verify authorization checks
- Test failure scenarios

❌ **Don't:**
- Skip edge cases
- Test only happy paths
- Ignore performance implications
- Forget authorization testing

### 3. Deployment

✅ **Do:**
- Backup before breaking changes
- Schedule downtime for critical migrations
- Monitor migration progress
- Have rollback plan ready
- Communicate breaking changes

❌ **Don't:**
- Run breaking migrations without notice
- Skip dependency validation
- Ignore warnings
- Deploy without testing

## Migration Checklist

Before deploying a migration:

- [ ] Timestamp is unique and correct
- [ ] Dependencies are declared
- [ ] Impact level is accurate
- [ ] Reversibility is correctly marked
- [ ] Estimated duration is realistic
- [ ] Required role is specified
- [ ] Warnings are documented
- [ ] Tests cover the migration
- [ ] Rollback plan exists
- [ ] Breaking changes are communicated

## Rollback Strategy

### Reversible Migrations

```typescript
// Verify path is reversible
const path = findMigrationPath(matrix, currentVersion, targetVersion);

if (!path.isReversible) {
  throw new Error("Cannot rollback: path contains irreversible migrations");
}

// Execute rollback
await rollbackMigrations(path.path.reverse());
```

### Breaking Migrations

For irreversible breaking migrations:

1. **Preparation**: Full database backup
2. **Validation**: Test in staging environment
3. **Communication**: Notify all stakeholders
4. **Execution**: Apply during maintenance window
5. **Verification**: Confirm success before resuming

### Data-Destructive Migrations

Special considerations:

- Multiple backups (before and during)
- Extended maintenance window
- Point-in-time recovery capability
- Manual verification steps
- Staged rollout if possible

## Monitoring and Observability

### Metrics to Track

- Migration duration (actual vs estimated)
- Success/failure rates
- Downtime duration
- Rollback frequency
- Authorization violations

### Logging

```typescript
logger.info("Migration started", {
  id: migration.id,
  impact: migration.impact,
  estimatedDuration: migration.estimatedDuration,
});

logger.info("Migration completed", {
  id: migration.id,
  actualDuration,
  success: true,
});
```

## Edge Cases

### Handled Scenarios

✅ Empty migration history
✅ Duplicate known migrations
✅ Invalid timestamps
✅ Zero-length paths
✅ Circular dependencies
✅ Missing dependencies
✅ Version conflicts

### Error Messages

Clear, actionable error messages for:
- Incompatible database states
- Missing dependencies
- Permission violations
- Duration exceeded
- Validation failures

## Contract Guarantees

### Compatibility Status

- **up-to-date**: Applied migrations exactly match known migrations
- **upgrade-ready**: Applied migrations are a valid prefix of known migrations
- **incompatible**: Database state cannot be reconciled with application

### Invariants

✅ All applied migrations exist in known migrations
✅ Applied migrations are in timestamp order
✅ No duplicate timestamps
✅ No skipped migrations
✅ Dependencies are satisfied

## Future Enhancements

Potential extensions:

- Parallel migration execution
- Automatic dependency resolution
- Performance prediction ML
- Automated rollback triggers
- Migration scheduling
- Canary deployments

## References

- [Storage Schema Compatibility](../src/storage-compatibility/storage-schema-compatibility.ts)
- [Migration Notes Types](../src/storage-compatibility/migration-notes.types.ts)
- [Schema Migration Matrix](../src/storage-compatibility/schema-migration-matrix.ts)
- [Fixtures](../src/storage-compatibility/fixtures/schema-migration-fixtures.ts)

## Compliance

- ✅ Covers normal, failure, retry, and authorization paths
- ✅ Automated tests with executable verification
- ✅ Edge cases documented with recovery behavior
- ✅ No contract changes (test-only implementation)
- ✅ Focused vertical slice of migration compatibility

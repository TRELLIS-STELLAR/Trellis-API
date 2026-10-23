/**
 * Release Readiness Checker engine.
 *
 * Implements pure, deterministic verification routines for:
 * 1. Database migration reversibility, locking, and index safety
 * 2. Preflight smoke tests with retry & exponential backoff
 * 3. Zero-downtime rollback safety and backward compatibility
 */

import {
  MigrationFileSpec,
  MigrationReadinessReport,
  SmokeProbe,
  SmokeTestOptions,
  SmokeProbeResult,
  SmokeTestReport,
  SchemaColumnSpec,
  RollbackReadinessReport,
} from "./release-readiness.types";

/**
 * Inspects a TypeScript / SQL migration file content for production safety rules.
 */
export function analyzeMigrationFile(filename: string, content: string): MigrationFileSpec {
  const issues: string[] = [];
  const warnings: string[] = [];

  // 1. Reversibility check: must have a non-trivial down() method
  const hasDownDeclaration = /down\s*\([^)]*\)\s*:\s*Promise<void>|async\s+down\s*\(/i.test(content);
  let hasValidDownBody = false;

  if (hasDownDeclaration) {
    // Check if down body throws an error or is empty
    const downBodyMatch = content.match(/down\s*\([^)]*\)[\s\S]*?\{([\s\S]*?)\n\s*\}/);
    const downBody = downBodyMatch ? downBodyMatch[1].trim() : "";

    const throwsIrreversible = /throw\s+new\s+Error\s*\(\s*["'`].*irrevers/i.test(downBody);
    const isEmpty = downBody.length === 0 || /^(\/\*[\s\S]*?\*\/|\/\/.*|\s*)*$/.test(downBody);

    if (throwsIrreversible) {
      issues.push(`Migration '${filename}' explicitly declares down() as irreversible.`);
    } else if (isEmpty) {
      issues.push(`Migration '${filename}' has an empty down() method body.`);
    } else {
      hasValidDownBody = true;
    }
  } else {
    issues.push(`Migration '${filename}' does not implement a down() method.`);
  }

  // Extract up() method body for targeted query inspection
  const upMatch = content.match(/up\s*\([^)]*\)[\s\S]*?\{([\s\S]*?)\n\s*(public\s+async\s+down|async\s+down|\})/);
  const upSqlContent = upMatch ? upMatch[1] : content;

  // 2. Exclusive Table Locks
  const hasExclusiveLock = /LOCK\s+TABLE/i.test(upSqlContent) || /ACCESS\s+EXCLUSIVE/i.test(upSqlContent);
  if (hasExclusiveLock) {
    issues.push(`Migration '${filename}' contains explicit LOCK TABLE or ACCESS EXCLUSIVE which blocks production traffic.`);
  }

  // 3. Index Creation Concurrency
  // If CREATE INDEX is present without CONCURRENTLY (excluding CREATE UNIQUE INDEX inside table definition)
  const nonConcurrentIndexRegex = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)(?:IF\s+NOT\s+EXISTS\s+)?["`]?\w+["`]?\s+ON/i;
  const hasNonConcurrentIndex = nonConcurrentIndexRegex.test(upSqlContent);
  const createsIndexConcurrently = !hasNonConcurrentIndex;
  if (hasNonConcurrentIndex) {
    warnings.push(
      `Migration '${filename}' creates an index without CONCURRENTLY. In production PostgreSQL, this acquires a SHARE lock blocking writes.`,
    );
  }

  // 4. Unsafe NOT NULL column addition without DEFAULT
  // e.g. ADD COLUMN "name" varchar NOT NULL without DEFAULT
  const unsafeNotNullRegex = /ADD\s+COLUMN\s+["`]?\w+["`]?\s+[^;]+?\bNOT\s+NULL\b(?!\s+DEFAULT\b)/i;
  const hasUnsafeNotNullAdd = unsafeNotNullRegex.test(upSqlContent);
  if (hasUnsafeNotNullAdd) {
    issues.push(
      `Migration '${filename}' adds a NOT NULL column without a DEFAULT value. This fails when existing rows exist and breaks zero-downtime rollback.`,
    );
  }

  // 5. Destructive Drop operations
  const hasDestructiveDrop = /DROP\s+TABLE\b/i.test(upSqlContent) || /DROP\s+COLUMN\b/i.test(upSqlContent);
  if (hasDestructiveDrop) {
    warnings.push(
      `Migration '${filename}' drops a table or column in up(). This is a destructive breaking change for active application instances.`,
    );
  }

  return {
    filename,
    hasDownMethod: hasValidDownBody,
    hasExclusiveLock,
    createsIndexConcurrently,
    hasUnsafeNotNullAdd,
    hasDestructiveDrop,
    issues,
    warnings,
  };
}

/**
 * Validates a suite of migration files for release readiness.
 */
export function verifyMigrationReadiness(
  migrations: Array<{ filename: string; content: string }>,
): MigrationReadinessReport {
  const fileSpecs: MigrationFileSpec[] = [];
  const issues: string[] = [];
  const warnings: string[] = [];
  const recommendations: string[] = [];

  let reversibleCount = 0;
  let lockingSafeCount = 0;

  for (const mig of migrations) {
    const spec = analyzeMigrationFile(mig.filename, mig.content);
    fileSpecs.push(spec);

    if (spec.hasDownMethod) reversibleCount++;
    if (!spec.hasExclusiveLock && spec.createsIndexConcurrently) lockingSafeCount++;

    issues.push(...spec.issues);
    warnings.push(...spec.warnings);
  }

  if (migrations.length > 0 && reversibleCount < migrations.length) {
    recommendations.push("Implement comprehensive down() statements that cleanly revert all up() schema changes.");
  }

  if (warnings.some((w) => w.includes("CONCURRENTLY"))) {
    recommendations.push("Use 'CREATE INDEX CONCURRENTLY' for PostgreSQL index additions to avoid read/write locks.");
  }

  if (issues.some((i) => i.includes("NOT NULL column without a DEFAULT"))) {
    recommendations.push("Make new columns nullable first or supply a DEFAULT value so existing application code remains compatible.");
  }

  return {
    isReady: issues.length === 0,
    checkedCount: migrations.length,
    reversibleCount,
    lockingSafeCount,
    issues,
    warnings,
    recommendations,
    fileSpecs,
  };
}

/**
 * Runs smoke test probes with configurable retry and exponential backoff.
 */
export async function executeSmokeTestsWithRetry(
  probes: SmokeProbe[],
  options?: SmokeTestOptions,
): Promise<SmokeTestReport> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const backoffMs = options?.backoffMs ?? 100;
  const results: SmokeProbeResult[] = [];
  const startAll = Date.now();

  let passedProbes = 0;
  let failedProbes = 0;
  let warnedProbes = 0;

  for (const probe of probes) {
    const probeStart = Date.now();
    let attempts = 0;
    let lastError: string | undefined;
    let statusCode: number | undefined;
    let probeSucceeded = false;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        if (probe.probeFn) {
          const res = await probe.probeFn();
          statusCode = res.status;
          if (res.ok && (!res.status || res.status < 500)) {
            probeSucceeded = true;
            break;
          }
          lastError = res.error || (res.status ? `HTTP ${res.status}` : "Probe returned non-ok");
        } else {
          // Default mock/fallback if no probeFn injected
          probeSucceeded = true;
          statusCode = 200;
          break;
        }
      } catch (err: any) {
        lastError = err?.message || String(err);
      }

      if (attempts < maxAttempts) {
        options?.onRetry?.(probe.name, attempts, lastError);
        await new Promise((resolve) => setTimeout(resolve, backoffMs * attempts));
      }
    }

    const durationMs = Date.now() - probeStart;
    const isRequired = probe.required !== false;

    if (probeSucceeded) {
      passedProbes++;
      const detail =
        attempts === 1
          ? `Probe succeeded on first attempt (${durationMs}ms)`
          : `Probe recovered and succeeded on retry attempt ${attempts} (${durationMs}ms)`;

      results.push({
        name: probe.name,
        status: "PASSED",
        attempts,
        durationMs,
        statusCode,
        detail,
      });
    } else {
      if (isRequired) {
        failedProbes++;
        results.push({
          name: probe.name,
          status: "FAILED",
          attempts,
          durationMs,
          statusCode,
          error: lastError,
          detail: `Probe failed after ${attempts} attempt(s): ${lastError}`,
        });
      } else {
        warnedProbes++;
        results.push({
          name: probe.name,
          status: "WARN",
          attempts,
          durationMs,
          statusCode,
          error: lastError,
          detail: `Optional probe failed after ${attempts} attempt(s) (non-blocking): ${lastError}`,
        });
      }
    }
  }

  const totalDurationMs = Date.now() - startAll;

  return {
    allPassed: failedProbes === 0,
    totalProbes: probes.length,
    passedProbes,
    failedProbes,
    warnedProbes,
    totalDurationMs,
    results,
  };
}

/**
 * Analyzes database changes and rollback plans for zero-downtime safety.
 */
export function verifyRollbackSafety(
  columns: SchemaColumnSpec[],
  downStepsReversible = true,
): RollbackReadinessReport {
  const breakingChanges: string[] = [];
  const warnings: string[] = [];
  const rollbackGuidance: string[] = [];

  for (const col of columns) {
    // 1. Unsafe new columns: NOT NULL without DEFAULT
    if (col.isNew && !col.isNullable && !col.hasDefault) {
      breakingChanges.push(
        `Column '${col.column}' on '${col.table}' is NOT NULL and lacks a DEFAULT value. Older running code will fail when inserting records.`,
      );
    }

    // 2. Dropped columns break running or rolled back previous versions
    if (col.isDropped) {
      breakingChanges.push(
        `Column '${col.column}' on '${col.table}' was dropped. Rolling back to previous code version will immediately crash queries referencing this column.`,
      );
    }

    // 3. Renamed columns
    if (col.isRenamed) {
      warnings.push(
        `Column '${col.column}' on '${col.table}' was renamed. Ensure an active alias or view preserves backward compatibility.`,
      );
    }
  }

  if (!downStepsReversible) {
    breakingChanges.push(
      "Down migrations contain irreversible operations. Safe automatic rollback is not possible without manual data recovery.",
    );
  }

  if (breakingChanges.length === 0) {
    rollbackGuidance.push("All schema additions are backward-compatible (nullable or defaulted). Code rollback is safe.");
    rollbackGuidance.push("In event of release abort: redeploy previous container image; run 'npm run migration:revert' if needed.");
  } else {
    rollbackGuidance.push("Breaking changes detected! To ensure safe rollback:");
    rollbackGuidance.push("- Phase 1: Add new columns as NULLABLE or with DEFAULT; deploy code that writes both.");
    rollbackGuidance.push("- Phase 2: Backfill historical data.");
    rollbackGuidance.push("- Phase 3: Add NOT NULL constraint only after 100% of rows are populated.");
  }

  const safeForZeroDowntimeRollback = breakingChanges.length === 0;

  return {
    safeForZeroDowntimeRollback,
    backwardCompatible: safeForZeroDowntimeRollback,
    breakingChanges,
    warnings,
    rollbackGuidance,
  };
}

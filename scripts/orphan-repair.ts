#!/usr/bin/env ts-node
/**
 * Resumable orphan-repair command with checkpoints.
 * 
 * Scans database tables for orphaned foreign key references and repairs them
 * using a configurable strategy (SET NULL, DELETE, or custom).
 * 
 * Features:
 * - Resumable via checkpoints (survives crashes)
 * - Dry-run preview before applying changes
 * - Full rollback capability using journaled before-images
 * - Progress tracking and reporting
 * - Batch processing with configurable size
 * - Retry logic for transient failures
 * 
 * Usage:
 *   npm run orphan-repair -- --config ./orphan-config.json                    # Dry-run preview
 *   npm run orphan-repair -- --config ./orphan-config.json --apply            # Execute repairs
 *   npm run orphan-repair -- --config ./orphan-config.json --id run-1 --apply # Named checkpoint
 *   npm run orphan-repair -- --id run-1 --report                              # View checkpoint status
 *   npm run orphan-repair -- --id run-1 --rollback                            # Rollback repairs
 *   npm run orphan-repair -- --list                                           # List all checkpoints
 * 
 * Config file format (JSON):
 * {
 *   "relationships": [
 *     {
 *       "table": "transactions",
 *       "fk": "portfolio_id",
 *       "references": "portfolios",
 *       "referencedColumn": "id"
 *     }
 *   ],
 *   "strategy": "set_null"
 * }
 * 
 * Issue #266: Resumable orphan-repair command with checkpoints
 */

import * as fs from "fs";
import * as path from "path";
import { DataSource } from "typeorm";
import { FileRepairCheckpointStore } from "../src/common/repair/file-repair-checkpoint-store";
import {
  parseRepairArgs,
  resolveCheckpointId,
  formatRepairReport,
  REPAIR_USAGE,
} from "../src/common/repair/repair-cli";
import { RepairJob } from "../src/common/repair/repair-job";
import {
  OrphanRepairAdapter,
  OrphanRepairConfig,
} from "../src/common/repair/orphan-repair-adapter";
import { Role } from "../src/common/guard/roles.enum";

const ORPHAN_REPAIR_USAGE = `${REPAIR_USAGE}

Orphan-Repair Specific Options:
  --config <path>         path to orphan repair configuration JSON file (required)

Configuration File Format:
{
  "relationships": [
    {
      "table": "child_table",
      "fk": "parent_id",
      "references": "parent_table",
      "referencedColumn": "id"  // optional, defaults to "id"
    }
  ],
  "strategy": "set_null" | "delete"
}

Strategies:
  set_null - Set orphaned foreign keys to NULL (preserves child record)
  delete   - Delete orphaned child records completely

Examples:
  # Preview orphans (dry-run, no changes)
  npm run orphan-repair -- --config ./config.json

  # Apply repairs with named checkpoint
  npm run orphan-repair -- --config ./config.json --id cleanup-2024-01 --apply

  # Check status of running/completed job
  npm run orphan-repair -- --id cleanup-2024-01 --report

  # Rollback applied repairs
  npm run orphan-repair -- --id cleanup-2024-01 --rollback

  # List all saved checkpoints
  npm run orphan-repair -- --list

Exit codes: 0 success, 1 failure/errors, 2 invalid arguments`;

interface OrphanRepairArgs extends ReturnType<typeof parseRepairArgs> {
  config?: string;
}

function parseOrphanArgs(argv: string[]): OrphanRepairArgs {
  const baseArgs = [] as string[];
  let config: string | undefined;

  // Extract --config before passing to base parser
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") {
      config = argv[++i];
      if (!config) throw new Error("--config requires a value");
    } else {
      baseArgs.push(argv[i]);
    }
  }

  const parsedArgs = parseRepairArgs(baseArgs) as OrphanRepairArgs;
  parsedArgs.config = config;

  // Validate config requirement
  if (!parsedArgs.list && !parsedArgs.help && !parsedArgs.report && !parsedArgs.rollback) {
    if (!parsedArgs.config) {
      throw new Error("--config is required for orphan repair execution");
    }
  }

  return parsedArgs;
}

function loadConfig(configPath: string): OrphanRepairConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read config file: ${(error as Error).message}`);
  }

  let config: OrphanRepairConfig;
  try {
    config = JSON.parse(raw) as OrphanRepairConfig;
  } catch (error) {
    throw new Error(`Invalid JSON in config file: ${(error as Error).message}`);
  }

  // Validate config structure
  if (!config.relationships || !Array.isArray(config.relationships)) {
    throw new Error("Config must have 'relationships' array");
  }

  if (!config.strategy || !["set_null", "delete", "custom"].includes(config.strategy)) {
    throw new Error("Config must have valid 'strategy' (set_null, delete, or custom)");
  }

  for (const rel of config.relationships) {
    if (!rel.table || !rel.fk || !rel.references) {
      throw new Error(
        "Each relationship must have 'table', 'fk', and 'references' properties",
      );
    }
  }

  return config;
}

async function createDataSource(): Promise<DataSource> {
  // Load database configuration from environment
  const dataSource = new DataSource({
    type: "postgres",
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    username: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "trellis",
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();
  return dataSource;
}

function operator() {
  return {
    id: process.env.REPAIR_OPERATOR_ID ?? process.env.USER ?? "orphan-repair-operator",
    roles: [Role.MAINTAINER],
  };
}

async function generateReport(
  adapter: OrphanRepairAdapter,
  config: OrphanRepairConfig,
): Promise<void> {
  console.log("=".repeat(80));
  console.log("ORPHAN REPAIR CONFIGURATION");
  console.log("=".repeat(80));
  console.log(`Strategy: ${config.strategy.toUpperCase()}\n`);
  console.log("Relationships to scan:");
  
  for (const rel of config.relationships) {
    console.log(`  • ${rel.table}.${rel.fk} → ${rel.references}.${rel.referencedColumn || "id"}`);
  }
  
  console.log("\n" + "=".repeat(80));
  console.log("ORPHAN DETECTION PREVIEW");
  console.log("=".repeat(80) + "\n");

  let totalOrphans = 0;
  const orphansByTable: Record<string, number> = {};

  for (const rel of config.relationships) {
    try {
      const page = await adapter.scan(null, 1000);
      const count = page.records.length;
      totalOrphans += count;
      orphansByTable[rel.table] = (orphansByTable[rel.table] || 0) + count;
      
      if (count > 0) {
        console.log(`${rel.table}:`);
        console.log(`  Found: ${count} orphaned records`);
        console.log(`  Foreign Key: ${rel.fk} → ${rel.references}`);
        console.log(`  Sample IDs: ${page.records.slice(0, 5).map(r => r.id).join(", ")}${count > 5 ? "..." : ""}`);
        console.log();
      }
    } catch (error) {
      console.error(`  Error scanning ${rel.table}: ${(error as Error).message}`);
    }
  }

  console.log("=".repeat(80));
  console.log(`Total orphans detected: ${totalOrphans}`);
  console.log("=".repeat(80) + "\n");

  if (totalOrphans > 0) {
    console.log("Run with --apply to execute repairs.");
    console.log("Use --id <checkpoint-name> to create a named checkpoint for this repair run.\n");
  }
}

async function main(): Promise<void> {
  let args: OrphanRepairArgs;
  
  try {
    args = parseOrphanArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${ORPHAN_REPAIR_USAGE}`);
    process.exit(2);
  }

  if (args.help) {
    console.log(ORPHAN_REPAIR_USAGE);
    process.exit(0);
  }

  const store = new FileRepairCheckpointStore(args.checkpointDir);

  // Handle --list command
  if (args.list) {
    const jobs = store.list();
    if (!jobs.length) {
      console.log(`No orphan-repair checkpoints found in ${args.checkpointDir}/`);
    } else {
      console.log(`Saved orphan-repair checkpoints in ${args.checkpointDir}/:`);
      for (const id of jobs) {
        const cp = await store.load(id);
        const status = cp?.status ?? "unknown";
        const dryRun = cp?.dryRun ?? false;
        const repaired = cp?.repaired ?? 0;
        const failures = cp?.failures.length ?? 0;
        
        console.log(`  ${id}`);
        console.log(`    Status: ${status}`);
        console.log(`    Mode: ${dryRun ? "DRY-RUN" : "APPLIED"}`);
        console.log(`    Repaired: ${repaired}`);
        console.log(`    Failures: ${failures}`);
      }
    }
    process.exit(0);
  }

  const checkpointId = args.job || resolveCheckpointId(args);

  // Handle --report command
  if (args.report) {
    const checkpoint = await store.load(checkpointId);
    if (!checkpoint) {
      console.error(`No checkpoint found for orphan-repair job '${checkpointId}'`);
      process.exit(1);
    }
    console.log(formatRepairReport(checkpoint));
    process.exit(0);
  }

  // Load configuration
  let config: OrphanRepairConfig;
  if (args.config) {
    try {
      config = loadConfig(args.config);
    } catch (error) {
      console.error(`Configuration error: ${(error as Error).message}`);
      process.exit(2);
    }
  } else {
    console.error("--config is required");
    process.exit(2);
  }

  // Initialize database connection
  let dataSource: DataSource;
  try {
    dataSource = await createDataSource();
    console.log("✓ Database connection established\n");
  } catch (error) {
    console.error(`Database connection failed: ${(error as Error).message}`);
    process.exit(1);
  }

  try {
    const adapter = new OrphanRepairAdapter(dataSource, config);
    const job = new RepairJob(adapter, store);

    // Handle --restart
    if (args.restart) {
      const existing = await store.load(checkpointId);
      if (existing && existing.journal.length > 0 && !args.force) {
        console.error(
          `Checkpoint '${checkpointId}' holds rollback data for ${existing.journal.length} records.`,
        );
        console.error(`Pass --restart --force to discard and proceed.\n`);
        process.exit(2);
      }
      await store.delete(checkpointId);
      console.log(`✓ Reset checkpoint '${checkpointId}'\n`);
    }

    let exitCode = 1;

    // Handle --rollback
    if (args.rollback) {
      console.log(`Rolling back orphan-repair job '${checkpointId}'...\n`);
      const rolledBack = await job.rollback(operator(), checkpointId);
      console.log(formatRepairReport(rolledBack));
      console.log("\n✓ Rollback completed successfully");
      exitCode = 0;
    } else {
      // Execute repair job
      const mode = args.dryRun ? "DRY-RUN PREVIEW" : "APPLY";
      console.log(`=== ORPHAN REPAIR: ${mode} ===\n`);
      console.log(`Checkpoint: ${checkpointId}`);
      console.log(`Batch size: ${args.batchSize}`);
      console.log(`Max retries: ${args.maxRepairRetries}\n`);

      // Generate preview report if dry-run
      if (args.dryRun) {
        await generateReport(adapter, config);
      }

      console.log(`Starting repair execution...\n`);
      const result = await job.run(operator(), checkpointId, {
        dryRun: args.dryRun,
        batchSize: args.batchSize,
        maxRepairRetries: args.maxRepairRetries,
      });

      console.log("\n" + formatRepairReport(result) + "\n");

      if (result.status === "completed" && result.failures.length === 0) {
        console.log("✓ Repair completed successfully");
        exitCode = 0;
      } else if (result.status === "completed") {
        console.log(`⚠ Repair completed with ${result.failures.length} failures`);
        exitCode = 1;
      } else {
        console.log(`✗ Repair failed or incomplete`);
        exitCode = 1;
      }

      if (!args.dryRun && result.journal.length > 0) {
        console.log(`\nRollback available: npm run orphan-repair -- --id ${checkpointId} --rollback`);
      }
    }

    await dataSource.destroy();
    process.exit(exitCode);
  } catch (error) {
    console.error(`\n✗ Orphan repair execution failed: ${(error as Error).message}`);
    
    const cp = await store.load(checkpointId).catch(() => null);
    if (cp) {
      console.error(
        `\nCheckpoint '${checkpointId}' is resumable at cursor ${cp.cursor ?? "(start)"}.`,
      );
      console.error(`Run with the same ID to continue from this point.`);
    }

    await dataSource.destroy().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}

import { BackfillCheckpoint } from "src/common/backfill/backfill-job";

export const DEFAULT_CHECKPOINT_DIR = ".backfill";

export const BACKFILL_USAGE = `Operator-safe backfill tool (#209)

Usage:
  npm run backfill -- --job <name>                   dry-run preview (default, writes nothing)
  npm run backfill -- --job <name> --id <run> --apply   write changes under a fresh checkpoint id
  npm run backfill -- --job <name> --id <run> --report  print the stored checkpoint and exit
  npm run backfill -- --job <name> --id <run> --rollback undo applied records (newest first)
  npm run backfill -- --job <name> --id <run> --restart --force  discard the checkpoint and start over
  npm run backfill -- --list                         list checkpoints

Options:
  --job <name>            backfill to run: notification-channels (required unless --list)
  --id <run>              checkpoint id for this run; defaults to --job. Use a fresh
                           id when applying a previewed run (e.g. notification-channels-apply)
  --apply                 write changes; without it the run is a dry-run preview
  --batch-size <n>        records per scan batch (default 100)
  --diff-limit <n>        max diff entries kept in the checkpoint (default 500)
  --checkpoint-dir <path> checkpoint directory (default .backfill)
  --report                print the stored checkpoint without running
  --rollback              restore journaled undo payloads newest-first
  --restart               discard an existing checkpoint before running (--force
                          required when it holds rollback data)
  --list                  list checkpointed ids
  --help, -h              show this help

Exit codes: 0 success (no failed records), 1 job failed or records failed, 2 usage error`;

export interface BackfillCliArgs {
  job?: string;
  id?: string;
  apply: boolean;
  report: boolean;
  rollback: boolean;
  restart: boolean;
  force: boolean;
  list: boolean;
  help: boolean;
  batchSize: number;
  diffLimit: number;
  checkpointDir: string;
}

function parsePositiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got '${raw}'`);
  }
  return value;
}

export function parseBackfillArgs(argv: string[]): BackfillCliArgs {
  const args: BackfillCliArgs = {
    apply: false,
    report: false,
    rollback: false,
    restart: false,
    force: false,
    list: false,
    help: false,
    batchSize: 100,
    diffLimit: 500,
    checkpointDir: DEFAULT_CHECKPOINT_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--job":
        args.job = argv[++i];
        if (!args.job) throw new Error("--job requires a value");
        break;
      case "--id":
        args.id = argv[++i];
        if (!args.id) throw new Error("--id requires a value");
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--report":
        args.report = true;
        break;
      case "--rollback":
        args.rollback = true;
        break;
      case "--restart":
        args.restart = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--batch-size":
        args.batchSize = parsePositiveInt("--batch-size", argv[++i] ?? "");
        break;
      case "--diff-limit":
        args.diffLimit = parsePositiveInt("--diff-limit", argv[++i] ?? "");
        break;
      case "--checkpoint-dir":
        args.checkpointDir = argv[++i];
        if (!args.checkpointDir)
          throw new Error("--checkpoint-dir requires a value");
        break;
      default:
        throw new Error(`Unknown argument '${token}'`);
    }
  }

  const modes = [args.list, args.report, args.rollback].filter(Boolean).length;
  if (modes > 1)
    throw new Error("--list, --report and --rollback are mutually exclusive");
  if (args.id && !args.job && !args.help && !args.list) {
    throw new Error(
      "--id requires --job (it selects a checkpoint of that backfill)",
    );
  }
  if (!args.list && !args.help && !args.job)
    throw new Error("--job is required");
  if (args.list && args.job) throw new Error("--list does not take --job");
  if (args.list && args.id) throw new Error("--list does not take --id");
  if (args.restart && (args.list || args.report || args.rollback)) {
    throw new Error(
      "--restart cannot be combined with --list, --report or --rollback",
    );
  }
  if (args.apply && (args.report || args.rollback || args.list)) {
    throw new Error(
      "--apply cannot be combined with --report, --rollback or --list",
    );
  }
  if (args.force && !args.restart)
    throw new Error("--force only applies to --restart");

  return args;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return JSON.stringify(value);
}

/** Checkpoint id for a parsed invocation: `--id`, else the `--job` name. */
export function resolveCheckpointId(args: BackfillCliArgs): string {
  return args.id ?? args.job!;
}

export function formatBackfillReport(checkpoint: BackfillCheckpoint): string {
  const lines: string[] = [];
  lines.push(
    `Backfill job "${checkpoint.jobId}" (${checkpoint.job}) — ${checkpoint.status}` +
      `${checkpoint.dryRun ? " [dry-run preview]" : ""}`,
  );
  lines.push(`  scanned        ${checkpoint.scanned}`);
  lines.push(`  planned        ${checkpoint.planned}`);
  lines.push(`  applied        ${checkpoint.applied}`);
  lines.push(`  skipped        ${checkpoint.skipped} (already up to date)`);
  lines.push(
    `  conflicts      ${checkpoint.conflicts} (concurrent change; not written)`,
  );
  lines.push(`  failures       ${checkpoint.failures.length}`);
  lines.push(
    `  journal        ${checkpoint.journal.length} record(s) with rollback data`,
  );
  lines.push(`  cursor         ${checkpoint.cursor ?? "(end)"}`);
  if (checkpoint.error) lines.push(`  error          ${checkpoint.error}`);

  if (checkpoint.diffs.length) {
    lines.push(
      `  diffs (${checkpoint.diffs.length}` +
        `${checkpoint.diffTruncated ? `, +${checkpoint.diffTruncated} more not shown` : ""}):`,
    );
    for (const diff of checkpoint.diffs) {
      lines.push(
        `    - ${diff.recordId} ${diff.field}: ${formatValue(diff.before)} -> ${formatValue(diff.after)}`,
      );
    }
  } else if (checkpoint.planned === 0) {
    lines.push("  diffs          none — no records need backfill");
  }

  if (checkpoint.failures.length) {
    lines.push(`  failed records (${checkpoint.failures.length}):`);
    for (const failure of checkpoint.failures) {
      lines.push(
        `    - ${failure.recordId} [${failure.phase}] ${failure.error}`,
      );
    }
  }

  return lines.join("\n");
}

#!/usr/bin/env ts-node
/**
 * Operator-safe backfill CLI (#209).
 *
 * Previews changes (dry-run diff, default), writes them with resumable
 * checkpoints, reports skipped and failed records, and rolls applied records
 * back from the journal. Checkpoints live as JSON files under `.backfill/`
 * (git-ignored), so an interrupted run resumes from its last committed cursor.
 *
 * Usage: see `npm run backfill -- --help` or docs/BACKFILL.md.
 *
 * Exit codes: 0 success (no failed records), 1 job failed or records failed,
 * 2 usage error.
 */
import dataSource from "../src/config/typeorm.config";
import { BackfillCheckpoint, BackfillJob } from "../src/common/backfill/backfill-job";
import {
  BACKFILL_USAGE,
  formatBackfillReport,
  parseBackfillArgs,
  resolveCheckpointId,
} from "../src/common/backfill/backfill-cli";
import { FileCheckpointStore } from "../src/common/backfill/file-checkpoint-store";
import { Role } from "../src/common/guard/roles.enum";
import {
  NOTIFICATION_CHANNELS_JOB,
  NotificationChannelsBackfillAdapter,
  TypeormNotificationChannelsRepository,
} from "../src/notifications/backfill/notification-channels.backfill";

function buildJob(jobName: string, store: FileCheckpointStore): BackfillJob<unknown> {
  switch (jobName) {
    case NOTIFICATION_CHANNELS_JOB:
      return new BackfillJob(
        new NotificationChannelsBackfillAdapter(
          new TypeormNotificationChannelsRepository(dataSource),
        ),
        store,
        { jobName },
      );
    default:
      throw new Error(`Unknown backfill '${jobName}'`);
  }
}

function operator() {
  return {
    id: process.env.BACKFILL_OPERATOR_ID ?? process.env.USER ?? "operator",
    roles: [Role.MAINTAINER],
  };
}

function summarize(checkpoint: BackfillCheckpoint): number {
  console.log(formatBackfillReport(checkpoint));
  return checkpoint.status === "completed" && checkpoint.failures.length === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseBackfillArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${BACKFILL_USAGE}`);
    process.exit(2);
  }

  if (args.help) {
    console.log(BACKFILL_USAGE);
    process.exit(0);
  }

  const store = new FileCheckpointStore(args.checkpointDir);

  if (args.list) {
    const jobs = store.list();
    if (!jobs.length) {
      console.log(`No backfill checkpoints in ${args.checkpointDir}/`);
    }
    for (const jobId of jobs) {
      const checkpoint = await store.load(jobId);
      console.log(`${jobId}\t${checkpoint?.job ?? "?"}\t${checkpoint?.status ?? "?"}`);
    }
    process.exit(0);
  }

  const checkpointId = resolveCheckpointId(args);

  if (args.report) {
    const checkpoint = await store.load(checkpointId);
    if (!checkpoint) {
      console.error(`No checkpoint for backfill job '${checkpointId}'`);
      process.exit(1);
    }
    console.log(formatBackfillReport(checkpoint));
    process.exit(0);
  }

  let job: BackfillJob<unknown>;
  try {
    job = buildJob(args.job!, store);
  } catch (error) {
    console.error(`${(error as Error).message}\nKnown backfills: ${NOTIFICATION_CHANNELS_JOB}`);
    process.exit(2);
  }

  if (args.restart) {
    const existing = await store.load(checkpointId);
    if (existing && (existing.journal.length > 0 || existing.applied > 0) && !args.force) {
      console.error(
        `Checkpoint '${checkpointId}' holds rollback data for ${existing.journal.length} record(s); ` +
          `re-running with --restart would discard it — pass --restart --force to proceed`,
      );
      process.exit(2);
    }
    await store.delete(checkpointId);
    console.log(`Discarded checkpoint '${checkpointId}'`);
  }

  let exitCode = 1;
  try {
    await dataSource.initialize();
    if (args.rollback) {
      const done = await job.rollback(operator(), checkpointId);
      console.log(formatBackfillReport(done));
      exitCode = 0;
    } else {
      const checkpoint = await job.run(operator(), checkpointId, {
        dryRun: !args.apply,
        batchSize: args.batchSize,
        diffLimit: args.diffLimit,
      });
      exitCode = summarize(checkpoint);
    }
  } catch (error) {
    console.error(`${(error as Error).message}`);
    if (checkpointId) {
      const failed = await store.load(checkpointId).catch(() => null);
      if (failed) {
        console.error(
          `Checkpoint '${checkpointId}' is resumable at cursor ${failed.cursor ?? "(start)"} — ` +
            `re-run the same command to continue, or --rollback to undo applied records`,
        );
      }
    }
    exitCode = 1;
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
  process.exit(exitCode);
}

void main();

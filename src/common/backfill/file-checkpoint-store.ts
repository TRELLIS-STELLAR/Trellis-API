import * as fs from "fs";
import * as path from "path";
import {
  BackfillCheckpoint,
  BackfillCheckpointStore,
} from "src/common/backfill/backfill-job";

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Durable checkpoint store for the backfill CLI (#209).
 *
 * One JSON file per job under a shared directory (default `.backfill/`,
 * git-ignored). Saves are atomic (write to a temp file in the same directory,
 * then rename), so a crash mid-save never corrupts an existing checkpoint.
 * Job ids are validated against a strict pattern so a checkpoint path can
 * never escape the directory.
 */
export class FileCheckpointStore implements BackfillCheckpointStore {
  constructor(private readonly dir: string) {}

  async load(jobId: string): Promise<BackfillCheckpoint | null> {
    const file = this.fileFor(jobId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: BackfillCheckpoint;
    try {
      parsed = JSON.parse(raw) as BackfillCheckpoint;
    } catch {
      throw new Error(
        `Backfill checkpoint ${file} is not valid JSON; restore it from a backup or delete it to start over with --restart --force`,
      );
    }
    if (!parsed || typeof parsed !== "object" || parsed.jobId !== jobId) {
      throw new Error(
        `Backfill checkpoint ${file} is corrupt (jobId mismatch); restore it from a backup or delete it to start over with --restart --force`,
      );
    }
    return parsed;
  }

  async save(checkpoint: BackfillCheckpoint): Promise<void> {
    const file = this.fileFor(checkpoint.jobId);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  /** Removes a checkpoint (only used by `--restart --force`). */
  async delete(jobId: string): Promise<void> {
    fs.rmSync(this.fileFor(jobId), { force: true });
  }

  /** Job ids that have a checkpoint file, sorted. */
  list(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  }

  private fileFor(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new Error(
        `Invalid backfill job id '${jobId}'; use 1-64 characters from [A-Za-z0-9._-] starting with a letter or digit`,
      );
    }
    return path.join(this.dir, `${jobId}.json`);
  }
}

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BackfillCheckpoint } from "./backfill-job";
import { FileCheckpointStore } from "./file-checkpoint-store";

function checkpoint(jobId: string): BackfillCheckpoint {
  return {
    jobId,
    job: "notification-channels",
    status: "running",
    dryRun: false,
    cursor: "abc",
    scanned: 3,
    planned: 1,
    applied: 1,
    skipped: 2,
    conflicts: 0,
    diffs: [
      { recordId: "n1", field: "channels", before: null, after: ["email"] },
    ],
    diffTruncated: 0,
    failures: [],
    journal: [{ recordId: "n1", undo: { before: null, after: ["email"] } }],
  };
}

describe("FileCheckpointStore (#209)", () => {
  let dir: string;
  let store: FileCheckpointStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-backfill-"));
    store = new FileCheckpointStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a checkpoint through save and load", async () => {
    await store.save(checkpoint("job-1"));
    const loaded = await store.load("job-1");
    expect(loaded).toEqual(checkpoint("job-1"));
  });

  it("returns null for a job that has never run", async () => {
    expect(await store.load("missing")).toBeNull();
  });

  it("writes atomically and leaves no temp files behind", async () => {
    await store.save(checkpoint("job-1"));
    await store.save(checkpoint("job-1"));
    expect(fs.readdirSync(dir)).toEqual(["job-1.json"]);
  });

  it("creates the checkpoint directory on demand", async () => {
    const nested = new FileCheckpointStore(path.join(dir, "a", "b"));
    await nested.save(checkpoint("job-1"));
    expect(fs.existsSync(path.join(dir, "a", "b", "job-1.json"))).toBe(true);
  });

  it("fails loudly on a corrupt checkpoint file", async () => {
    fs.writeFileSync(path.join(dir, "job-1.json"), "{not json");
    await expect(store.load("job-1")).rejects.toThrow(
      /not valid JSON.*--restart --force/s,
    );
  });

  it("fails loudly when the file holds a different job id", async () => {
    fs.writeFileSync(
      path.join(dir, "job-1.json"),
      JSON.stringify(checkpoint("job-2")),
    );
    await expect(store.load("job-1")).rejects.toThrow(/corrupt/);
  });

  it("rejects job ids that could escape the checkpoint directory", async () => {
    for (const bad of ["../evil", "a/b", "", ".hidden", "a b"]) {
      await expect(store.save(checkpoint(bad))).rejects.toThrow(
        /Invalid backfill job id/,
      );
      await expect(store.load(bad)).rejects.toThrow(/Invalid backfill job id/);
    }
    expect(fs.existsSync(path.join(dir, "..", "evil.json"))).toBe(false);
  });

  it("deletes checkpoints and lists the remaining job ids", async () => {
    await store.save(checkpoint("job-b"));
    await store.save(checkpoint("job-a"));
    expect(store.list()).toEqual(["job-a", "job-b"]);

    await store.delete("job-a");
    expect(store.list()).toEqual(["job-b"]);
    expect(await store.load("job-a")).toBeNull();

    await store.delete("never-ran");
    expect(store.list()).toEqual(["job-b"]);
  });

  it("lists an empty checkpoint directory as empty", () => {
    expect(new FileCheckpointStore(path.join(dir, "nope")).list()).toEqual([]);
  });
});

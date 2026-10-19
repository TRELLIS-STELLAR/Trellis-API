import { BackfillCheckpoint } from "./backfill-job";
import {
  BACKFILL_USAGE,
  formatBackfillReport,
  parseBackfillArgs,
  resolveCheckpointId,
} from "./backfill-cli";

describe("parseBackfillArgs (#209)", () => {
  it("defaults to a dry-run preview with safe batch and diff limits", () => {
    const args = parseBackfillArgs(["--job", "notification-channels"]);
    expect(args).toMatchObject({
      job: "notification-channels",
      apply: false,
      report: false,
      rollback: false,
      restart: false,
      force: false,
      list: false,
      help: false,
      batchSize: 100,
      diffLimit: 500,
      checkpointDir: ".backfill",
    });
  });

  it("parses every flag", () => {
    const args = parseBackfillArgs([
      "--job",
      "notification-channels",
      "--id",
      "notification-channels-apply",
      "--apply",
      "--batch-size",
      "5",
      "--diff-limit",
      "10",
      "--checkpoint-dir",
      "/tmp/cp",
    ]);
    expect(args).toMatchObject({
      job: "notification-channels",
      id: "notification-channels-apply",
      apply: true,
      batchSize: 5,
      diffLimit: 10,
      checkpointDir: "/tmp/cp",
    });
  });

  it("defaults the checkpoint id to the job name", () => {
    expect(
      resolveCheckpointId(
        parseBackfillArgs(["--job", "notification-channels"]),
      ),
    ).toBe("notification-channels");
    expect(
      resolveCheckpointId(
        parseBackfillArgs([
          "--job",
          "notification-channels",
          "--id",
          "notification-channels-apply",
        ]),
      ),
    ).toBe("notification-channels-apply");
  });

  it("allows --help without a job", () => {
    expect(parseBackfillArgs(["--help"]).help).toBe(true);
    expect(parseBackfillArgs(["-h"]).help).toBe(true);
  });

  it("allows --list without a job", () => {
    const args = parseBackfillArgs(["--list"]);
    expect(args.list).toBe(true);
    expect(args.job).toBeUndefined();
  });

  const invalidArgs: Array<[string[], RegExp]> = [
    [["--unknown"], /Unknown argument '--unknown'/],
    [[], /--job is required/],
    [["--job"], /--job requires a value/],
    [
      ["--job", "x", "--batch-size", "0"],
      /--batch-size must be a positive integer/,
    ],
    [
      ["--job", "x", "--diff-limit", "abc"],
      /--diff-limit must be a positive integer/,
    ],
    [["--list", "--job", "x"], /--list does not take --job/],
    [["--list", "--id", "x"], /--list does not take --id/],
    [["--id", "x"], /--id requires --job/],
    [["--list", "--report"], /mutually exclusive/],
    [["--list", "--rollback"], /mutually exclusive/],
    [["--job", "x", "--apply", "--report"], /--apply cannot be combined/],
    [["--job", "x", "--restart", "--rollback"], /--restart cannot be combined/],
    [["--job", "x", "--force"], /--force only applies to --restart/],
    [["--job", "x", "--checkpoint-dir"], /--checkpoint-dir requires a value/],
  ];
  it.each(invalidArgs)("rejects invalid arguments (%#)", (argv, message) => {
    expect(() => parseBackfillArgs(argv)).toThrow(message);
  });

  it("exports the help text", () => {
    expect(BACKFILL_USAGE).toContain("npm run backfill");
    expect(BACKFILL_USAGE).toContain("Exit codes:");
  });
});

describe("formatBackfillReport (#209)", () => {
  const base: BackfillCheckpoint = {
    jobId: "notification-channels-1",
    job: "notification-channels",
    status: "completed",
    dryRun: true,
    cursor: null,
    scanned: 6,
    planned: 4,
    applied: 0,
    skipped: 2,
    conflicts: 1,
    diffs: [
      { recordId: "n1", field: "channels", before: null, after: ["email"] },
    ],
    diffTruncated: 3,
    failures: [{ recordId: "n9", phase: "apply", error: "boom" }],
    journal: [],
    error: "boom",
  };

  it("renders counters, diffs, truncation and failed records", () => {
    const text = formatBackfillReport(base);
    expect(text).toContain(
      'Backfill job "notification-channels-1" (notification-channels) — completed [dry-run preview]',
    );
    expect(text).toContain("scanned        6");
    expect(text).toContain("applied        0");
    expect(text).toContain("skipped        2 (already up to date)");
    expect(text).toContain("conflicts      1 (concurrent change; not written)");
    expect(text).toContain("diffs (1, +3 more not shown):");
    expect(text).toContain('n1 channels: null -> ["email"]');
    expect(text).toContain("failed records (1):");
    expect(text).toContain("n9 [apply] boom");
    expect(text).toContain("error          boom");
    expect(text).toContain("cursor         (end)");
  });

  it("says so when nothing needs backfill", () => {
    const text = formatBackfillReport({
      ...base,
      planned: 0,
      diffs: [],
      diffTruncated: 0,
      failures: [],
      error: undefined,
      dryRun: false,
      cursor: "abc",
    });
    expect(text).toContain("diffs          none — no records need backfill");
    expect(text).not.toContain("failed records");
    expect(text).toContain("cursor         abc");
  });
});

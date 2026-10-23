import {
  ConflictException,
  ForbiddenException,
} from "src/common/errors/app.exception";
import { Role } from "src/common/guard/roles.enum";
import {
  BACKFILL_CONFLICT,
  BackfillAdapter,
  BackfillChange,
  BackfillCheckpoint,
  BackfillCheckpointStore,
  BackfillJob,
  BackfillPage,
} from "./backfill-job";

interface Row {
  id: string;
  label: string | null;
}

const operator = { id: "op-1", roles: [Role.MAINTAINER] };

function seedRows(): Row[] {
  return [
    { id: "r1", label: null },
    { id: "r2", label: "keep" },
    { id: "r3", label: null },
    { id: "r4", label: "keep" },
    { id: "r5", label: null },
    { id: "r6", label: null },
  ];
}

class Fixture implements BackfillAdapter<Row>, BackfillCheckpointStore {
  rows = seedRows();
  checkpoints = new Map<string, BackfillCheckpoint>();
  scanCursors: Array<string | null> = [];
  writeCalls: Record<string, number> = {};
  failScanOnCall: number | null = null;
  failSaveOnCall: number | null = null;
  failRestoreFor: string | null = null;
  planFailures: Record<string, string> = {};
  applyFailures: Record<string, number> = {};
  conflictFor = new Set<string>();
  private scanCalls = 0;
  private saveCalls = 0;

  async scan(cursor: string | null, limit: number): Promise<BackfillPage<Row>> {
    this.scanCalls += 1;
    this.scanCursors.push(cursor);
    if (this.failScanOnCall === this.scanCalls)
      throw new Error("scan unavailable");
    const start = cursor === null ? 0 : Number(cursor);
    const records = this.rows
      .slice(start, start + limit)
      .map((r) => ({ ...r }));
    const next = start + limit;
    return {
      records,
      nextCursor: next < this.rows.length ? String(next) : null,
    };
  }

  recordId(record: Row): string {
    return record.id;
  }

  plan(record: Row): BackfillChange | null {
    const plannedError = this.planFailures[record.id];
    if (plannedError) throw new Error(plannedError);
    if (record.label != null) return null;
    return {
      recordId: record.id,
      field: "label",
      before: null,
      after: `derived:${record.id}`,
      reason: "missing label",
    };
  }

  async apply(record: Row, change: BackfillChange): Promise<unknown> {
    this.writeCalls[record.id] = (this.writeCalls[record.id] ?? 0) + 1;
    if ((this.applyFailures[record.id] ?? 0) > 0) {
      this.applyFailures[record.id] -= 1;
      throw new Error(`transient failure on ${record.id}`);
    }
    if (this.conflictFor.has(record.id)) return BACKFILL_CONFLICT;
    const live = this.rows.find((r) => r.id === record.id)!;
    live.label = change.after as string;
    return undefined;
  }

  async restore(recordId: string, undo: unknown): Promise<void> {
    if (this.failRestoreFor === recordId)
      throw new Error("restore unavailable");
    const { before } = undo as { before: unknown };
    const live = this.rows.find((r) => r.id === recordId)!;
    live.label = before as string | null;
  }

  async load(jobId: string) {
    const found = this.checkpoints.get(jobId);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async save(checkpoint: BackfillCheckpoint) {
    this.saveCalls += 1;
    if (this.failSaveOnCall === this.saveCalls)
      throw new Error("checkpoint store down");
    this.checkpoints.set(
      checkpoint.jobId,
      JSON.parse(JSON.stringify(checkpoint)),
    );
  }
}

describe("BackfillJob (#209)", () => {
  let fx: Fixture;
  let job: BackfillJob<Row>;

  beforeEach(() => {
    fx = new Fixture();
    job = new BackfillJob<Row>(fx, fx, { jobName: "labels" });
  });

  it("dry run previews diffs without changing any record", async () => {
    const result = await job.run(operator, "job-dry", {
      dryRun: true,
      batchSize: 2,
    });

    expect(result).toMatchObject({
      status: "completed",
      dryRun: true,
      scanned: 6,
      planned: 4,
      skipped: 2,
      applied: 0,
      conflicts: 0,
    });
    expect(fx.rows).toEqual(seedRows());
    expect(result.journal).toEqual([]);
    expect(result.diffs).toEqual([
      { recordId: "r1", field: "label", before: null, after: "derived:r1" },
      { recordId: "r3", field: "label", before: null, after: "derived:r3" },
      { recordId: "r5", field: "label", before: null, after: "derived:r5" },
      { recordId: "r6", field: "label", before: null, after: "derived:r6" },
    ]);
    expect(result.diffTruncated).toBe(0);
  });

  it("applies changes, journals undo payloads and reports skipped records", async () => {
    const result = await job.run(operator, "job-1", {
      dryRun: false,
      batchSize: 2,
    });

    expect(result).toMatchObject({
      status: "completed",
      scanned: 6,
      planned: 4,
      applied: 4,
      skipped: 2,
      conflicts: 0,
      failures: [],
    });
    expect(result.diffs).toHaveLength(4);
    expect(result.journal.map((j) => j.recordId)).toEqual([
      "r1",
      "r3",
      "r5",
      "r6",
    ]);
    expect(result.journal[0].undo).toEqual({
      before: null,
      after: "derived:r1",
    });
    expect(fx.rows.map((r) => r.label)).toEqual([
      "derived:r1",
      "keep",
      "derived:r3",
      "keep",
      "derived:r5",
      "derived:r6",
    ]);
  });

  it("caps the diff preview and counts the entries it drops", async () => {
    const result = await job.run(operator, "job-dry", {
      dryRun: true,
      diffLimit: 2,
    });
    expect(result.diffs).toHaveLength(2);
    expect(result.diffTruncated).toBe(2);
    expect(result.planned).toBe(4);
  });

  it("re-running a completed job is a no-op", async () => {
    await job.run(operator, "job-1", { dryRun: false, batchSize: 2 });
    const calls = { ...fx.writeCalls };
    const scans = fx.scanCursors.length;

    const again = await job.run(operator, "job-1", {
      dryRun: false,
      batchSize: 2,
    });
    expect(again.status).toBe("completed");
    expect(fx.writeCalls).toEqual(calls);
    expect(fx.scanCursors).toHaveLength(scans);
  });

  it("refuses to resume a dry-run preview in apply mode and vice versa", async () => {
    await job.run(operator, "job-1", { dryRun: true, batchSize: 2 });
    await expect(
      job.run(operator, "job-1", { dryRun: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(job.run(operator, "job-1", { dryRun: false })).rejects.toThrow(
      /dry-run preview/,
    );

    const applyJob = new BackfillJob<Row>(fx, fx, { jobName: "labels" });
    await applyJob.run(operator, "job-2", { dryRun: false, batchSize: 2 });
    await expect(
      applyJob.run(operator, "job-2", { dryRun: true }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects resuming a checkpoint created by a different adapter", async () => {
    await job.run(operator, "job-1", { dryRun: true });
    const other = new BackfillJob<Row>(fx, fx, { jobName: "something-else" });
    await expect(
      other.run(operator, "job-1", { dryRun: true }),
    ).rejects.toThrow(/belongs to 'labels'/);
  });

  it("resumes from the last committed cursor after a scan failure", async () => {
    fx.failScanOnCall = 2;
    await expect(
      job.run(operator, "job-1", { dryRun: false, batchSize: 2 }),
    ).rejects.toThrow("scan unavailable");

    const saved = fx.checkpoints.get("job-1")!;
    expect(saved).toMatchObject({ status: "failed", cursor: "2", scanned: 2 });

    fx.scanCursors = [];
    const resumed = await job.run(operator, "job-1", {
      dryRun: false,
      batchSize: 2,
    });
    expect(fx.scanCursors[0]).toBe("2");
    expect(resumed).toMatchObject({
      status: "completed",
      scanned: 6,
      applied: 4,
    });
    expect(Object.values(fx.writeCalls).every((n) => n === 1)).toBe(true);
  });

  it("keeps rollback data for records written before a checkpoint-save failure", async () => {
    // Save #1 is the write-ahead journal for r1; #2 is the end of batch 1.
    // r1 is already written when #2 fails, so the committed checkpoint must
    // still carry its undo payload.
    fx.failSaveOnCall = 2;
    await expect(
      job.run(operator, "job-1", { dryRun: false, batchSize: 2 }),
    ).rejects.toThrow("checkpoint store down");

    const saved = fx.checkpoints.get("job-1")!;
    expect(saved.status).toBe("failed");
    expect(saved.journal.map((j) => j.recordId)).toEqual(["r1"]);
    expect(fx.rows[0].label).toBe("derived:r1");

    const resumed = await job.run(operator, "job-1", {
      dryRun: false,
      batchSize: 2,
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.journal.map((j) => j.recordId)).toEqual([
      "r1",
      "r3",
      "r5",
      "r6",
    ]);
    expect(Object.values(fx.writeCalls).every((n) => n === 1)).toBe(true);

    const rolledBack = await job.rollback(operator, "job-1");
    expect(rolledBack).toMatchObject({
      status: "rolled_back",
      journal: [],
      applied: 0,
    });
    expect(fx.rows).toEqual(seedRows());
  });

  it("records a plan failure and keeps scanning", async () => {
    fx.planFailures = { r5: "unplannable record" };
    const result = await job.run(operator, "job-1", {
      dryRun: false,
      batchSize: 2,
    });

    expect(result.status).toBe("completed");
    expect(result.failures).toEqual([
      { recordId: "r5", phase: "plan", error: "unplannable record" },
    ]);
    expect(result.applied).toBe(3);
    expect(fx.rows.find((r) => r.id === "r5")).toEqual({
      id: "r5",
      label: null,
    });
    expect(result.scanned).toBe(6);
  });

  it("retries a transient apply failure and records a persistent one", async () => {
    fx.applyFailures = { r1: 2, r5: 99 };
    const result = await job.run(operator, "job-1", {
      dryRun: false,
      batchSize: 3,
      maxApplyRetries: 2,
    });

    expect(result.status).toBe("completed");
    expect(fx.writeCalls.r1).toBe(3);
    expect(result.applied).toBe(3);
    expect(result.failures).toEqual([
      { recordId: "r5", phase: "apply", error: "transient failure on r5" },
    ]);
  });

  it("counts guarded-write conflicts without journaling them", async () => {
    fx.conflictFor.add("r3");
    const result = await job.run(operator, "job-1", {
      dryRun: false,
      batchSize: 2,
    });

    expect(result).toMatchObject({
      status: "completed",
      planned: 4,
      applied: 3,
      conflicts: 1,
    });
    expect(result.journal.map((j) => j.recordId)).toEqual(["r1", "r5", "r6"]);
    expect(result.diffs.map((d) => d.recordId)).toEqual(["r1", "r5", "r6"]);
    expect(fx.rows.find((r) => r.id === "r3")).toEqual({
      id: "r3",
      label: null,
    });
  });

  it("rejects callers without maintenance permission before touching data", async () => {
    const user = { id: "u-1", roles: [Role.USER] };
    await expect(job.run(user, "job-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(job.rollback(user, "job-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(job.report(user, "job-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(fx.scanCursors).toEqual([]);
    expect(fx.checkpoints.size).toBe(0);
  });

  it("refuses to run the same job concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalScan = fx.scan.bind(fx);
    fx.scan = async (cursor, limit) => {
      await gate;
      return originalScan(cursor, limit);
    };

    const first = job.run(operator, "job-1", { dryRun: false });
    await expect(
      job.run(operator, "job-1", { dryRun: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  it("reports the stored checkpoint without running", async () => {
    expect(await job.report(operator, "missing")).toBeNull();
    await job.run(operator, "job-1", { dryRun: true });
    const report = await job.report(operator, "job-1");
    expect(report).toMatchObject({
      jobId: "job-1",
      status: "completed",
      planned: 4,
    });
  });

  describe("rollback", () => {
    it("restores every journaled record to its before-image", async () => {
      await job.run(operator, "job-1", { dryRun: false, batchSize: 2 });
      const result = await job.rollback(operator, "job-1");

      expect(result).toMatchObject({
        status: "rolled_back",
        journal: [],
        applied: 0,
      });
      expect(fx.rows).toEqual(seedRows());
      await expect(job.run(operator, "job-1")).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("can be re-run after an interrupted rollback", async () => {
      await job.run(operator, "job-1", { dryRun: false, batchSize: 2 });
      fx.failRestoreFor = "r1"; // restored last (journal unwinds newest-first)
      await expect(job.rollback(operator, "job-1")).rejects.toThrow(
        "restore unavailable",
      );

      expect(
        fx.checkpoints.get("job-1")!.journal.map((j) => j.recordId),
      ).toEqual(["r1"]);
      expect(fx.rows.find((r) => r.id === "r1")!.label).toBe("derived:r1");
      expect(fx.rows.find((r) => r.id === "r3")!.label).toBeNull();

      fx.failRestoreFor = null;
      await job.rollback(operator, "job-1");
      expect(fx.rows).toEqual(seedRows());
    });

    it("rejects an unknown job", async () => {
      await expect(job.rollback(operator, "nope")).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});

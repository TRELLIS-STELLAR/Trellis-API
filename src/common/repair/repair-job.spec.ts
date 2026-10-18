import { ConflictException, ForbiddenException } from "../errors/app.exception";
import { Role } from "../guard/roles.enum";
import {
  RepairAdapter,
  RepairCheckpoint,
  RepairCheckpointStore,
  RepairFinding,
  RepairJob,
} from "./repair-job";

interface Row {
  id: string;
  parentId: string | null;
  status: "active" | "archived";
  archivedAt: string | null;
}

const maintainer = { id: "m-1", roles: [Role.MAINTAINER] };

function seedRows(): Row[] {
  const row = (id: string, parentId: string | null, status: Row["status"], archivedAt: string | null): Row => ({
    id,
    parentId,
    status,
    archivedAt,
  });
  return [
    row("r1", "p1", "active", null),
    row("r2", "missing", "active", null), // orphaned
    row("r3", "p1", "archived", null), // inconsistent
    row("r4", "p2", "active", null),
    row("r5", "gone", "active", null), // orphaned
    row("r6", null, "active", null),
  ];
}

class Fixture implements RepairAdapter<Row>, RepairCheckpointStore {
  rows = seedRows();
  parents = new Set(["p1", "p2"]);
  checkpoints = new Map<string, RepairCheckpoint>();
  scanCursors: Array<string | null> = [];
  repairCalls: Record<string, number> = {};
  failScanOnCall: number | null = null;
  failSaveOnCall: number | null = null;
  failRestoreFor: string | null = null;
  repairFailures: Record<string, number> = {};
  private scanCalls = 0;
  private saveCalls = 0;

  async scan(cursor: string | null, limit: number) {
    this.scanCalls += 1;
    this.scanCursors.push(cursor);
    if (this.failScanOnCall === this.scanCalls) throw new Error("scan unavailable");
    const start = cursor === null ? 0 : Number(cursor);
    const records = this.rows.slice(start, start + limit).map((r) => ({ ...r }));
    const next = start + limit;
    return { records, nextCursor: next < this.rows.length ? String(next) : null };
  }

  detect(row: Row): RepairFinding | null {
    if (row.status !== "archived" && row.parentId !== null && !this.parents.has(row.parentId)) {
      return { recordId: row.id, kind: "orphaned", reason: `missing parent ${row.parentId}` };
    }
    if (row.status === "archived" && !row.archivedAt) {
      return { recordId: row.id, kind: "inconsistent", reason: "archived without timestamp" };
    }
    return null;
  }

  async repair(row: Row): Promise<unknown> {
    this.repairCalls[row.id] = (this.repairCalls[row.id] ?? 0) + 1;
    if ((this.repairFailures[row.id] ?? 0) > 0) {
      this.repairFailures[row.id] -= 1;
      throw new Error(`transient failure on ${row.id}`);
    }
    const live = this.rows.find((r) => r.id === row.id)!;
    const before = { ...live };
    live.status = "archived";
    live.archivedAt = live.archivedAt ?? "2026-01-01T00:00:00Z";
    return before;
  }

  async restore(recordId: string, before: unknown): Promise<void> {
    if (this.failRestoreFor === recordId) throw new Error("restore unavailable");
    const index = this.rows.findIndex((r) => r.id === recordId);
    this.rows[index] = { ...(before as Row) };
  }

  async load(jobId: string) {
    const found = this.checkpoints.get(jobId);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async save(checkpoint: RepairCheckpoint) {
    this.saveCalls += 1;
    if (this.failSaveOnCall === this.saveCalls) throw new Error("checkpoint store down");
    this.checkpoints.set(checkpoint.jobId, JSON.parse(JSON.stringify(checkpoint)));
  }
}

describe("RepairJob (#266)", () => {
  let fx: Fixture;
  let job: RepairJob<Row>;

  beforeEach(() => {
    fx = new Fixture();
    job = new RepairJob<Row>(fx, fx);
  });

  it("dry run reports findings without changing any record", async () => {
    const result = await job.run(maintainer, "job-dry", { dryRun: true, batchSize: 2 });
    expect(result).toMatchObject({ status: "completed", dryRun: true, scanned: 6, detected: 3, repaired: 0 });
    expect(fx.rows).toEqual(seedRows());
    expect(result.journal).toEqual([]);
  });

  it("repairs orphaned and inconsistent records and journals before-images", async () => {
    const result = await job.run(maintainer, "job-1", { batchSize: 2 });

    expect(result).toMatchObject({ status: "completed", scanned: 6, repaired: 3, cursor: null });
    expect(result.failures).toEqual([]);
    expect(result.journal.map((j) => j.recordId)).toEqual(["r2", "r3", "r5"]);
    expect(fx.rows.every((r) => fx.detect(r) === null)).toBe(true);
  });

  it("re-running a completed job is a no-op", async () => {
    await job.run(maintainer, "job-1", { batchSize: 2 });
    const calls = { ...fx.repairCalls };
    const scans = fx.scanCursors.length;

    const again = await job.run(maintainer, "job-1", { batchSize: 2 });
    expect(again.status).toBe("completed");
    expect(fx.repairCalls).toEqual(calls);
    expect(fx.scanCursors).toHaveLength(scans);
  });

  it("resumes from the last committed cursor after a scan failure", async () => {
    fx.failScanOnCall = 2;
    await expect(job.run(maintainer, "job-1", { batchSize: 2 })).rejects.toThrow("scan unavailable");

    const saved = fx.checkpoints.get("job-1")!;
    expect(saved).toMatchObject({ status: "failed", cursor: "2", scanned: 2, repaired: 1 });

    fx.scanCursors = [];
    const resumed = await job.run(maintainer, "job-1", { batchSize: 2 });
    expect(fx.scanCursors[0]).toBe("2");
    expect(resumed).toMatchObject({ status: "completed", scanned: 6, repaired: 3 });
    expect(Object.values(fx.repairCalls).every((n) => n === 1)).toBe(true);
  });

  it("never repairs a record twice when the checkpoint store fails mid-batch", async () => {
    // Save #1 persists r2's journal entry; #2 is the end of batch 1;
    // #3 persists r3's entry in batch 2 - make that one fail.
    fx.failSaveOnCall = 3;
    await expect(job.run(maintainer, "job-1", { batchSize: 2 })).rejects.toThrow("checkpoint store down");

    const saved = fx.checkpoints.get("job-1")!;
    expect(saved.status).toBe("failed");
    expect(saved.cursor).toBe("2");
    expect(saved.journal.map((j) => j.recordId)).toEqual(["r2"]);

    const resumed = await job.run(maintainer, "job-1", { batchSize: 2 });
    expect(resumed.status).toBe("completed");
    // r3 was repaired but its journal save failed, so it is not counted or
    // journaled (documented limitation); the re-scan finds it clean and must
    // not repair it a second time.
    expect(resumed.repaired).toBe(2);
    expect(resumed.journal.map((j) => j.recordId)).toEqual(["r2", "r5"]);
    expect(fx.repairCalls.r3).toBe(1);
    expect(fx.rows.every((r) => fx.detect(r) === null)).toBe(true);
  });

  it("retries a transient repair failure and records a persistent one", async () => {
    fx.repairFailures = { r2: 2, r5: 99 };
    const result = await job.run(maintainer, "job-1", { batchSize: 3, maxRepairRetries: 2 });

    expect(result.status).toBe("completed");
    expect(fx.repairCalls.r2).toBe(3);
    expect(result.repaired).toBe(2);
    expect(result.failures).toEqual([{ recordId: "r5", error: "transient failure on r5" }]);

    // A fresh job re-detects the still-broken record and fixes it once healthy.
    fx.repairFailures = {};
    const followUp = await job.run(maintainer, "job-2", { batchSize: 3 });
    expect(followUp).toMatchObject({ repaired: 1, failures: [] });
  });

  it("rejects callers without maintenance permission before touching data", async () => {
    const user = { id: "u-1", roles: [Role.USER] };
    await expect(job.run(user, "job-1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(job.rollback(user, "job-1")).rejects.toBeInstanceOf(ForbiddenException);
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

    const first = job.run(maintainer, "job-1");
    await expect(job.run(maintainer, "job-1")).rejects.toBeInstanceOf(ConflictException);
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  it("refuses to resume a job with a different dry-run mode", async () => {
    fx.failScanOnCall = 2;
    await expect(job.run(maintainer, "job-1", { dryRun: true, batchSize: 2 })).rejects.toThrow();
    await expect(job.run(maintainer, "job-1", { dryRun: false })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  describe("rollback", () => {
    it("restores every record to its before-image", async () => {
      await job.run(maintainer, "job-1", { batchSize: 2 });
      const result = await job.rollback(maintainer, "job-1");

      expect(result).toMatchObject({ status: "rolled_back", journal: [], repaired: 0 });
      expect(fx.rows).toEqual(seedRows());
      await expect(job.run(maintainer, "job-1")).rejects.toBeInstanceOf(ConflictException);
    });

    it("can be re-run after an interrupted rollback", async () => {
      await job.run(maintainer, "job-1", { batchSize: 2 });
      fx.failRestoreFor = "r2"; // restored last (journal is unwound newest-first)
      await expect(job.rollback(maintainer, "job-1")).rejects.toThrow("restore unavailable");

      expect(fx.checkpoints.get("job-1")!.journal.map((j) => j.recordId)).toEqual(["r2"]);
      expect(fx.rows.find((r) => r.id === "r5")).toEqual(seedRows()[4]);

      fx.failRestoreFor = null;
      await job.rollback(maintainer, "job-1");
      expect(fx.rows).toEqual(seedRows());
      expect(fx.rows.filter((r) => fx.detect(r)).map((r) => r.id)).toEqual(["r2", "r3", "r5"]);
    });

    it("rejects an unknown job", async () => {
      await expect(job.rollback(maintainer, "nope")).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

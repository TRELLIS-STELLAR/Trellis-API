import {
  BACKFILL_CONFLICT,
  BackfillCheckpoint,
  BackfillCheckpointStore,
  BackfillJob,
} from "src/common/backfill/backfill-job";
import { Role } from "src/common/guard/roles.enum";
import {
  NOTIFICATION_CHANNELS_JOB,
  NotificationChannelRow,
  NotificationChannelsBackfillAdapter,
  NotificationChannelsRepository,
} from "./notification-channels.backfill";

const operator = { id: "op-1", roles: [Role.MAINTAINER] };

function seed(): Map<string, NotificationChannelRow> {
  const row = (
    id: string,
    channels: string[] | null,
    primaryChannel = "email",
  ) => ({
    id,
    channels,
    primaryChannel,
  });
  return new Map(
    [
      row("n1", null),
      row("n2", ["push", "email"]),
      row("n3", null, "sms"),
      row("n4", null),
      row("n5", []),
    ].map((r) => [r.id, r]),
  );
}

class InMemoryRepo implements NotificationChannelsRepository {
  rows = seed();
  conflictFor = new Set<string>();
  setCalls = 0;
  restoreCalls = 0;

  async page(
    cursor: string | null,
    limit: number,
  ): Promise<NotificationChannelRow[]> {
    const ids = [...this.rows.keys()].sort();
    const after = cursor ? ids.filter((id) => id > cursor) : ids;
    return after.slice(0, limit).map((id) => ({ ...this.rows.get(id)! }));
  }

  async setChannels(id: string, channels: string[]): Promise<boolean> {
    this.setCalls += 1;
    if (this.conflictFor.has(id)) return false;
    const row = this.rows.get(id);
    if (!row || row.channels != null) return false;
    row.channels = [...channels];
    return true;
  }

  async restoreChannels(
    id: string,
    expectedChannels: string[],
  ): Promise<boolean> {
    this.restoreCalls += 1;
    const row = this.rows.get(id);
    if (!row) return false;
    if (
      JSON.stringify(row.channels ?? null) !== JSON.stringify(expectedChannels)
    )
      return false;
    row.channels = null;
    return true;
  }
}

class MemoryStore implements BackfillCheckpointStore {
  checkpoints = new Map<string, BackfillCheckpoint>();

  async load(jobId: string) {
    const found = this.checkpoints.get(jobId);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async save(checkpoint: BackfillCheckpoint) {
    this.checkpoints.set(
      checkpoint.jobId,
      JSON.parse(JSON.stringify(checkpoint)),
    );
  }
}

describe("NotificationChannelsBackfillAdapter (#209)", () => {
  let repo: InMemoryRepo;
  let adapter: NotificationChannelsBackfillAdapter;

  beforeEach(() => {
    repo = new InMemoryRepo();
    adapter = new NotificationChannelsBackfillAdapter(repo);
  });

  it("pages through rows with a keyset cursor", async () => {
    const page1 = await adapter.scan(null, 2);
    expect(page1.records.map((r) => r.id)).toEqual(["n1", "n2"]);
    expect(page1.nextCursor).toBe("n2");

    const page2 = await adapter.scan(page1.nextCursor, 2);
    expect(page2.records.map((r) => r.id)).toEqual(["n3", "n4"]);
    expect(page2.nextCursor).toBe("n4");

    const page3 = await adapter.scan(page2.nextCursor, 2);
    expect(page3.records.map((r) => r.id)).toEqual(["n5"]);
    expect(page3.nextCursor).toBeNull();
  });

  it("ends cleanly when a final page is exactly full", async () => {
    repo.rows.delete("n5");
    const page1 = await adapter.scan(null, 2);
    expect(page1.nextCursor).toBe("n2");
    const page2 = await adapter.scan(page1.nextCursor, 2);
    expect(page2.records.map((r) => r.id)).toEqual(["n3", "n4"]);
    const page3 = await adapter.scan(page2.nextCursor, 2);
    expect(page3.records).toEqual([]);
    expect(page3.nextCursor).toBeNull();
  });

  it("plans a channels backfill only for legacy rows", () => {
    expect(
      adapter.plan({ id: "n1", channels: null, primaryChannel: "email" }),
    ).toEqual({
      recordId: "n1",
      field: "channels",
      before: null,
      after: ["email"],
      reason: "legacy row predates the channels column",
    });
    expect(
      adapter.plan({ id: "n2", channels: ["push"], primaryChannel: "email" }),
    ).toBeNull();
    expect(
      adapter.plan({ id: "n5", channels: [], primaryChannel: "email" }),
    ).toBeNull();
  });

  it("refers to plan on rows without a primary channel", () => {
    expect(() =>
      adapter.plan({ id: "n1", channels: null, primaryChannel: "" }),
    ).toThrow(/no primaryChannel/);
  });

  it("applies the guarded write and becomes idempotent afterwards", async () => {
    const row: NotificationChannelRow = {
      id: "n1",
      channels: null,
      primaryChannel: "email",
    };
    const change = adapter.plan(row)!;

    await expect(adapter.apply(row, change)).resolves.toBeUndefined();
    expect(repo.rows.get("n1")!.channels).toEqual(["email"]);
    expect(adapter.plan({ ...row, channels: ["email"] })).toBeNull();
  });

  it("signals a conflict when the guarded write matches no row", async () => {
    repo.conflictFor.add("n1");
    const row: NotificationChannelRow = {
      id: "n1",
      channels: null,
      primaryChannel: "email",
    };
    await expect(adapter.apply(row, adapter.plan(row)!)).resolves.toBe(
      BACKFILL_CONFLICT,
    );
    expect(repo.rows.get("n1")!.channels).toBeNull();
  });

  it("restores the before-image only when the row still holds what was written", async () => {
    const row: NotificationChannelRow = {
      id: "n1",
      channels: null,
      primaryChannel: "email",
    };
    const change = adapter.plan(row)!;
    await adapter.apply(row, change);
    const undo = { before: change.before, after: change.after };

    await adapter.restore("n1", undo);
    expect(repo.rows.get("n1")!.channels).toBeNull();

    repo.rows.get("n2")!.channels = ["push"];
    await adapter.restore("n2", { before: null, after: ["email"] });
    expect(repo.rows.get("n2")!.channels).toEqual(["push"]);
  });

  describe("end-to-end through BackfillJob", () => {
    let job: BackfillJob<NotificationChannelRow>;
    let store: MemoryStore;

    beforeEach(() => {
      store = new MemoryStore();
      job = new BackfillJob<NotificationChannelRow>(adapter, store, {
        jobName: NOTIFICATION_CHANNELS_JOB,
      });
    });

    it("previews without writing, applies on demand, and rolls back", async () => {
      const before = JSON.stringify([...repo.rows.entries()]);

      const preview = await job.run(operator, "channels-1", {
        dryRun: true,
        batchSize: 2,
      });
      expect(preview).toMatchObject({
        status: "completed",
        planned: 3,
        skipped: 2,
      });
      expect(preview.diffs.map((d) => d.after)).toEqual([
        ["email"],
        ["sms"],
        ["email"],
      ]);
      expect(JSON.stringify([...repo.rows.entries()])).toBe(before);

      await expect(
        job.run(operator, "channels-1", { dryRun: false, batchSize: 2 }),
      ).rejects.toThrow(/dry-run preview/);

      const applied = await job.run(operator, "channels-1-apply", {
        dryRun: false,
        batchSize: 2,
      });
      expect(applied).toMatchObject({
        status: "completed",
        planned: 3,
        applied: 3,
        skipped: 2,
        conflicts: 0,
        failures: [],
      });
      expect(repo.rows.get("n1")!.channels).toEqual(["email"]);
      expect(repo.rows.get("n3")!.channels).toEqual(["sms"]);

      const rolled = await job.rollback(operator, "channels-1-apply");
      expect(rolled).toMatchObject({
        status: "rolled_back",
        applied: 0,
        journal: [],
      });
      expect(repo.rows.get("n1")!.channels).toBeNull();
      expect(repo.rows.get("n3")!.channels).toBeNull();
      expect(repo.rows.get("n2")!.channels).toEqual(["push", "email"]);
    });

    it("reports rows another writer changed concurrently as conflicts", async () => {
      repo.conflictFor.add("n3");
      const result = await job.run(operator, "channels-2", {
        dryRun: false,
        batchSize: 2,
      });

      expect(result).toMatchObject({ planned: 3, applied: 2, conflicts: 1 });
      expect(result.failures).toEqual([]);
      expect(result.journal.map((j) => j.recordId)).toEqual(["n1", "n4"]);
      expect(result.diffs.map((d) => d.recordId)).toEqual(["n1", "n4"]);
      expect(repo.setCalls).toBe(3);
    });
  });
});

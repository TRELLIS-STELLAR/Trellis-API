import { runResumableBackfill } from "./resumable-backfill";

describe("resumable backfill", () => {
  it("skips duplicate records and advances its checkpoint", async () => {
    const applied: number[] = [];
    const state = await runResumableBackfill({ nextCursor: null, processed: 0, seen: new Set(["1"]) }, async (cursor) => cursor === null ? { records: [{ id: 1 }, { id: 2 }], nextCursor: "next" } : { records: [{ id: 2 }, { id: 3 }], nextCursor: null }, (record) => String(record.id), async (record) => { applied.push(record.id); });
    expect(applied).toEqual([2, 3]);
    expect(state.processed).toBe(2);
    expect(state.nextCursor).toBeNull();
  });
});

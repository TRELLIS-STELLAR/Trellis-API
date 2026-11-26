import { rollupMetrics } from "./metric-rollup";

describe("rollupMetrics", () => {
  const from = new Date("2026-01-01T00:00:00.000Z");
  const to = new Date("2026-01-01T00:03:00.000Z");

  it("fills empty buckets and aggregates samples", () => {
    expect(
      rollupMetrics(
        [
          { timestamp: "2026-01-01T00:00:05Z", value: 2 },
          { timestamp: "2026-01-01T00:00:45Z", value: 4 },
          { timestamp: "2026-01-01T00:02:10Z", value: 8 },
        ],
        from,
        to,
        60_000,
      ),
    ).toEqual([
      expect.objectContaining({ count: 2, sum: 6, average: 3, min: 2, max: 4 }),
      expect.objectContaining({ count: 0, sum: 0, average: null, min: null, max: null }),
      expect.objectContaining({ count: 1, sum: 8, average: 8, min: 8, max: 8 }),
    ]);
  });

  it("ignores out-of-range samples and rejects invalid input", () => {
    expect(rollupMetrics([{ timestamp: "2025-12-31T23:59:59Z", value: 1 }], from, to, 60_000)).toHaveLength(3);
    expect(() => rollupMetrics([], from, to, 0)).toThrow("bucketMs");
    expect(() => rollupMetrics([{ timestamp: from, value: Infinity }], from, to, 60_000)).toThrow("finite");
  });
});

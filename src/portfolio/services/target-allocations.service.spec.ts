import { RebalancingService } from "./rebalancing.service";
import { Portfolio } from "src/investment/portfolio/entities/portfolio.entity";
import { TargetAllocationVersion } from "src/portfolio/entities/target-allocation.entity";

describe("target allocations", () => {
  let service: RebalancingService;
  let manager: any;
  let versions: any[];
  let current: any;
  beforeEach(() => {
    versions = [];
    manager = {
      findOne: jest.fn(async (entity, options) => {
        if (entity === Portfolio) return { id: "p" };
        const version = options?.where?.version;
        return version === undefined
          ? versions[versions.length - 1]
          : versions.find((entry) => entry.version === version);
      }),
      find: jest.fn(async () => [
        { id: "a", ticker: "XLM" },
        { id: "b", ticker: "USD" },
        { id: "c", ticker: "BTC" },
        { id: "d", ticker: "ETH" },
      ]),
      create: jest.fn((_, value) => value),
      save: jest.fn(async (_, value) => {
        versions.push(value);
        return value;
      }),
      update: jest.fn(async (_, __, value) => {
        current = value.targetAllocation;
      }),
    };
    service = new RebalancingService({
      transaction: (callback) => callback(manager),
      getRepository: () => ({
        findOne: async () => versions[versions.length - 1],
        find: async () => [...versions].reverse(),
      }),
    } as any);
  });
  it("persists and retrieves a valid complete set", async () => {
    await service.setTargetAllocations("p", { XLM: 60, USD: 40 });
    expect(current).toEqual({ XLM: 60, USD: 40 });
    expect((await service.getTargetAllocationVersion("p")).allocations).toEqual(
      [
        { assetId: "a", ticker: "XLM", targetWeight: 60 },
        { assetId: "b", ticker: "USD", targetWeight: 40 },
      ],
    );
    expect(manager.save).toHaveBeenCalledWith(
      TargetAllocationVersion,
      expect.objectContaining({ version: 1 }),
    );
  });
  it.each([
    {},
    { XLM: 99 },
    { XLM: -1, USD: 101 },
    { XLM: NaN },
    { XLM: Infinity },
    { XLM: "100" },
  ])("rejects invalid weights %p", async (value) => {
    await expect(
      service.setTargetAllocations("p", value as any),
    ).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
  });
  it("rejects unknown assets", async () => {
    await expect(
      service.setTargetAllocations("p", { UNKNOWN: 100 }),
    ).rejects.toThrow("Unknown or ambiguous");
    expect(manager.save).not.toHaveBeenCalled();
  });
  it("replaces cleanly while keeping previous versions", async () => {
    await service.setTargetAllocations(
      "p",
      new Map([
        ["XLM", 60],
        ["USD", 40],
      ]),
    );
    await service.setTargetAllocations("p", { XLM: 100 });
    expect(current).toEqual({ XLM: 100 });
    const history = await service.getTargetAllocationHistory("p");
    expect(history.map((entry) => entry.version)).toEqual([2, 1]);
    expect(history[1].allocations).toHaveLength(2);
  });
  describe("concurrent edits with baseVersion", () => {
    beforeEach(async () => {
      await service.setTargetAllocations("p", { XLM: 50, USD: 30, BTC: 20 });
    });

    it("keeps last-writer-wins when baseVersion is omitted", async () => {
      await service.setTargetAllocations("p", { XLM: 100 });
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
    });

    it("writes directly when baseVersion is current", async () => {
      expect(
        await service.setTargetAllocations("p", { XLM: 60, USD: 40 }, 1),
      ).toEqual({
        version: 2,
        allocations: { XLM: 60, USD: 40 },
        merged: false,
      });
    });

    it("merges a stale edit that touches different tickers", async () => {
      // Client A moves 10% from XLM to USD; client B, still on v1, swaps BTC for ETH.
      await service.setTargetAllocations("p", { XLM: 40, USD: 40, BTC: 20 }, 1);
      const result = await service.setTargetAllocations(
        "p",
        { XLM: 50, USD: 30, ETH: 20 },
        1,
      );
      expect(result).toEqual({
        version: 3,
        allocations: { ETH: 20, USD: 40, XLM: 40 },
        merged: true,
      });
      expect(versions[2].allocations).toEqual([
        { assetId: "d", ticker: "ETH", targetWeight: 20 },
        { assetId: "b", ticker: "USD", targetWeight: 40 },
        { assetId: "a", ticker: "XLM", targetWeight: 40 },
      ]);
    });

    it("rejects overlapping edits with sorted conflicts and writes nothing", async () => {
      await service.setTargetAllocations("p", { XLM: 45, USD: 35, BTC: 20 }, 1);
      const error = await service
        .setTargetAllocations("p", { XLM: 55, USD: 25, BTC: 20 }, 1)
        .catch((e) => e);
      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({
        expectedVersion: 1,
        actualVersion: 2,
        action: "refresh",
        conflicts: [
          { field: "USD", base: 30, current: 35, proposed: 25 },
          { field: "XLM", base: 50, current: 45, proposed: 55 },
        ],
      });
      expect(versions).toHaveLength(2);
    });

    it("rejects a merge that breaks the 100% invariant", async () => {
      await service.setTargetAllocations("p", { XLM: 40, USD: 30, BTC: 30 }, 1);
      const error = await service
        .setTargetAllocations("p", { XLM: 50, USD: 20, BTC: 30 }, 1)
        .catch((e) => e);
      expect(error.getStatus()).toBe(409);
      expect(error.getResponse().message).toContain("100%");
      expect(versions).toHaveLength(2);
    });

    it("treats a retried, already applied edit as a no-op", async () => {
      const edit = { XLM: 60, USD: 20, BTC: 20 };
      const first = await service.setTargetAllocations("p", edit, 1);
      const retry = await service.setTargetAllocations("p", edit, 1);
      expect(retry).toEqual(first);
      expect(versions).toHaveLength(2);
    });

    it.each([5, -1, 1.5])("rejects an unusable baseVersion %p", async (v) => {
      await expect(
        service.setTargetAllocations("p", { XLM: 100 }, v),
      ).rejects.toThrow();
      expect(versions).toHaveLength(1);
    });
  });
});

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
      findOne: jest.fn(async (entity) =>
        entity === Portfolio ? { id: "p" } : versions[versions.length - 1],
      ),
      find: jest.fn(async () => [
        { id: "a", ticker: "XLM" },
        { id: "b", ticker: "USD" },
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
});

import { threeWayMerge } from "./conflict-resolver";

describe("threeWayMerge", () => {
  const base = { XLM: 50, USDC: 30, BTC: 20 };

  it("applies non-overlapping edits from both clients", () => {
    const current = { XLM: 40, USDC: 40, BTC: 20 };
    const proposed = { XLM: 50, USDC: 30, ETH: 20 };
    expect(threeWayMerge(base, current, proposed)).toEqual({
      merged: { XLM: 40, USDC: 40, ETH: 20 },
      conflicts: [],
      changed: true,
    });
  });

  it("treats identical edits on both sides as agreement", () => {
    const edit = { XLM: 60, USDC: 20, BTC: 20 };
    expect(threeWayMerge(base, edit, edit)).toEqual({
      merged: edit,
      conflicts: [],
      changed: false,
    });
  });

  it("reports overlapping edits as sorted conflicts", () => {
    const current = { XLM: 45, USDC: 35, BTC: 20 };
    const proposed = { XLM: 55, USDC: 25, BTC: 20 };
    expect(threeWayMerge(base, current, proposed).conflicts).toEqual([
      { field: "USDC", base: 30, current: 35, proposed: 25 },
      { field: "XLM", base: 50, current: 45, proposed: 55 },
    ]);
  });

  it("conflicts when one client removes a field the other changed", () => {
    const current = { XLM: 50, USDC: 10, BTC: 40 };
    const proposed = { XLM: 70, USDC: 30 };
    expect(threeWayMerge(base, current, proposed).conflicts).toEqual([
      { field: "BTC", base: 20, current: 40, proposed: undefined },
    ]);
  });

  it("is independent of key order", () => {
    const current = { BTC: 20, USDC: 40, XLM: 40 };
    const proposed = { ETH: 20, USDC: 30, XLM: 50 };
    const a = threeWayMerge(base, current, proposed);
    const b = threeWayMerge(
      { BTC: 20, XLM: 50, USDC: 30 },
      { XLM: 40, BTC: 20, USDC: 40 },
      { XLM: 50, ETH: 20, USDC: 30 },
    );
    expect(Object.keys(a.merged)).toEqual(Object.keys(b.merged));
    expect(a).toEqual(b);
  });
});

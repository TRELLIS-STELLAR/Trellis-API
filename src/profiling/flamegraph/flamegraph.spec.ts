import {
  CpuProfile,
  buildFlamegraph,
  toFoldedStacks,
  topSelfFrames,
} from "./flamegraph";
import { MemoryThresholdTrigger } from "./memory-threshold-trigger";

/**
 * (root) -> handle (api.js:10) -> query      samples: 3
 *        -> handle (self)                    samples: 1
 *        -> gc                               samples: 1
 */
const profile: CpuProfile = {
  startTime: 0,
  endTime: 100,
  nodes: [
    { id: 1, callFrame: { functionName: "(root)" }, children: [2, 3] },
    {
      id: 2,
      callFrame: {
        functionName: "handle",
        url: "file:///app/src/api.js",
        lineNumber: 9,
      },
      children: [4],
    },
    { id: 3, callFrame: { functionName: "gc" } },
    { id: 4, callFrame: { functionName: "query" } },
  ],
  samples: [4, 4, 4, 2, 3],
};

describe("flamegraph conversion (#527)", () => {
  describe("normal path", () => {
    it("builds a tree whose values include descendants and whose self counts are leaves", () => {
      const root = buildFlamegraph(profile);

      expect(root.name).toBe("(root)");
      expect(root.value).toBe(5);
      expect(root.self).toBe(0);

      const handle = root.children.find((c) => c.name.startsWith("handle"))!;
      expect(handle.name).toBe("handle (api.js:10)");
      expect(handle.value).toBe(4);
      expect(handle.self).toBe(1);

      const query = handle.children[0];
      expect(query).toMatchObject({ name: "query", value: 3, self: 3 });
    });

    it("emits folded stacks with one line per frame that has self samples", () => {
      const folded = toFoldedStacks(buildFlamegraph(profile))
        .trim()
        .split("\n")
        .sort();
      expect(folded).toEqual([
        "(root);gc 1",
        "(root);handle (api.js:10) 1",
        "(root);handle (api.js:10);query 3",
      ]);
    });

    it("ranks top self frames", () => {
      const top = topSelfFrames(buildFlamegraph(profile), 2);
      expect(top[0]).toEqual({ name: "query", self: 3 });
      expect(top).toHaveLength(2);
    });

    it("falls back to hitCount when the sample stream is absent", () => {
      const root = buildFlamegraph({
        startTime: 0,
        endTime: 1,
        nodes: [
          {
            id: 1,
            callFrame: { functionName: "(root)" },
            children: [2],
            hitCount: 0,
          },
          { id: 2, callFrame: { functionName: "work" }, hitCount: 7 },
        ],
      });
      expect(root.value).toBe(7);
    });

    it("drops children with no samples from the tree", () => {
      const root = buildFlamegraph({
        startTime: 0,
        endTime: 1,
        nodes: [
          { id: 1, callFrame: { functionName: "(root)" }, children: [2, 3] },
          { id: 2, callFrame: { functionName: "idle" } },
          { id: 3, callFrame: { functionName: "busy" } },
        ],
        samples: [3],
      });
      expect(root.children.map((c) => c.name)).toEqual(["busy"]);
    });
  });

  describe("edge cases", () => {
    it("sanitises folded-format delimiters inside frame names", () => {
      const root = buildFlamegraph({
        startTime: 0,
        endTime: 1,
        nodes: [{ id: 1, callFrame: { functionName: "a;b c" } }],
        samples: [1],
      });
      expect(toFoldedStacks(root)).toBe("a:b c 1\n");
    });

    it("returns empty folded output when nothing was sampled", () => {
      const root = buildFlamegraph({
        startTime: 0,
        endTime: 1,
        nodes: [{ id: 1, callFrame: { functionName: "(root)" } }],
        samples: [],
      });
      expect(toFoldedStacks(root)).toBe("");
    });

    it("labels anonymous frames", () => {
      const root = buildFlamegraph({
        startTime: 0,
        endTime: 1,
        nodes: [{ id: 1, callFrame: { functionName: "" } }],
        samples: [1],
      });
      expect(root.name).toBe("(anonymous)");
    });
  });

  describe("failure path: malformed profiles fail loudly rather than producing a wrong graph", () => {
    it("rejects a profile with no nodes", () => {
      expect(() =>
        buildFlamegraph({ startTime: 0, endTime: 1, nodes: [] }),
      ).toThrow(/no nodes/);
    });

    it("rejects a cycle", () => {
      expect(() =>
        buildFlamegraph({
          startTime: 0,
          endTime: 1,
          nodes: [
            { id: 1, callFrame: { functionName: "a" }, children: [2] },
            { id: 2, callFrame: { functionName: "b" }, children: [1] },
          ],
        }),
      ).toThrow(/cycle/);
    });

    it("rejects a dangling child reference", () => {
      expect(() =>
        buildFlamegraph({
          startTime: 0,
          endTime: 1,
          nodes: [{ id: 1, callFrame: { functionName: "a" }, children: [99] }],
        }),
      ).toThrow(/unknown child 99/);
    });

    it("rejects a sample that names an unknown node", () => {
      expect(() =>
        buildFlamegraph({
          startTime: 0,
          endTime: 1,
          nodes: [{ id: 1, callFrame: { functionName: "a" } }],
          samples: [42],
        }),
      ).toThrow(/unknown node 42/);
    });
  });
});

describe("MemoryThresholdTrigger (#527)", () => {
  const sample = (ratio: number) => ({
    usedHeapSize: ratio * 100,
    heapSizeLimit: 100,
  });

  it("fires once when usage crosses the threshold, not on every sample above it", () => {
    const trigger = new MemoryThresholdTrigger({
      threshold: 0.8,
      now: () => 0,
    });

    expect(trigger.evaluate(sample(0.5))).toBe("idle");
    expect(trigger.evaluate(sample(0.85))).toBe("fire");
    expect(trigger.evaluate(sample(0.9))).toBe("idle");
    expect(trigger.evaluate(sample(0.95))).toBe("idle");
  });

  it("re-arms only after usage drops below the re-arm ratio (hysteresis)", () => {
    let now = 0;
    const trigger = new MemoryThresholdTrigger({
      threshold: 0.8,
      rearmRatio: 0.6,
      cooldownMs: 0,
      now: () => now,
    });

    expect(trigger.evaluate(sample(0.85))).toBe("fire");
    expect(trigger.evaluate(sample(0.7))).toBe("idle"); // dipped, but not below 0.6
    expect(trigger.evaluate(sample(0.85))).toBe("idle"); // still disarmed
    expect(trigger.evaluate(sample(0.5))).toBe("idle"); // re-armed
    expect(trigger.isArmed()).toBe(true);
    now += 1;
    expect(trigger.evaluate(sample(0.85))).toBe("fire");
  });

  it("enforces a cooldown across separate excursions", () => {
    let now = 0;
    const trigger = new MemoryThresholdTrigger({
      threshold: 0.8,
      rearmRatio: 0.6,
      cooldownMs: 1000,
      now: () => now,
    });

    expect(trigger.evaluate(sample(0.85))).toBe("fire");
    expect(trigger.evaluate(sample(0.5))).toBe("idle"); // re-armed
    now = 500;
    expect(trigger.evaluate(sample(0.85))).toBe("cooldown");
    now = 1000;
    expect(trigger.evaluate(sample(0.85))).toBe("fire");
  });

  it("ignores a degenerate sample instead of firing on NaN", () => {
    const trigger = new MemoryThresholdTrigger({ threshold: 0.8 });
    expect(trigger.evaluate({ usedHeapSize: 1, heapSizeLimit: 0 })).toBe(
      "idle",
    );
    expect(
      trigger.evaluate({ usedHeapSize: Number.NaN, heapSizeLimit: 100 }),
    ).toBe("idle");
  });

  it("rejects an invalid threshold or re-arm ratio at construction", () => {
    expect(() => new MemoryThresholdTrigger({ threshold: 0 })).toThrow(
      /between 0 and 1/,
    );
    expect(() => new MemoryThresholdTrigger({ threshold: 1 })).toThrow(
      /between 0 and 1/,
    );
    expect(
      () => new MemoryThresholdTrigger({ threshold: 0.8, rearmRatio: 0.9 }),
    ).toThrow(/below the threshold/);
  });
});

/**
 * Pure conversion from a V8 CPU profile (`.cpuprofile`) to a flamegraph tree and
 * folded-stack text (#527). No I/O and no timers, so it is fully unit-testable.
 *
 * Width is sample count: each sample contributes 1 to the leaf frame it hit, and
 * every ancestor's `value` includes it. Folded output is the Brendan Gregg
 * format consumed by flamegraph.pl and speedscope: `frame;frame;frame count`.
 */

export interface CpuProfileNode {
  id: number;
  callFrame: { functionName: string; url?: string; lineNumber?: number };
  children?: number[];
  hitCount?: number;
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface FlamegraphNode {
  name: string;
  /** Samples in this frame and its descendants. Drives the rendered width. */
  value: number;
  /** Samples whose leaf was exactly this frame. */
  self: number;
  children: FlamegraphNode[];
}

/**
 * Build a flamegraph tree from a CPU profile. Throws on a malformed profile
 * (no nodes, a cycle, or a dangling child id) rather than emitting a wrong graph.
 */
export function buildFlamegraph(profile: CpuProfile): FlamegraphNode {
  if (!profile || !Array.isArray(profile.nodes) || profile.nodes.length === 0) {
    throw new Error("cpu profile has no nodes");
  }

  const byId = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) byId.set(node.id, node);
  const root = profile.nodes[0];

  // Self counts: prefer the sample stream, which is what the profiler recorded.
  const self = new Map<number, number>();
  if (Array.isArray(profile.samples) && profile.samples.length > 0) {
    for (const id of profile.samples) {
      if (!byId.has(id))
        throw new Error(`cpu profile sample references unknown node ${id}`);
      self.set(id, (self.get(id) ?? 0) + 1);
    }
  } else {
    for (const node of profile.nodes) {
      if (node.hitCount) self.set(node.id, node.hitCount);
    }
  }

  // Iterative DFS: order lists parents before children, and detects cycles.
  const order: number[] = [];
  const seen = new Set<number>();
  const stack: number[] = [root.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id))
      throw new Error(`cpu profile contains a cycle at node ${id}`);
    seen.add(id);
    order.push(id);
    for (const child of byId.get(id)?.children ?? []) {
      if (!byId.has(child))
        throw new Error(
          `cpu profile node ${id} references unknown child ${child}`,
        );
      stack.push(child);
    }
  }

  // Children are processed before parents, so totals are ready when needed.
  const total = new Map<number, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let sum = self.get(id) ?? 0;
    for (const child of byId.get(id)!.children ?? []) {
      sum += total.get(child) ?? 0;
    }
    total.set(id, sum);
  }

  const built = new Map<number, FlamegraphNode>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const node = byId.get(id)!;
    const children = (node.children ?? [])
      .filter((child) => (total.get(child) ?? 0) > 0)
      .map((child) => built.get(child)!);
    built.set(id, {
      name: frameName(node),
      value: total.get(id) ?? 0,
      self: self.get(id) ?? 0,
      children,
    });
  }

  return built.get(root.id)!;
}

/** Folded stacks, one line per leaf frame with self samples. Empty when no samples. */
export function toFoldedStacks(root: FlamegraphNode): string {
  const lines: string[] = [];
  const stack: { node: FlamegraphNode; path: string[] }[] = [
    { node: root, path: [] },
  ];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    const here = [...path, sanitize(node.name)];
    if (node.self > 0) lines.push(`${here.join(";")} ${node.self}`);
    for (const child of node.children) {
      stack.push({ node: child, path: here });
    }
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

/** Top frames by self samples. Useful for a quick triage line in logs. */
export function topSelfFrames(
  root: FlamegraphNode,
  limit = 10,
): { name: string; self: number }[] {
  const totals = new Map<string, number>();
  const stack: FlamegraphNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.self > 0)
      totals.set(node.name, (totals.get(node.name) ?? 0) + node.self);
    stack.push(...node.children);
  }
  return [...totals.entries()]
    .map(([name, self]) => ({ name, self }))
    .sort((a, b) => b.self - a.self)
    .slice(0, limit);
}

function frameName(node: CpuProfileNode): string {
  const name = node.callFrame.functionName || "(anonymous)";
  const url = node.callFrame.url;
  if (!url) return name;
  // Location makes same-named functions in different files distinguishable.
  const line = node.callFrame.lineNumber ?? 0;
  return `${name} (${url.split("/").pop()}:${line + 1})`;
}

/** Folded-format delimiters inside a frame name would corrupt the output. */
function sanitize(name: string): string {
  return name.replace(/;/g, ":").replace(/\s+/g, " ").trim() || "(anonymous)";
}

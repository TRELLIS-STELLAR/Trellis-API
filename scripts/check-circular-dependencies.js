const fs = require("node:fs");
const path = require("node:path");

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
    // TypeORM entity relation callbacks intentionally reference each other;
    // those metadata links do not form an application module cycle.
    if (directory.split(path.sep).includes("entities")) return [];
    if (entry.name.endsWith(".spec.ts") || entry.name.endsWith(".test.ts")) return [];
    return [fullPath];
  });
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, path.join(base, "index.ts")];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function dependencyGraph(root) {
  const files = sourceFiles(root);
  const known = new Set(files.map((file) => path.normalize(file)));
  const graph = new Map();
  const importPattern = /(?:import(?:[\s\S]*?from\s*|\s*)|export[\s\S]*?from\s*)["']([^"']+)["']/g;

  for (const file of files) {
    const dependencies = new Set();
    const contents = fs.readFileSync(file, "utf8");
    for (const match of contents.matchAll(importPattern)) {
      const dependency = resolveImport(file, match[1]);
      if (dependency && known.has(path.normalize(dependency))) dependencies.add(path.normalize(dependency));
    }
    graph.set(path.normalize(file), [...dependencies]);
  }
  return graph;
}

function findCycles(graph) {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const cycles = [];

  function visit(file) {
    if (active.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
    stack.pop();
    active.delete(file);
  }

  for (const file of graph.keys()) visit(file);
  return cycles;
}

function run(root = path.resolve(__dirname, "..", "src")) {
  const cycles = findCycles(dependencyGraph(root));
  if (cycles.length) {
    console.error("Circular TypeScript dependencies detected:");
    for (const cycle of cycles) console.error(`  ${cycle.map((file) => path.relative(process.cwd(), file)).join(" -> ")}`);
    return 1;
  }
  console.log("No circular TypeScript dependencies found.");
  return 0;
}

if (require.main === module) process.exitCode = run(process.argv[2] ? path.resolve(process.argv[2]) : undefined);

module.exports = { dependencyGraph, findCycles, run };

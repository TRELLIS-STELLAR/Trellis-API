const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { findCycles, dependencyGraph } = require("./check-circular-dependencies");

describe("circular dependency checker", () => {
  it("detects a cycle in relative imports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-cycle-"));
    fs.writeFileSync(path.join(root, "a.ts"), 'import "./b";');
    fs.writeFileSync(path.join(root, "b.ts"), 'import "./a";');
    expect(findCycles(dependencyGraph(root))).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

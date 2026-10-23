import { buildCrossContractMigrationDryRun } from "./cross-contract-migration";

describe("cross-contract migration dry-run", () => {
  it("reports deterministic create and update operations without mutating state", () => {
    const source = { contractId: "C-source", state: { owner: "alice", limit: 10 } };
    const target = { contractId: "C-target", state: { owner: "alice", limit: 5 } };
    const report = buildCrossContractMigrationDryRun({ source, target, authorized: true });

    expect(report.dryRun).toBe(true);
    expect(report.operations).toEqual([
      { key: "limit", from: 5, to: 10, action: "update", reversible: true },
    ]);
    expect(report.safeToApply).toBe(false);
    expect(report.conflicts).toEqual(["limit"]);
    expect(source.state).toEqual({ owner: "alice", limit: 10 });
  });

  it("flags target-only data that cannot be rolled back automatically", () => {
    const report = buildCrossContractMigrationDryRun({
      source: { contractId: "C-source", state: { owner: "alice" } },
      target: { contractId: "C-target", state: { owner: "alice", legacy: true } },
      authorized: true,
    });
    expect(report.safeToApply).toBe(false);
    expect(report.warnings[0]).toContain("legacy");
    expect(report.rollback.reversible).toBe(false);
  });

  it("fails closed when the operator is not authorized", () => {
    expect(() => buildCrossContractMigrationDryRun({
      source: { contractId: "C-source", state: {} },
      target: { contractId: "C-target", state: {} },
      authorized: false,
    })).toThrow("requires authorization");
  });
});

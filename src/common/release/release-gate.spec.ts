import { evaluateReleaseGate, ReleaseGateEvidence } from "./release-gate";

const NOW = new Date("2026-10-18T12:00:00Z");

const SAFE_MIGRATION = {
  filename: "1-safe.ts",
  content: `
    export class Safe {
      async up(q) { await q.query('CREATE TABLE "t" ("id" serial PRIMARY KEY)'); }
      async down(q) { await q.query('DROP TABLE "t"'); }
    }
  `,
};

function evidence(overrides: Partial<ReleaseGateEvidence> = {}): ReleaseGateEvidence {
  return {
    releaseId: "v1.2.3",
    tests: {
      requiredSuites: ["unit", "e2e"],
      suites: [
        { name: "unit", passed: 100, failed: 0 },
        { name: "e2e", passed: 20, failed: 0 },
      ],
    },
    migrations: [SAFE_MIGRATION],
    rollback: {
      rehearsedAt: "2026-10-15T10:00:00Z",
      rehearsedBy: "ops@example.com",
      previousVersion: "v1.2.2",
      revertCommand: "npm run migration:revert",
      outcome: "passed",
    },
    ...overrides,
  };
}

const gate = (e: ReleaseGateEvidence) => evaluateReleaseGate(e, { now: NOW });

describe("evaluateReleaseGate (issue #372)", () => {
  it("passes when tests, migrations, and rollback evidence are all sound", () => {
    const decision = gate(evidence());
    expect(decision.decision).toBe("PASS");
    expect(decision.gates.map((g) => g.status)).toEqual(["PASSED", "PASSED", "PASSED"]);
  });

  describe("tests", () => {
    it("blocks on a failing suite", () => {
      const e = evidence();
      e.tests.suites[0].failed = 2;
      const decision = gate(e);
      expect(decision.decision).toBe("BLOCKED");
      expect(decision.blockingReasons).toContain("[tests] Test suite 'unit' has 2 failing test(s)");
    });

    it("blocks when a required suite has no result or none are declared", () => {
      const missing = evidence();
      missing.tests.suites = [missing.tests.suites[0]];
      expect(gate(missing).blockingReasons).toContain(
        "[tests] Required test suite 'e2e' has no result",
      );

      const none = evidence();
      none.tests.requiredSuites = [];
      expect(gate(none).decision).toBe("BLOCKED");
    });

    it("blocks a suite that ran no passing tests", () => {
      const e = evidence();
      e.tests.suites[1] = { name: "e2e", passed: 0, failed: 0 };
      expect(gate(e).decision).toBe("BLOCKED");
    });

    it("passes a suite that needed a retry but warns about flakiness", () => {
      const e = evidence();
      e.tests.suites[0].retries = 2;
      const decision = gate(e);
      expect(decision.decision).toBe("PASS");
      expect(decision.gates[0].warnings[0]).toContain("flakiness");
    });
  });

  describe("migrations", () => {
    it("blocks an irreversible migration", () => {
      const e = evidence({
        migrations: [
          { filename: "2-bad.ts", content: "export class Bad { async up(q) { await q.query('SELECT 1'); } }" },
        ],
      });
      const decision = gate(e);
      expect(decision.decision).toBe("BLOCKED");
      expect(decision.gates[1].status).toBe("BLOCKED");
    });
  });

  describe("rollback evidence", () => {
    it("blocks schema changes with no rehearsal", () => {
      const decision = gate(evidence({ rollback: undefined }));
      expect(decision.blockingReasons).toContain(
        "[rollback] Schema changes require a recorded rollback rehearsal",
      );
    });

    it("does not demand a rehearsal when nothing touches the schema", () => {
      expect(gate(evidence({ migrations: [], rollback: undefined })).decision).toBe("PASS");
    });

    it("blocks a failed, stale, future-dated, or incomplete rehearsal", () => {
      const base = evidence().rollback!;
      const cases = [
        { ...base, outcome: "failed" as const },
        { ...base, rehearsedAt: "2026-08-01T00:00:00Z" },
        { ...base, rehearsedAt: "2026-12-01T00:00:00Z" },
        { ...base, rehearsedAt: "not-a-date" },
        { ...base, revertCommand: "" },
      ];
      for (const rollback of cases) {
        expect(gate(evidence({ rollback })).decision).toBe("BLOCKED");
      }
    });

    it("blocks breaking schema changes even with a passed rehearsal", () => {
      const decision = gate(
        evidence({
          schemaChanges: [
            { table: "users", column: "flag", isNew: true, isNullable: false, hasDefault: false },
          ],
        }),
      );
      expect(decision.decision).toBe("BLOCKED");
    });
  });

  describe("waivers and authorization", () => {
    const blocked = () => evidence({ rollback: undefined });

    it("accepts a waiver from an ADMIN with a real reason and keeps it auditable", () => {
      const decision = gate({
        ...blocked(),
        waivers: [
          { gate: "rollback", reason: "hotfix with no schema impact", approvedBy: "a@x.io", approverRole: "ADMIN" },
        ],
      });
      expect(decision.decision).toBe("PASS");
      expect(decision.gates[2].status).toBe("WAIVED");
      expect(decision.gates[2].warnings.join(" ")).toContain("a@x.io");
    });

    it("rejects a waiver from a non-admin", () => {
      const decision = gate({
        ...blocked(),
        waivers: [
          { gate: "rollback", reason: "hotfix with no schema impact", approvedBy: "u@x.io", approverRole: "USER" },
        ],
      });
      expect(decision.decision).toBe("BLOCKED");
      expect(decision.gates[2].reasons.join(" ")).toContain("not an ADMIN");
    });

    it("rejects a waiver with a short reason", () => {
      const decision = gate({
        ...blocked(),
        waivers: [{ gate: "rollback", reason: "ok", approvedBy: "a@x.io", approverRole: "ADMIN" }],
      });
      expect(decision.decision).toBe("BLOCKED");
    });

    it("does not let a waiver for one gate unblock another", () => {
      const e = evidence();
      e.tests.suites[0].failed = 1;
      const decision = gate({
        ...e,
        waivers: [
          { gate: "rollback", reason: "unrelated waiver here", approvedBy: "a@x.io", approverRole: "ADMIN" },
        ],
      });
      expect(decision.decision).toBe("BLOCKED");
    });
  });

  it("is deterministic when retried with the same evidence", () => {
    const e = evidence();
    expect(gate(e)).toEqual(gate(e));
  });
});

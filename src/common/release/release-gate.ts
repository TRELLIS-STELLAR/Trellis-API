/**
 * Release gate (issue #372).
 *
 * Combines the three kinds of evidence a release needs into one deterministic
 * decision: test results, migration safety, and a recorded rollback rehearsal.
 * It reuses the migration and rollback analysis in `release-readiness.checker`
 * and performs no I/O, so CI can call it with an evidence document.
 */

import { Role } from "../guard/roles.enum";
import {
  verifyMigrationReadiness,
  verifyRollbackSafety,
} from "./release-readiness.checker";
import { SchemaColumnSpec } from "./release-readiness.types";

export type ReleaseGateName = "tests" | "migrations" | "rollback";
export type ReleaseGateStatus = "PASSED" | "BLOCKED" | "WAIVED";

export interface TestSuiteEvidence {
  name: string;
  passed: number;
  failed: number;
  /** Retries needed before the suite passed; any value above 0 is a flake warning. */
  retries?: number;
}

export interface RollbackRehearsalEvidence {
  rehearsedAt: string;
  rehearsedBy: string;
  previousVersion: string;
  revertCommand: string;
  outcome: "passed" | "failed";
  evidenceUrl?: string;
}

export interface ReleaseGateWaiver {
  gate: ReleaseGateName;
  reason: string;
  approvedBy: string;
  approverRole: string;
}

export interface ReleaseGateEvidence {
  releaseId: string;
  tests: { requiredSuites: string[]; suites: TestSuiteEvidence[] };
  migrations: Array<{ filename: string; content: string }>;
  schemaChanges?: SchemaColumnSpec[];
  rollback?: RollbackRehearsalEvidence;
  waivers?: ReleaseGateWaiver[];
}

export interface ReleaseGateOptions {
  now?: Date;
  /** Rehearsals older than this are stale evidence. Default 14 days. */
  maxRehearsalAgeDays?: number;
}

export interface ReleaseGateResult {
  gate: ReleaseGateName;
  status: ReleaseGateStatus;
  reasons: string[];
  warnings: string[];
}

export interface ReleaseGateDecision {
  releaseId: string;
  decision: "PASS" | "BLOCKED";
  gates: ReleaseGateResult[];
  blockingReasons: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_WAIVER_REASON_LENGTH = 10;

function evaluateTests(evidence: ReleaseGateEvidence): ReleaseGateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const { requiredSuites, suites } = evidence.tests;

  if (requiredSuites.length === 0) {
    reasons.push("No required test suites are declared");
  }
  for (const required of requiredSuites) {
    if (!suites.some((s) => s.name === required)) {
      reasons.push(`Required test suite '${required}' has no result`);
    }
  }
  for (const suite of suites) {
    if (suite.failed > 0) {
      reasons.push(`Test suite '${suite.name}' has ${suite.failed} failing test(s)`);
    } else if (suite.passed === 0) {
      reasons.push(`Test suite '${suite.name}' ran no passing tests`);
    }
    if ((suite.retries ?? 0) > 0) {
      warnings.push(
        `Test suite '${suite.name}' only passed after ${suite.retries} retry(ies); investigate flakiness`,
      );
    }
  }

  return { gate: "tests", status: reasons.length ? "BLOCKED" : "PASSED", reasons, warnings };
}

function evaluateMigrations(evidence: ReleaseGateEvidence): ReleaseGateResult {
  const report = verifyMigrationReadiness(evidence.migrations);
  return {
    gate: "migrations",
    status: report.isReady ? "PASSED" : "BLOCKED",
    reasons: report.issues,
    warnings: report.warnings,
  };
}

function evaluateRollback(
  evidence: ReleaseGateEvidence,
  now: Date,
  maxAgeDays: number,
): ReleaseGateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const changesSchema =
    evidence.migrations.length > 0 || (evidence.schemaChanges?.length ?? 0) > 0;

  const safety = verifyRollbackSafety(evidence.schemaChanges ?? []);
  reasons.push(...safety.breakingChanges);
  warnings.push(...safety.warnings);

  const rehearsal = evidence.rollback;
  if (!rehearsal) {
    if (changesSchema) {
      reasons.push("Schema changes require a recorded rollback rehearsal");
    }
  } else {
    if (!rehearsal.previousVersion || !rehearsal.revertCommand || !rehearsal.rehearsedBy) {
      reasons.push(
        "Rollback evidence must name the previous version, the revert command, and who rehearsed it",
      );
    }
    if (rehearsal.outcome !== "passed") {
      reasons.push("The rollback rehearsal did not pass");
    }
    const rehearsedAt = new Date(rehearsal.rehearsedAt).getTime();
    if (Number.isNaN(rehearsedAt) || rehearsedAt > now.getTime()) {
      reasons.push("Rollback rehearsal timestamp is invalid or in the future");
    } else if (now.getTime() - rehearsedAt > maxAgeDays * DAY_MS) {
      reasons.push(`Rollback rehearsal is older than ${maxAgeDays} days; rehearse again`);
    }
  }

  return { gate: "rollback", status: reasons.length ? "BLOCKED" : "PASSED", reasons, warnings };
}

function applyWaiver(
  result: ReleaseGateResult,
  waivers: ReleaseGateWaiver[],
): ReleaseGateResult {
  if (result.status !== "BLOCKED") return result;
  const waiver = waivers.find((w) => w.gate === result.gate);
  if (!waiver) return result;

  if (waiver.approverRole !== Role.ADMIN) {
    return {
      ...result,
      reasons: [...result.reasons, `Waiver for '${result.gate}' rejected: approver is not an ADMIN`],
    };
  }
  if (!waiver.approvedBy || (waiver.reason ?? "").trim().length < MIN_WAIVER_REASON_LENGTH) {
    return {
      ...result,
      reasons: [
        ...result.reasons,
        `Waiver for '${result.gate}' rejected: needs an approver and a reason of at least ${MIN_WAIVER_REASON_LENGTH} characters`,
      ],
    };
  }
  return {
    ...result,
    status: "WAIVED",
    warnings: [
      ...result.warnings,
      `Waived by ${waiver.approvedBy}: ${waiver.reason.trim()}`,
      ...result.reasons.map((r) => `Waived finding: ${r}`),
    ],
  };
}

export function evaluateReleaseGate(
  evidence: ReleaseGateEvidence,
  options: ReleaseGateOptions = {},
): ReleaseGateDecision {
  const now = options.now ?? new Date();
  const waivers = evidence.waivers ?? [];

  const gates = [
    evaluateTests(evidence),
    evaluateMigrations(evidence),
    evaluateRollback(evidence, now, options.maxRehearsalAgeDays ?? 14),
  ].map((g) => applyWaiver(g, waivers));

  const blockingReasons = gates
    .filter((g) => g.status === "BLOCKED")
    .flatMap((g) => g.reasons.map((r) => `[${g.gate}] ${r}`));

  return {
    releaseId: evidence.releaseId,
    decision: blockingReasons.length === 0 ? "PASS" : "BLOCKED",
    gates,
    blockingReasons,
  };
}

export interface ContractStateSnapshot {
  contractId: string;
  state: Record<string, unknown>;
}

export interface CrossContractMigrationPlan {
  source: ContractStateSnapshot;
  target: ContractStateSnapshot;
  keys?: string[];
  authorized: boolean;
}

export interface StateMigrationOperation {
  key: string;
  from: unknown;
  to: unknown;
  action: "create" | "update" | "delete";
  reversible: boolean;
}

export interface CrossContractDryRunReport {
  dryRun: true;
  sourceContract: string;
  targetContract: string;
  safeToApply: boolean;
  operations: StateMigrationOperation[];
  conflicts: string[];
  rollback: { reversible: boolean; operations: StateMigrationOperation[] };
  warnings: string[];
}

function assertPlan(plan: CrossContractMigrationPlan): void {
  if (!plan.authorized) throw new Error("Cross-contract migration requires authorization");
  if (!plan.source.contractId || !plan.target.contractId) throw new Error("Both contract IDs are required");
  if (plan.source.contractId === plan.target.contractId) throw new Error("Source and target contracts must differ");
}

export function buildCrossContractMigrationDryRun(
  plan: CrossContractMigrationPlan,
): CrossContractDryRunReport {
  assertPlan(plan);
  const keys = plan.keys ?? Array.from(new Set([...Object.keys(plan.source.state), ...Object.keys(plan.target.state)])).sort();
  const operations: StateMigrationOperation[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];

  for (const key of keys) {
    const sourceHas = Object.prototype.hasOwnProperty.call(plan.source.state, key);
    const targetHas = Object.prototype.hasOwnProperty.call(plan.target.state, key);
    const from = plan.target.state[key];
    const to = plan.source.state[key];
    if (!sourceHas) continue;
    if (!targetHas) {
      operations.push({ key, from: undefined, to, action: "create", reversible: true });
    } else if (JSON.stringify(from) !== JSON.stringify(to)) {
      conflicts.push(key);
      operations.push({ key, from, to, action: "update", reversible: true });
    }
  }

  for (const key of Object.keys(plan.target.state)) {
    if ((plan.keys ?? Object.keys(plan.target.state)).includes(key) && !Object.prototype.hasOwnProperty.call(plan.source.state, key)) {
      operations.push({ key, from: plan.target.state[key], to: undefined, action: "delete", reversible: false });
      warnings.push(`Target-only state '${key}' would be deleted; review before applying.`);
    }
  }

  const rollbackOperations: StateMigrationOperation[] = operations.filter((operation) => operation.reversible).map((operation) => ({
    ...operation,
    from: operation.to,
    to: operation.from,
    action: (operation.action === "create" ? "delete" : operation.action === "delete" ? "create" : "update") as StateMigrationOperation["action"],
  }));

  return {
    dryRun: true,
    sourceContract: plan.source.contractId,
    targetContract: plan.target.contractId,
    safeToApply: conflicts.length === 0 && warnings.length === 0,
    operations,
    conflicts,
    rollback: { reversible: operations.every((operation) => operation.reversible), operations: rollbackOperations },
    warnings,
  };
}

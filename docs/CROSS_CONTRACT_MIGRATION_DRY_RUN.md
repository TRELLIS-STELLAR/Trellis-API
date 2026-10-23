# Cross-contract migration dry runs

`buildCrossContractMigrationDryRun` compares a source and target contract state snapshot without submitting a transaction. The report lists deterministic create, update, and delete operations, identifies conflicting keys, and includes the reversible rollback operations.

The report is safe to review and retry because it has no side effects. A plan is blocked when an operator is not authorized, when source and target identifiers are missing or equal, when values conflict, or when target-only data would be deleted. Resolve conflicts or preserve the target-only keys before applying a migration. If an applied migration needs recovery, execute the report's rollback operations where `rollback.reversible` is true and use a forward fix for irreversible deletes.

Run the verification suite with:

```bash
npx jest src/common/migrations/cross-contract-migration.spec.ts
```

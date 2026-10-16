#!/usr/bin/env node
/**
 * Release Readiness Gate CLI
 *
 * Enforces production readiness standards across:
 * 1. Database Migrations & Reversibility (verifies up/down symmetry and absence of destructive/irreversible migrations)
 * 2. Automated Rollback Rehearsal (simulates rollback execution to detect syntax, constraint, or dependency failures)
 * 3. Security Audits & Guard Coverage (scans for exposed secrets/keys, verifies KYC/Auth guards across controllers)
 * 4. Smoke & Operational Invariants (verifies health endpoints, DR invariants, and monitoring readiness)
 * 5. Runbook & Documentation Completeness (verifies rollback/recovery runbooks exist)
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/release-readiness-gate.ts
 *   npm run release:gate
 *   npm run release:gate -- --json
 *   npm run release:gate -- --verbose
 */

import { runCli } from '../src/common/release/release-readiness-gate';

export * from '../src/common/release/release-readiness-gate';

if (require.main === module) {
  runCli().catch((err) => {
    console.error('Fatal error during release readiness gate evaluation:', err);
    process.exit(1);
  });
}

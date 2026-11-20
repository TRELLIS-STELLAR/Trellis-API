#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const modPath = pathToFileURL(
    path.resolve(
      __dirname,
      "../src/monitoring/deployment-rollback/deployment-rollback.ts",
    ),
  ).href;

  const {
    runDeploymentRollbackVerification,
    UnauthorizedRollbackVerificationError,
  } = await import(modPath);

  const target = {
    deploymentId: "deploy-verify-001",
    fromVersion: "2.1.0",
    toVersion: "2.0.3",
    environment: "staging",
    checks: [
      { name: "api-version", kind: "version" },
      { name: "health-readiness", kind: "health" },
      { name: "admin-endpoint", kind: "authorization" },
    ],
  };

  // 1. Normal + authorization fail-closed path
  const normal = await runDeploymentRollbackVerification(
    target,
    async (check, ctx) => {
      if (ctx.authorizationProbe) {
        return { ok: false, status: 403 };
      }
      if (check.kind === "version") {
        return { ok: true, status: 200, observedVersion: "2.0.3" };
      }
      return { ok: true, status: 200 };
    },
    { actor: { id: "ci-bot", roles: ["ADMIN"] } },
  );
  assert.equal(normal.allPassed, true);
  assert.equal(normal.canResumeTraffic, true);
  assert.equal(normal.passed, 3);
  assert.equal(normal.failed, 0);

  // 2. Retry recovery path
  let healthCalls = 0;
  const retried = await runDeploymentRollbackVerification(
    { ...target, checks: [{ name: "health-readiness", kind: "health" }] },
    async () => {
      healthCalls += 1;
      if (healthCalls === 1) {
        return { ok: false, status: 503, error: "starting" };
      }
      return { ok: true, status: 200 };
    },
    { maxAttempts: 3, backoffMs: 0, sleep: async () => undefined },
  );
  assert.equal(retried.allPassed, true);
  assert.equal(retried.results[0].attempts, 2);

  // 3. Failure path (version mismatch -> fail fast)
  const failed = await runDeploymentRollbackVerification(
    { ...target, checks: [{ name: "api-version", kind: "version" }] },
    async () => ({ ok: true, status: 200, observedVersion: "2.1.0" }),
    { maxAttempts: 3, backoffMs: 0, sleep: async () => undefined },
  );
  assert.equal(failed.allPassed, false);
  assert.equal(failed.canResumeTraffic, false);
  assert.equal(failed.results[0].attempts, 1);

  // 4. Operator RBAC authorization failure
  await assert.rejects(
    () =>
      runDeploymentRollbackVerification(
        target,
        async () => ({ ok: true }),
        { actor: { id: "viewer-1", roles: ["VIEWER"] } },
      ),
    (err) => err instanceof UnauthorizedRollbackVerificationError,
  );

  // 5. Endpoint authorization fail-open detection
  const authFailOpen = await runDeploymentRollbackVerification(
    { ...target, checks: [{ name: "admin-endpoint", kind: "authorization" }] },
    async () => ({ ok: true, status: 200 }),
  );
  assert.equal(authFailOpen.allPassed, false);
  assert.equal(authFailOpen.results[0].authorizationVerified, false);

  console.log("PASS: deployment rollback verification checks passed all scenarios.");
}

main().catch((err) => {
  console.error("FAIL: deployment rollback verification failed:", err);
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const modPath = pathToFileURL(
    path.resolve(
      __dirname,
      "../src/common/authorization/record-visibility/record-visibility-auth.ts",
    ),
  ).href;

  const {
    evaluateRecordAccess,
    filterVisibleRecords,
    fetchAuthorizedRecord,
    RecordVisibilityAccessError,
  } = await import(modPath);

  const active = { id: "r-1", ownerId: "u-1", tenantId: "t-a", visibility: "ACTIVE" };
  const hidden = { id: "r-2", ownerId: "u-1", tenantId: "t-a", visibility: "HIDDEN" };
  const archived = { id: "r-3", ownerId: "u-1", tenantId: "t-a", visibility: "ARCHIVED" };

  const admin = { id: "admin-1", roles: ["ADMIN"], tenantId: "t-a" };
  const owner = { id: "u-1", roles: ["USER"], tenantId: "t-a" };
  const other = { id: "u-2", roles: ["USER"], tenantId: "t-a" };

  // 1. Normal path
  assert.equal(evaluateRecordAccess(active, other, "READ").allowed, true);
  assert.equal(evaluateRecordAccess(hidden, admin, "READ").allowed, true);
  assert.equal(evaluateRecordAccess(archived, owner, "READ").allowed, true);
  assert.equal(evaluateRecordAccess(archived, admin, "RESTORE").allowed, true);

  // 2. Authorization fail-closed paths
  assert.equal(evaluateRecordAccess(hidden, null, "READ").statusCode, 401);
  assert.equal(evaluateRecordAccess(hidden, other, "READ").statusCode, 404);
  assert.equal(evaluateRecordAccess(archived, other, "READ").statusCode, 404);
  assert.equal(evaluateRecordAccess(archived, admin, "UPDATE").statusCode, 403);

  // 3. List filtering
  const visibleToOther = filterVisibleRecords([active, hidden, archived], other);
  assert.deepEqual(visibleToOther.map((r) => r.id), ["r-1"]);

  // 4. Retry recovery
  let calls = 0;
  const fetched = await fetchAuthorizedRecord(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient error");
      return archived;
    },
    admin,
    "READ",
    { maxAttempts: 3, backoffMs: 0, sleep: async () => undefined },
  );
  assert.equal(fetched.attempts, 2);
  assert.equal(fetched.record.id, "r-3");

  // 5. Failure path (unauthorized actor rejected with 404 masked)
  await assert.rejects(
    () => fetchAuthorizedRecord(async () => hidden, other, "READ"),
    (err) => err instanceof RecordVisibilityAccessError && err.statusCode === 404,
  );

  console.log("PASS: hidden and archived record authorization passed all scenarios.");
}

main().catch((err) => {
  console.error("FAIL: hidden/archived record authorization failed:", err);
  process.exit(1);
});

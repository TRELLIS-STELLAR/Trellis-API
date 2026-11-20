#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const modPath = pathToFileURL(
    path.resolve(
      __dirname,
      "../src/common/sorting/status-event-list-sorter.ts",
    ),
  ).href;

  const {
    sortStatusList,
    sortEventList,
    fetchAndSortStatusList,
    fetchAndSortEventList,
    UnauthorizedListSortError,
    DeterministicSortValidationError,
  } = await import(modPath);

  // 1. Deterministic status sorting (permutation invariant)
  const statuses = [
    { id: "s-b", status: "OPERATIONAL", updatedAt: "2026-11-20T10:00:00Z" },
    { id: "s-a", status: "OPERATIONAL", updatedAt: "2026-11-20T10:00:00Z" },
    { id: "s-c", status: "OUTAGE", updatedAt: "2026-11-20T09:00:00Z" },
    { id: "s-d", status: "DEGRADED", updatedAt: "2026-11-20T11:00:00Z" },
  ];
  const s1 = sortStatusList(statuses);
  const s2 = sortStatusList([...statuses].reverse());
  assert.deepEqual(
    s1.map((x) => x.id),
    ["s-c", "s-d", "s-a", "s-b"],
  );
  assert.deepEqual(
    s2.map((x) => x.id),
    s1.map((x) => x.id),
  );

  // 2. Deterministic event sorting
  const events = [
    { id: "e-2", type: "SYNC", timestamp: "2026-11-20T10:00:00Z", sequence: 1 },
    { id: "e-1", type: "SYNC", timestamp: "2026-11-20T10:00:00Z", sequence: 1 },
    { id: "e-3", type: "ALERT", timestamp: "2026-11-20T10:00:00Z", sequence: 2 },
  ];
  const e1 = sortEventList(events);
  assert.deepEqual(
    e1.map((x) => x.id),
    ["e-3", "e-1", "e-2"],
  );

  // 3. Retry recovery path
  let calls = 0;
  const retried = await fetchAndSortStatusList(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient network error");
      return statuses;
    },
    {
      maxAttempts: 3,
      backoffMs: 0,
      sleep: async () => undefined,
      actor: { id: "ops-1", roles: ["OPERATOR"] },
    },
  );
  assert.equal(retried.attempts, 2);
  assert.equal(retried.total, 4);

  // 4. Failure path (invalid timestamp fails fast)
  await assert.rejects(
    () =>
      fetchAndSortEventList(
        async () => [{ id: "bad", type: "X", timestamp: "invalid-date" }],
        { maxAttempts: 3, backoffMs: 0, sleep: async () => undefined },
      ),
    (err) => err instanceof DeterministicSortValidationError,
  );

  // 5. Authorization path (unauthorized tenant rejected before fetch)
  let fetched = false;
  await assert.rejects(
    () =>
      fetchAndSortEventList(
        async () => {
          fetched = true;
          return events;
        },
        {
          actor: { id: "u-1", roles: ["USER"], tenantId: "t-1" },
          requiredTenantId: "t-2",
        },
      ),
    (err) => err instanceof UnauthorizedListSortError,
  );
  assert.equal(fetched, false);

  console.log("PASS: deterministic status and event sorting passed all scenarios.");
}

main().catch((err) => {
  console.error("FAIL: deterministic sorting verification failed:", err);
  process.exit(1);
});

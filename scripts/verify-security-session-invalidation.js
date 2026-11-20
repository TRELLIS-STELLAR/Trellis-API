#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const modPath = pathToFileURL(
    path.resolve(
      __dirname,
      "../src/core/auth/security-session-invalidation/security-event-session-invalidation.ts",
    ),
  ).href;

  const {
    InMemorySessionInvalidationStore,
    invalidateSessionsForSecurityEvent,
    UnauthorizedSessionInvalidationError,
    InvalidSecurityEventError,
  } = await import(modPath);

  const makeStore = () =>
    new InMemorySessionInvalidationStore([
      { sessionId: "s-1", userId: "u-1", active: true, createdAt: "2026-11-20T08:00:00Z" },
      { sessionId: "s-2", userId: "u-1", active: true, createdAt: "2026-11-20T09:00:00Z" },
    ]);

  // 1. Normal + idempotency
  const store1 = makeStore();
  const evt = {
    eventId: "evt-1",
    userId: "u-1",
    eventType: "PASSWORD_CHANGED",
    occurredAt: "2026-11-20T10:00:00Z",
    excludeSessionId: "s-1",
  };
  const r1 = await invalidateSessionsForSecurityEvent(evt, store1, {
    actor: { id: "u-1", roles: ["USER"] },
    allowSelfServiceForUser: true,
  });
  assert.equal(r1.status, "INVALIDATED");
  assert.deepEqual(r1.invalidatedSessionIds, ["s-2"]);
  assert.deepEqual(r1.preservedSessionIds, ["s-1"]);

  const r1Dup = await invalidateSessionsForSecurityEvent(evt, store1, {
    actor: { id: "u-1", roles: ["USER"] },
    allowSelfServiceForUser: true,
  });
  assert.equal(r1Dup.status, "ALREADY_PROCESSED");

  // 2. High-risk event ignores excludeSessionId
  const store2 = makeStore();
  const r2 = await invalidateSessionsForSecurityEvent(
    { ...evt, eventId: "evt-2", eventType: "CREDENTIAL_COMPROMISED" },
    store2,
    { actor: { id: "sec-1", roles: ["SECURITY_OFFICER"] } },
  );
  assert.deepEqual(r2.invalidatedSessionIds, ["s-1", "s-2"]);
  assert.deepEqual(r2.preservedSessionIds, []);

  // 3. Retry recovery
  const store3 = makeStore();
  let tries = 0;
  const flakyStore = {
    listActiveSessions: (u) => store3.listActiveSessions(u),
    revokeSession: async (id, meta) => {
      if (id === "s-2") {
        tries += 1;
        if (tries === 1) throw new Error("transient error");
      }
      return store3.revokeSession(id, meta);
    },
    isEventProcessed: (id) => store3.isEventProcessed(id),
    markEventProcessed: (id, ts) => store3.markEventProcessed(id, ts),
  };
  const r3 = await invalidateSessionsForSecurityEvent(
    { ...evt, eventId: "evt-3", excludeSessionId: undefined },
    flakyStore,
    { maxAttempts: 3, backoffMs: 0, sleep: async () => undefined },
  );
  assert.equal(r3.status, "INVALIDATED");
  assert.equal(tries, 2);

  // 4. Failure path (PARTIAL_FAILURE leaves event unprocessed for retry)
  const store4 = makeStore();
  const failStore = {
    listActiveSessions: (u) => store4.listActiveSessions(u),
    revokeSession: async (id, meta) => {
      if (id === "s-2") throw new Error("db down");
      return store4.revokeSession(id, meta);
    },
    isEventProcessed: (id) => store4.isEventProcessed(id),
    markEventProcessed: (id, ts) => store4.markEventProcessed(id, ts),
  };
  const r4 = await invalidateSessionsForSecurityEvent(
    { ...evt, eventId: "evt-4", excludeSessionId: undefined },
    failStore,
    { maxAttempts: 2, backoffMs: 0, sleep: async () => undefined },
  );
  assert.equal(r4.status, "PARTIAL_FAILURE");
  assert.equal(await store4.isEventProcessed("evt-4"), false);

  // 5. Authorization + validation
  await assert.rejects(
    () =>
      invalidateSessionsForSecurityEvent(evt, makeStore(), {
        actor: { id: "u-other", roles: ["USER"] },
        allowSelfServiceForUser: true,
      }),
    (err) => err instanceof UnauthorizedSessionInvalidationError,
  );
  await assert.rejects(
    () =>
      invalidateSessionsForSecurityEvent({ ...evt, eventId: "" }, makeStore()),
    (err) => err instanceof InvalidSecurityEventError,
  );

  console.log("PASS: security-event session invalidation passed all scenarios.");
}

main().catch((err) => {
  console.error("FAIL: security-event session invalidation failed:", err);
  process.exit(1);
});

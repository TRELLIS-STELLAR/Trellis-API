import {
  InMemorySessionInvalidationStore,
  InvalidSecurityEventError,
  SecuritySessionEvent,
  SessionInvalidationStore,
  UnauthorizedSessionInvalidationError,
  invalidateSessionsForSecurityEvent,
} from "./security-event-session-invalidation";

describe("security-event session invalidation", () => {
  const makeStore = () =>
    new InMemorySessionInvalidationStore([
      { sessionId: "sess-1", userId: "user-1", active: true, createdAt: "2026-11-20T08:00:00Z" },
      { sessionId: "sess-2", userId: "user-1", active: true, createdAt: "2026-11-20T09:00:00Z" },
      { sessionId: "sess-other", userId: "user-2", active: true, createdAt: "2026-11-20T09:00:00Z" },
    ]);

  const baseEvent: SecuritySessionEvent = {
    eventId: "sec-evt-001",
    userId: "user-1",
    eventType: "PASSWORD_CHANGED",
    occurredAt: "2026-11-20T10:00:00Z",
    excludeSessionId: "sess-1",
  };

  it("invalidates active sessions while preserving excluded session for non-critical events and is idempotent", async () => {
    const store = makeStore();
    const report = await invalidateSessionsForSecurityEvent(baseEvent, store, {
      actor: { id: "user-1", roles: ["USER"] },
      allowSelfServiceForUser: true,
    });

    expect(report.status).toBe("INVALIDATED");
    expect(report.invalidatedSessionIds).toEqual(["sess-2"]);
    expect(report.preservedSessionIds).toEqual(["sess-1"]);
    expect(report.failedSessionIds).toHaveLength(0);
    expect(store.getSession("sess-1")?.active).toBe(true);
    expect(store.getSession("sess-2")?.active).toBe(false);
    expect(store.getSession("sess-other")?.active).toBe(true);

    const replay = await invalidateSessionsForSecurityEvent(baseEvent, store, {
      actor: { id: "user-1", roles: ["USER"] },
      allowSelfServiceForUser: true,
    });
    expect(replay.status).toBe("ALREADY_PROCESSED");
  });

  it("force-invalidates all sessions including excluded session on CREDENTIAL_COMPROMISED", async () => {
    const store = makeStore();
    const report = await invalidateSessionsForSecurityEvent(
      {
        ...baseEvent,
        eventId: "sec-evt-compromise",
        eventType: "CREDENTIAL_COMPROMISED",
        excludeSessionId: "sess-1",
      },
      store,
      { actor: { id: "sec-1", roles: ["SECURITY_OFFICER"] } },
    );

    expect(report.status).toBe("INVALIDATED");
    expect(report.invalidatedSessionIds).toEqual(["sess-1", "sess-2"]);
    expect(report.preservedSessionIds).toEqual([]);
  });

  it("retries transient revocation errors and recovers", async () => {
    const baseStore = makeStore();
    let revokeAttempts = 0;
    const delays: number[] = [];

    const flakyStore: SessionInvalidationStore = {
      listActiveSessions: (u) => baseStore.listActiveSessions(u),
      revokeSession: async (sessionId, meta) => {
        if (sessionId === "sess-2") {
          revokeAttempts += 1;
          if (revokeAttempts === 1) {
            throw new Error("redis timeout");
          }
        }
        return baseStore.revokeSession(sessionId, meta);
      },
      isEventProcessed: (id) => baseStore.isEventProcessed(id),
      markEventProcessed: (id, ts) => baseStore.markEventProcessed(id, ts),
    };

    const report = await invalidateSessionsForSecurityEvent(
      { ...baseEvent, excludeSessionId: undefined },
      flakyStore,
      {
        maxAttempts: 3,
        sleep: async (ms) => {
          delays.push(ms);
        },
        actor: { id: "admin-1", roles: ["ADMIN"] },
      },
    );

    expect(report.status).toBe("INVALIDATED");
    expect(report.invalidatedSessionIds).toEqual(["sess-1", "sess-2"]);
    expect(delays).toEqual([100]);
  });

  it("reports PARTIAL_FAILURE and leaves event unprocessed when a session cannot be revoked", async () => {
    const baseStore = makeStore();
    const failingStore: SessionInvalidationStore = {
      listActiveSessions: (u) => baseStore.listActiveSessions(u),
      revokeSession: async (sessionId, meta) => {
        if (sessionId === "sess-2") {
          throw new Error("store unavailable");
        }
        return baseStore.revokeSession(sessionId, meta);
      },
      isEventProcessed: (id) => baseStore.isEventProcessed(id),
      markEventProcessed: (id, ts) => baseStore.markEventProcessed(id, ts),
    };

    const report = await invalidateSessionsForSecurityEvent(
      { ...baseEvent, excludeSessionId: undefined },
      failingStore,
      { maxAttempts: 2, backoffMs: 0, sleep: async () => undefined },
    );

    expect(report.status).toBe("PARTIAL_FAILURE");
    expect(report.invalidatedSessionIds).toEqual(["sess-1"]);
    expect(report.failedSessionIds).toHaveLength(1);
    expect(report.failedSessionIds[0].sessionId).toBe("sess-2");
    expect(report.failedSessionIds[0].attempts).toBe(2);
    expect(await baseStore.isEventProcessed(baseEvent.eventId)).toBe(false);
  });

  it("enforces authorization for privileged and self-service actors", async () => {
    const store = makeStore();

    await expect(
      invalidateSessionsForSecurityEvent(baseEvent, store, {
        requireAuthorizedActor: true,
      }),
    ).rejects.toThrow(UnauthorizedSessionInvalidationError);

    await expect(
      invalidateSessionsForSecurityEvent(baseEvent, store, {
        actor: { id: "user-2", roles: ["USER"] },
        allowSelfServiceForUser: true,
      }),
    ).rejects.toThrow(UnauthorizedSessionInvalidationError);

    await expect(
      invalidateSessionsForSecurityEvent(
        { ...baseEvent, eventType: "ACCOUNT_LOCKED" },
        store,
        {
          actor: { id: "user-1", roles: ["USER"] },
          allowSelfServiceForUser: true,
        },
      ),
    ).rejects.toThrow(UnauthorizedSessionInvalidationError);
  });

  it("rejects invalid security events before touching the store", async () => {
    const store = makeStore();

    await expect(
      invalidateSessionsForSecurityEvent(
        { ...baseEvent, eventId: "" },
        store,
      ),
    ).rejects.toThrow(InvalidSecurityEventError);

    await expect(
      invalidateSessionsForSecurityEvent(
        { ...baseEvent, occurredAt: "invalid-timestamp" },
        store,
      ),
    ).rejects.toThrow(InvalidSecurityEventError);
  });
});

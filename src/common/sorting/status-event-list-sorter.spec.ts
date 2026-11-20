import {
  DeterministicSortValidationError,
  EventListItem,
  StatusListItem,
  UnauthorizedListSortError,
  fetchAndSortEventList,
  fetchAndSortStatusList,
  sortEventList,
  sortStatusList,
} from "./status-event-list-sorter";

describe("deterministic sorting for status and event lists", () => {
  const statusItems: StatusListItem[] = [
    { id: "svc-b", status: "OPERATIONAL", updatedAt: "2026-11-20T10:00:00Z" },
    { id: "svc-a", status: "OPERATIONAL", updatedAt: "2026-11-20T10:00:00Z" },
    { id: "svc-c", status: "CRITICAL", updatedAt: "2026-11-20T09:00:00Z" },
    { id: "svc-d", status: "DEGRADED", updatedAt: "2026-11-20T11:00:00Z" },
  ];

  const eventItems: EventListItem[] = [
    { id: "evt-3", type: "DEPLOY", timestamp: "2026-11-20T10:00:00Z", sequence: 2 },
    { id: "evt-1", type: "DEPLOY", timestamp: "2026-11-20T10:00:00Z", sequence: 2 },
    { id: "evt-2", type: "ALERT", timestamp: "2026-11-20T10:00:00Z", sequence: 3 },
    { id: "evt-4", type: "ROLLBACK", timestamp: "2026-11-20T11:00:00Z", sequence: 1 },
  ];

  it("sorts status lists deterministically regardless of input order without mutating input", () => {
    const forward = sortStatusList(statusItems);
    const reversed = sortStatusList([...statusItems].reverse());

    expect(forward.map((i) => i.id)).toEqual(["svc-c", "svc-d", "svc-a", "svc-b"]);
    expect(reversed.map((i) => i.id)).toEqual(forward.map((i) => i.id));
    expect(statusItems[0].id).toBe("svc-b");
  });

  it("sorts event lists deterministically by timestamp, sequence, type, and id tie-breaker", () => {
    const forward = sortEventList(eventItems);
    const reversed = sortEventList([...eventItems].reverse());

    expect(forward.map((e) => e.id)).toEqual(["evt-4", "evt-2", "evt-1", "evt-3"]);
    expect(reversed.map((e) => e.id)).toEqual(forward.map((e) => e.id));
  });

  it("retries transient fetch failures and succeeds on recovery", async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await fetchAndSortStatusList(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient DB timeout");
        }
        return statusItems;
      },
      {
        maxAttempts: 3,
        sleep: async (ms) => {
          delays.push(ms);
        },
        actor: { id: "ops-1", roles: ["OPERATOR"] },
      },
    );

    expect(result.attempts).toBe(2);
    expect(delays).toEqual([100]);
    expect(result.items.map((i) => i.id)).toEqual(["svc-c", "svc-d", "svc-a", "svc-b"]);
  });

  it("fails fast on validation errors and exhausts retries on persistent fetch failures", async () => {
    let calls = 0;
    await expect(
      fetchAndSortEventList(
        async () => {
          calls += 1;
          return [{ id: "bad-ts", type: "PING", timestamp: "not-a-date" }];
        },
        { maxAttempts: 3, backoffMs: 0, sleep: async () => undefined },
      ),
    ).rejects.toThrow(DeterministicSortValidationError);
    expect(calls).toBe(1);

    let failCalls = 0;
    await expect(
      fetchAndSortEventList(
        async () => {
          failCalls += 1;
          throw new Error("backend unavailable");
        },
        { maxAttempts: 2, backoffMs: 0, sleep: async () => undefined },
      ),
    ).rejects.toThrow("backend unavailable");
    expect(failCalls).toBe(2);
  });

  it("enforces actor role and tenant authorization before fetching", async () => {
    let fetched = false;
    const fetcher = async () => {
      fetched = true;
      return eventItems;
    };

    await expect(
      fetchAndSortEventList(fetcher, { requireAuthorizedActor: true }),
    ).rejects.toThrow(UnauthorizedListSortError);
    expect(fetched).toBe(false);

    await expect(
      fetchAndSortEventList(fetcher, {
        actor: { id: "user-1", roles: ["USER"], tenantId: "tenant-a" },
        requiredTenantId: "tenant-b",
      }),
    ).rejects.toThrow(UnauthorizedListSortError);
    expect(fetched).toBe(false);

    const allowed = await fetchAndSortEventList(fetcher, {
      actor: { id: "admin-1", roles: ["ADMIN"], tenantId: "tenant-a" },
      requiredTenantId: "tenant-b",
    });
    expect(fetched).toBe(true);
    expect(allowed.total).toBe(4);
  });

  it("rejects duplicate ids when rejectDuplicateIds is enabled", () => {
    expect(() =>
      sortStatusList(
        [
          { id: "dup-1", status: "CRITICAL", updatedAt: "2026-11-20T10:00:00Z" },
          { id: "dup-1", status: "OPERATIONAL", updatedAt: "2026-11-20T11:00:00Z" },
        ],
        { rejectDuplicateIds: true },
      ),
    ).toThrow(DeterministicSortValidationError);
  });
});

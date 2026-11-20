import {
  ProtectedRecord,
  RecordAccessActor,
  RecordVisibilityAccessError,
  evaluateRecordAccess,
  fetchAuthorizedRecord,
  filterVisibleRecords,
} from "./record-visibility-auth";

describe("authorization tests for hidden and archived records", () => {
  const activeRecord: ProtectedRecord = {
    id: "rec-active",
    ownerId: "user-1",
    tenantId: "tenant-a",
    visibility: "ACTIVE",
  };

  const hiddenRecord: ProtectedRecord = {
    id: "rec-hidden",
    ownerId: "user-1",
    tenantId: "tenant-a",
    visibility: "HIDDEN",
    hiddenAt: "2026-11-20T09:00:00Z",
  };

  const archivedRecord: ProtectedRecord = {
    id: "rec-archived",
    ownerId: "user-1",
    tenantId: "tenant-a",
    visibility: "ARCHIVED",
    archivedAt: "2026-11-19T09:00:00Z",
  };

  const admin: RecordAccessActor = { id: "admin-1", roles: ["ADMIN"], tenantId: "tenant-a" };
  const auditor: RecordAccessActor = { id: "auditor-1", roles: ["AUDITOR"], tenantId: "tenant-a" };
  const owner: RecordAccessActor = { id: "user-1", roles: ["USER"], tenantId: "tenant-a" };
  const otherUser: RecordAccessActor = { id: "user-2", roles: ["USER"], tenantId: "tenant-a" };
  const crossTenantUser: RecordAccessActor = { id: "user-3", roles: ["USER"], tenantId: "tenant-b" };

  it("allows normal reads on active records and privileged reads on hidden/archived records", () => {
    expect(evaluateRecordAccess(activeRecord, otherUser, "READ").allowed).toBe(true);
    expect(evaluateRecordAccess(hiddenRecord, admin, "READ").allowed).toBe(true);
    expect(evaluateRecordAccess(hiddenRecord, auditor, "READ").allowed).toBe(true);
    expect(evaluateRecordAccess(archivedRecord, admin, "READ").allowed).toBe(true);
    expect(evaluateRecordAccess(archivedRecord, owner, "READ").allowed).toBe(true);
    expect(evaluateRecordAccess(archivedRecord, admin, "RESTORE").allowed).toBe(true);
  });

  it("denies unauthenticated, unauthorized, and cross-tenant access fail-closed", () => {
    const unauth = evaluateRecordAccess(hiddenRecord, null, "READ");
    expect(unauth.allowed).toBe(false);
    expect(unauth.statusCode).toBe(401);

    const hiddenForUser = evaluateRecordAccess(hiddenRecord, otherUser, "READ");
    expect(hiddenForUser.allowed).toBe(false);
    expect(hiddenForUser.statusCode).toBe(404);

    const hiddenForOwnerDefault = evaluateRecordAccess(hiddenRecord, owner, "READ");
    expect(hiddenForOwnerDefault.allowed).toBe(false);
    expect(hiddenForOwnerDefault.statusCode).toBe(404);

    const archivedForOther = evaluateRecordAccess(archivedRecord, otherUser, "READ");
    expect(archivedForOther.allowed).toBe(false);
    expect(archivedForOther.statusCode).toBe(404);

    const crossTenant = evaluateRecordAccess(activeRecord, crossTenantUser, "READ");
    expect(crossTenant.allowed).toBe(false);
    expect(crossTenant.statusCode).toBe(404);
  });

  it("enforces archived immutability and blocks auditor mutations", () => {
    const updateArchivedAsAdmin = evaluateRecordAccess(archivedRecord, admin, "UPDATE");
    expect(updateArchivedAsAdmin.allowed).toBe(false);
    expect(updateArchivedAsAdmin.statusCode).toBe(403);

    const restoreHiddenAsAuditor = evaluateRecordAccess(hiddenRecord, auditor, "RESTORE");
    expect(restoreHiddenAsAuditor.allowed).toBe(false);
    expect(restoreHiddenAsAuditor.statusCode).toBe(404);

    const restoreArchivedAsOwner = evaluateRecordAccess(archivedRecord, owner, "RESTORE");
    expect(restoreArchivedAsOwner.allowed).toBe(false);
    expect(restoreArchivedAsOwner.statusCode).toBe(404);
  });

  it("filters hidden and archived records out of list results for unauthorized actors", () => {
    const all = [activeRecord, hiddenRecord, archivedRecord];

    expect(filterVisibleRecords(all, otherUser).map((r) => r.id)).toEqual(["rec-active"]);
    expect(filterVisibleRecords(all, owner).map((r) => r.id)).toEqual([
      "rec-active",
      "rec-archived",
    ]);
    expect(filterVisibleRecords(all, admin).map((r) => r.id)).toEqual([
      "rec-active",
      "rec-hidden",
      "rec-archived",
    ]);
    expect(filterVisibleRecords(all, null)).toEqual([]);
  });

  it("retries transient fetch errors before enforcing authorization", async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await fetchAuthorizedRecord(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient replica lag");
        return hiddenRecord;
      },
      admin,
      "READ",
      {
        maxAttempts: 3,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result.attempts).toBe(2);
    expect(delays).toEqual([100]);
    expect(result.record.id).toBe("rec-hidden");
  });

  it("fails closed on missing actor, missing record, unauthorized record, and retry exhaustion", async () => {
    let fetched = false;
    await expect(
      fetchAuthorizedRecord(
        async () => {
          fetched = true;
          return hiddenRecord;
        },
        null,
        "READ",
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(fetched).toBe(false);

    await expect(
      fetchAuthorizedRecord(async () => null, admin, "READ"),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      fetchAuthorizedRecord(async () => hiddenRecord, otherUser, "READ"),
    ).rejects.toThrow(RecordVisibilityAccessError);

    let failCalls = 0;
    await expect(
      fetchAuthorizedRecord(
        async () => {
          failCalls += 1;
          throw new Error("db unreachable");
        },
        admin,
        "READ",
        { maxAttempts: 2, backoffMs: 0, sleep: async () => undefined },
      ),
    ).rejects.toThrow("db unreachable");
    expect(failCalls).toBe(2);
  });
});

import { AuditLogService } from "./audit-log.service";

describe("AuditLogService retention", () => {
  it("reports and deletes eligible records while protecting active evidence", async () => {
    const oldDate = new Date("2010-01-01");
    const eligible = { id: "eligible", createdAt: oldDate, metadata: null };
    const protectedRecord = {
      id: "protected",
      createdAt: oldDate,
      metadata: { activeDisputeId: "dispute-1" },
    };
    const repo = {
      find: jest.fn().mockResolvedValue([eligible, protectedRecord]),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AuditLogService(repo as any, {} as any, {} as any);

    const preview = await service.previewRetention(new Date("2020-01-01"));
    expect(preview).toMatchObject({ scanned: 2, eligible: 1, protected: 1 });
    expect(preview.affectedIds).toEqual(["eligible"]);
    expect(preview.protectedIds).toEqual(["protected"]);

    const result = await service.enforceRetention();
    expect(repo.remove).toHaveBeenCalledWith([eligible]);
    expect(result.protectedIds).toEqual(["protected"]);
  });
});
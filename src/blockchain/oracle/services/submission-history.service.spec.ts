import { SubmissionHistoryService } from "./submission-history.service";

describe("SubmissionHistoryService", () => {
  const input = {
    payloadHash: "a".repeat(64),
    transactionHash: "b".repeat(64),
    submitter: "G" + "A".repeat(55),
  };
  let repository: any;
  let service: SubmissionHistoryService;
  beforeEach(() => {
    repository = {
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({ id: "1", ...v })),
      find: jest.fn().mockResolvedValue([]),
    };
    service = new SubmissionHistoryService(repository);
  });
  it("accepts and persists a first submission", async () => {
    expect(await service.record(input)).toMatchObject({
      ...input,
      verificationStatus: "pending",
    });
    expect(repository.save).toHaveBeenCalledTimes(1);
  });
  it("rejects an existing payload or transaction", async () => {
    repository.exists.mockResolvedValue(true);
    await expect(service.record(input)).rejects.toThrow("Duplicate");
    expect(repository.save).not.toHaveBeenCalled();
  });
  it("rejects a concurrent duplicate via the unique index", async () => {
    repository.save.mockRejectedValue({ code: "23505" });
    await expect(service.record(input)).rejects.toThrow("Duplicate");
  });
  it("retrieves stored history from a new service instance", async () => {
    repository.find.mockResolvedValue([input]);
    expect(await new SubmissionHistoryService(repository).history()).toEqual([
      input,
    ]);
    expect(repository.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100, skip: 0 }),
    );
  });
  it("normalizes hashes and rejects malformed input", async () => {
    expect(
      await service.record({
        ...input,
        payloadHash: input.payloadHash.toUpperCase(),
      }),
    ).toMatchObject(input);
    await expect(
      service.record({ ...input, payloadHash: "bad" }),
    ).rejects.toThrow("Expected");
  });
});

import {
  MAX_SUBMISSION_BATCH,
  SubmissionHistoryService,
} from "./submission-history.service";

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
      findOne: jest.fn().mockResolvedValue(null),
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
  describe("recordBatch", () => {
    const ref = (n: number) => ({
      payloadHash: n.toString(16).padStart(64, "0"),
      transactionHash: n.toString(16).padStart(64, "f"),
      submitter: input.submitter,
    });
    beforeEach(() => {
      let id = 0;
      repository.save.mockImplementation(async (v) => ({
        id: `r${++id}`,
        ...v,
      }));
    });

    it("records every valid reference with one lookup query", async () => {
      expect(await service.recordBatch([ref(1), ref(2)])).toEqual({
        total: 2,
        succeeded: 2,
        failed: 0,
        results: [
          { index: 0, status: "recorded", id: "r1", retryable: false },
          { index: 1, status: "recorded", id: "r2", retryable: false },
        ],
      });
      expect(repository.find).toHaveBeenCalledTimes(1);
      expect(repository.save).toHaveBeenCalledTimes(2);
    });

    it("reports partial failures in request order without aborting", async () => {
      repository.find.mockResolvedValue([
        { id: "old", ...ref(2), transactionHash: "e".repeat(64) },
      ]);
      const result = await service.recordBatch([
        ref(1),
        { ...ref(3), payloadHash: "bad" },
        ref(2),
        ref(4),
      ]);
      expect(result).toMatchObject({ total: 4, succeeded: 2, failed: 2 });
      expect(result.results.map((r) => r.status)).toEqual([
        "recorded",
        "invalid",
        "conflict",
        "recorded",
      ]);
    });

    it("makes a resent batch idempotent", async () => {
      repository.find.mockResolvedValue([{ id: "old", ...ref(1) }]);
      expect((await service.recordBatch([ref(1)])).results[0]).toEqual({
        index: 0,
        status: "already_recorded",
        id: "old",
        retryable: false,
      });
      expect(repository.save).not.toHaveBeenCalled();
    });

    it("resolves duplicates inside one batch against the first item", async () => {
      const result = await service.recordBatch([
        ref(1),
        ref(1),
        { ...ref(2), payloadHash: ref(1).payloadHash },
      ]);
      expect(result.results).toMatchObject([
        { status: "recorded", id: "r1" },
        { status: "already_recorded", id: "r1" },
        { status: "conflict" },
      ]);
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it("marks transient storage failures retryable and continues", async () => {
      repository.save.mockRejectedValueOnce(new Error("connection reset"));
      const result = await service.recordBatch([ref(1), ref(2)]);
      expect(result.results[0]).toEqual({
        index: 0,
        status: "failed",
        error: "Submission could not be stored",
        retryable: true,
      });
      expect(result.results[1].status).toBe("recorded");
    });

    it.each([
      ["already_recorded", { id: "won", ...ref(1) }],
      ["conflict", { id: "won", ...ref(1), submitter: "C" + "A".repeat(55) }],
    ])("classifies a lost insert race as %s", async (status, winner) => {
      repository.save.mockRejectedValueOnce({ driverError: { code: "23505" } });
      repository.findOne.mockResolvedValue(winner);
      expect((await service.recordBatch([ref(1)])).results[0].status).toBe(
        status,
      );
    });

    it.each([
      [[]],
      [Array.from({ length: MAX_SUBMISSION_BATCH + 1 }, (_, i) => ref(i))],
    ])("rejects batches outside the size bound", async (batch) => {
      await expect(service.recordBatch(batch)).rejects.toThrow("Batch must");
      expect(repository.find).not.toHaveBeenCalled();
    });
  });
});

import { ProvenanceService } from "./provenance.service";

describe("ProvenanceService streaming export", () => {
  it("streams large result sets in bounded batches and omits private fields", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `id-${String(index).padStart(4, "0")}`,
      agentId: "agent-export",
      userId: "user-1",
      action: "provider_call",
      status: "success",
      provider: "provider",
      providerModel: "model",
      createdAt: new Date(1_700_000_000_000 - index * 1000),
      onChainTxHash: null,
      processingDurationMs: index,
      input: { secret: "private-input-marker" },
      output: { secret: "private-output-marker" },
      error: "private-error-marker",
      metadata: { secret: "private-metadata-marker" },
      signature: "private-signature-marker",
      recordHash: "private-hash-marker",
    }));

    let offset = 0;
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockImplementation(async () => {
        const page = rows.slice(offset, offset + 250);
        offset += page.length;
        return page;
      }),
    };
    const repository = { createQueryBuilder: jest.fn(() => queryBuilder) };
    const service = new ProvenanceService(repository as any, { get: jest.fn() } as any);

    const chunks: string[] = [];
    for await (const chunk of service.streamProvenanceCsv({ userId: "user-1" })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(502); // header plus every row
    expect(queryBuilder.take).toHaveBeenCalledTimes(3);
    expect(queryBuilder.take).toHaveBeenCalledWith(250);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining("cursorCreatedAt"),
      expect.objectContaining({ cursorCreatedAt: expect.any(Date), cursorId: expect.any(String) }),
    );
    const csv = chunks.join("");
    expect(csv).toContain("id,agentId,userId,action,status,provider,providerModel,createdAt,onChainTxHash,processingDurationMs");
    expect(csv).not.toContain("private-input-marker");
    expect(csv).not.toContain("private-output-marker");
    expect(csv).not.toContain("private-error-marker");
    expect(csv).not.toContain("private-metadata-marker");
    expect(csv).not.toContain("private-signature-marker");
    expect(csv).not.toContain("private-hash-marker");
  });

  it("escapes CSV cells and neutralizes spreadsheet formula strings", async () => {
    const rows = [{
      id: "row-1",
      agentId: '=HYPERLINK("https://example.invalid")',
      userId: "user-1",
      action: "provider_call",
      status: "success",
      provider: null,
      providerModel: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      onChainTxHash: null,
      processingDurationMs: null,
    }];
    const builder = {
      select: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    const service = new ProvenanceService(
      { createQueryBuilder: jest.fn(() => builder) } as any,
      { get: jest.fn() } as any,
    );

    const chunks: string[] = [];
    for await (const chunk of service.streamProvenanceCsv({})) chunks.push(chunk);

    expect(chunks[1]).toContain("'=HYPERLINK(\"\"https://example.invalid\"\")");
  });

  it("stops before fetching data when the export is cancelled", async () => {
    const createQueryBuilder = jest.fn();
    const service = new ProvenanceService(
      { createQueryBuilder } as any,
      { get: jest.fn() } as any,
    );
    const abortController = new AbortController();
    const iterator = service.streamProvenanceCsv({}, 250, abortController.signal);

    expect((await iterator.next()).value).toContain("id,agentId,userId");
    abortController.abort();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });
});

import { withDatabaseTransaction } from "./transactional-database-harness";

describe("transactional database harness", () => {
  it("rolls back and releases after a successful spec body", async () => {
    const queryRunner = {
      isTransactionActive: true,
      manager: { query: jest.fn().mockResolvedValue([]) },
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockImplementation(async () => {
        queryRunner.isTransactionActive = false;
      }),
      release: jest.fn().mockResolvedValue(undefined),
    } as any;
    const dataSource = { createQueryRunner: () => queryRunner } as any;

    await withDatabaseTransaction(dataSource, async (manager) => {
      await manager.query("INSERT INTO fixture VALUES (1)");
    });

    expect(queryRunner.startTransaction).toHaveBeenCalledWith("READ COMMITTED");
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back before releasing when the spec body fails", async () => {
    const queryRunner = {
      isTransactionActive: true,
      manager: {},
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockImplementation(async () => {
        queryRunner.isTransactionActive = false;
      }),
      release: jest.fn().mockResolvedValue(undefined),
    } as any;
    await expect(
      withDatabaseTransaction({ createQueryRunner: () => queryRunner } as any, async () => {
        throw new Error("spec failed");
      }),
    ).rejects.toThrow("spec failed");
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });
});

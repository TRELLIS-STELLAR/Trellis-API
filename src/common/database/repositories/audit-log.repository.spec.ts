import { AuditLogRepository } from "./audit-log.repository";
import { AuditAction, LogLevel } from "../entities/audit-log.entity";

const mockDataSource = {
  getRepository: jest.fn(),
  createQueryRunner: jest.fn(),
} as any;

describe("AuditLogRepository", () => {
  let repo: AuditLogRepository;
  let qb: any;
  let repository: any;

  beforeEach(async () => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolved([]),
      getOne: jest.fn().mockResolved(null),
    };

    repository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    };

    mockDataSource.getRepository.mockReturnValue(repository);
    repo = new AuditLogRepository(mockDataSource);
  });

  describe("createLog", () => {
    it("creates audit log with defaults", async () => {
      repository.save = jest.fn().mockResolved({
        id: "1",
        action: AuditAction.ACCESS,
        level: LogLevel.INFO,
      });
      const result = await repo.createLog({
        action: AuditAction.ACCESS,
        ipAddress: "127.0.0.1",
      });
      expect(repository.save).toHaveBeenCalled();
      expect(result.action).toBe(AuditAction.ACCESS);
    });
  });

  describe("findByUserId", () => {
    it("queries by userId", async () => {
      qb.getMany.mockResolved([{ id: "1" }]);
      const result = await repo.findByUserId("user-1");
      expect(qb.andWhere).toHaveBeenCalledWith("entity.userId = :userId", {
        userId: "user-1",
      });
      expect(result).toHaveLength(1);
    });
  });

  describe("findByAction", () => {
    it("queries by action", async () => {
      qb.getMany.mockResolved([{ id: "1" }]);
      const result = await repo.findByAction(AuditAction.CREATE);
      expect(qb.andWhere).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });
  });

  describe("findByDateRange", () => {
    it("queries by date range", async () => {
      qb.getMany.mockResolved([{ id: "1" }]);
      const result = await repo.findByDateRange(
        new Date("2024-01-01"),
        new Date("2024-12-31"),
      );
      expect(qb.andWhere).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(1);
    });
  });

  describe("countByAction", () => {
    it("counts logs by action", async () => {
      repository.count = jest.fn().mockResolved(10);
      const result = await repo.countByAction(AuditAction.LOGIN);
      expect(result).toBe(10);
    });
  });

  describe("deleteOldLogs", () => {
    it("deletes old logs", async () => {
      const q = repository.createQueryBuilder();
      (q as any).delete = jest.fn().mockReturnThis();
      (q as any).from = jest.fn().mockReturnThis();
      (q as any).where = jest.fn().mockReturnThis();
      (q as any).execute = jest.fn().mockResolved({ affected: 5 });
      const result = await repo.deleteOldLogs(new Date("2020-01-01"));
      expect(result).toBe(5);
    });
  });

  describe("tamper-evident ledger", () => {
    const hash = (content: string) =>
      // Deterministic hash stand-in for test assertions.
      content.length.toString(16) + "0".repeat(64 - content.length.toString(16).length);

    it("assigns a hash chain on createLog", async () => {
      repository.findOne = jest.fn().mockResolved(null);
      repository.save = jest.fn().mockImplementation(async (e: any) => e);

      const result = await repo.createLog({
        action: AuditAction.LOGIN,
        ipAddress: "10.0.0.1",
      });
      expect(result.hash).toBeTruthy();
      expect(result.previousHash).toBeTruthy();
      expect(result.hash).toEqual(hash(`${result.previousHash}|${result.action}|${result.ipAddress}`));
    });

    it("links each entry to the previous hash", async () => {
      repository.findOne = jest.fn().mockResolved({
        id: "0",
        hash: "0abc",
      });
      repository.save = jest.fn().mockImplementation(async (e: any) => e);

      const result = await repo.createLog( {
        action: AuditAction.UPDATE,
        ipAddress: "10.0.0.2",
      });
      expect(result.previousHash).toBe("0abc");
    });

    it("returns true for an intact chain", async () => {
      const entries = [
        { id: "1", hash: "a1", previousHash: "0000" },
        { id: "2", hash: "a2", previousHash: "a1" },
      ];
      qb.getMany.mockResolved(entries);
      const result = await repo.verifyChain();
      expect(result.valid).toBe(true);
    });

    it("detects tampering when a hash is altered", async () => {
      const entries = [
        { id: "1", hash: "a1", previousHash: "0000" },
        { id: "2", hash: "a2", previousHash: "a1" },
        { id: "3", hash: "tampered", previousHash: "a2" },
      ];
      qb.getMany.mockResolved(entries);
      const result = await repo.verifyChain();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe("3");
    });

    it("detects tampering when a previous hash is altered", async () => {
      const entries = [
        { id: "1", hash: "a1", previousHash: "0000" },
        { id: "2", hash: "a2", previousHash: "wrong" },
      ];
      qb.getMany.mockResolved(entries);
      const result = await repo.verifyChain();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe("2");
    });

    it("exports the chain in a verifiable format", async () => {
      const entries = [
        { id: "1", hash: "a1", previousHash: "0000" },
        { id: "2", hash: "a2", previousHash: "a1" },
      ];
      qb.getMany.mockResolved(entries);
      const exported = await repo.exportChain();
      expect(exported).toHaveLength(2);
      expect(exported[0]).toHaveProperty("hash");
      expect(exported[1]).toHaveProperty("previousHash");
    });
  });
});

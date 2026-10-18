import { ConflictException } from "@nestjs/common";
import { ConcurrencyExecutor } from "./concurrency-executor";
import {
  OptimisticConcurrencyService,
  VersionedRecord,
} from "./optimistic-concurrency.service";

interface MockAccountRecord extends VersionedRecord {
  id: string;
  balance: number;
  version: number;
}

describe("Concurrency and Stale Version Tests (#295)", () => {
  let optimisticService: OptimisticConcurrencyService;
  let executor: ConcurrencyExecutor;

  beforeEach(() => {
    optimisticService = new OptimisticConcurrencyService();
    executor = new ConcurrencyExecutor(optimisticService);
  });

  describe("Duplicate submissions", () => {
    it("deduplicates parallel identical submissions ensuring single execution", async () => {
      let executionCount = 0;
      const operation = async () => {
        executionCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { txId: "tx_12345", status: "submitted" };
      };

      const results = await Promise.all([
        executor.executeIdempotent("sub_key_1", operation),
        executor.executeIdempotent("sub_key_1", operation),
        executor.executeIdempotent("sub_key_1", operation),
      ]);

      expect(executionCount).toBe(1);
      expect(results[0].result).toEqual({ txId: "tx_12345", status: "submitted" });
      expect(results[1].result).toEqual({ txId: "tx_12345", status: "submitted" });
      expect(results[2].result).toEqual({ txId: "tx_12345", status: "submitted" });

      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(true);
      expect(results[2].isDuplicate).toBe(true);
    });

    it("serves completed submissions from cache within TTL", async () => {
      let executionCount = 0;
      const operation = async () => {
        executionCount++;
        return { success: true };
      };

      const res1 = await executor.executeIdempotent("sub_key_2", operation);
      const res2 = await executor.executeIdempotent("sub_key_2", operation);

      expect(executionCount).toBe(1);
      expect(res1.isDuplicate).toBe(false);
      expect(res2.isDuplicate).toBe(true);
      expect(res2.result).toEqual({ success: true });
    });
  });

  describe("Stale versions and optimistic locking", () => {
    it("asserts current version and rejects stale version with structured conflict details", () => {
      const record: MockAccountRecord = { id: "acc_1", balance: 100, version: 2 };

      // Matching version succeeds
      expect(() => optimisticService.assertCurrent(record, 2)).not.toThrow();

      // Stale version fails
      try {
        optimisticService.assertCurrent(record, 1);
        fail("Should have thrown ConflictException");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const response = (err as ConflictException).getResponse() as any;
        expect(response.expectedVersion).toBe(1);
        expect(response.actualVersion).toBe(2);
        expect(response.action).toBe("refresh");
      }
    });

    it("prevents lost updates when two workers write concurrently to the same version", async () => {
      let databaseRecord: MockAccountRecord = {
        id: "acc_1",
        balance: 500,
        version: 1,
      };

      // Worker 1 and Worker 2 both read version 1
      const worker1Read = { ...databaseRecord };
      const worker2Read = { ...databaseRecord };

      // Worker 1 commits update to version 2
      optimisticService.assertCurrent(databaseRecord, worker1Read.version);
      databaseRecord = {
        ...worker1Read,
        balance: worker1Read.balance - 100,
        version: optimisticService.nextVersion(worker1Read.version),
      };

      expect(databaseRecord.balance).toBe(400);
      expect(databaseRecord.version).toBe(2);

      // Worker 2 attempts to commit using its stale read (version 1)
      expect(() =>
        optimisticService.assertCurrent(databaseRecord, worker2Read.version),
      ).toThrow(ConflictException);
    });

    it("retries automatically on conflict and succeeds when state updates", async () => {
      let dbRecord: MockAccountRecord = { id: "acc_2", balance: 1000, version: 1 };
      let callCount = 0;

      const fetchRecord = async () => ({ ...dbRecord });
      const mutate = async (current: MockAccountRecord) => {
        callCount++;
        // Simulate concurrent collision on the first attempt
        if (callCount === 1) {
          dbRecord = { ...dbRecord, balance: 950, version: 2 };
        }
        return {
          updated: { ...current, balance: current.balance - 50 },
          result: { deducted: 50 },
        };
      };

      const saveRecord = async (
        updated: MockAccountRecord,
        expectedVersion: number,
      ) => {
        if (dbRecord.version !== expectedVersion) {
          throw new ConflictException("Stale version conflict in store");
        }
        dbRecord = { ...updated };
        return dbRecord;
      };

      const outcome = await executor.executeWithRetry(
        fetchRecord,
        mutate,
        saveRecord,
        { maxRetries: 3, initialDelayMs: 5 },
      );

      expect(outcome.attempts).toBe(2);
      expect(outcome.result).toEqual({ deducted: 50 });
      expect(outcome.record.version).toBe(3);
      expect(outcome.record.balance).toBe(900);
    });

    it("throws if max retries are exceeded due to continuous conflicts", async () => {
      const dbRecord: MockAccountRecord = { id: "acc_3", balance: 100, version: 1 };

      const fetchRecord = async () => ({ ...dbRecord });
      const mutate = async (current: MockAccountRecord) => ({
        updated: { ...current, balance: current.balance + 10 },
        result: true,
      });

      const saveRecord = async () => {
        throw new ConflictException("Persistent conflict");
      };

      await expect(
        executor.executeWithRetry(fetchRecord, mutate, saveRecord, {
          maxRetries: 2,
          initialDelayMs: 2,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });
});

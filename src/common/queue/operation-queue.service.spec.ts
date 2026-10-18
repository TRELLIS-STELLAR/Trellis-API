import { OperationQueueService, InMemoryOperationQueueStorage } from "./operation-queue.service";
import { OptimisticConcurrencyService } from "../concurrency/optimistic-concurrency.service";
import { ConflictException } from "@nestjs/common";

describe("OperationQueueService (#240 Offline & Multi-Tab Conflict Queue)", () => {
  let queue: OperationQueueService;
  let storage: InMemoryOperationQueueStorage;
  let concurrencyService: OptimisticConcurrencyService;

  beforeEach(() => {
    storage = new InMemoryOperationQueueStorage();
    concurrencyService = new OptimisticConcurrencyService();
    queue = new OperationQueueService(storage, concurrencyService);
  });

  afterEach(() => {
    queue.close();
  });

  describe("Durability across refresh/disconnect", () => {
    it("persists operations in storage and survives queue re-instantiation", async () => {
      const op = await queue.enqueue({
        type: "UPDATE_PORTFOLIO_ALLOCATION",
        entityId: "portfolio-123",
        expectedVersion: 1,
        payload: { targetBtcPercent: 60, targetUsdcPercent: 40 },
      });

      expect(op.status).toBe("PENDING");
      expect(op.id).toBeDefined();

      // Simulate browser refresh or service restart: create fresh service instance with same storage
      const refreshedQueue = new OperationQueueService(storage, concurrencyService);
      const retrieved = await refreshedQueue.getOperation(op.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(op.id);
      expect(retrieved!.entityId).toBe("portfolio-123");
      expect(retrieved!.expectedVersion).toBe(1);
      expect(retrieved!.status).toBe("PENDING");
      refreshedQueue.close();
    });
  });

  describe("Successful processing", () => {
    it("completes operation when version matches expected version", async () => {
      const op = await queue.enqueue({
        type: "UPDATE_RISK_PROFILE",
        entityId: "user-profile-456",
        expectedVersion: 2,
        payload: { riskScore: 85 },
      });

      const processed = await queue.processNext(async (item) => {
        expect(item.id).toBe(op.id);
        return { actualVersion: 2 };
      });

      expect(processed).toBeDefined();
      expect(processed!.status).toBe("COMPLETED");

      const inStorage = await queue.getOperation(op.id);
      expect(inStorage!.status).toBe("COMPLETED");
    });
  });

  describe("Conflict Detection", () => {
    it("detects stale version conflict when executor returns a newer version", async () => {
      const op = await queue.enqueue({
        type: "SUBMIT_DEFI_REBALANCE",
        entityId: "vault-789",
        expectedVersion: 1,
        payload: { rebalanceStrategy: "AGGRESSIVE" },
      });

      // Target entity was modified concurrently by another tab or process to version 3
      const processed = await queue.processNext(async () => {
        return { actualVersion: 3 };
      });

      expect(processed).toBeDefined();
      expect(processed!.status).toBe("CONFLICT");
      expect(processed!.conflictDetails).toBeDefined();
      expect(processed!.conflictDetails!.expectedVersion).toBe(1);
      expect(processed!.conflictDetails!.actualVersion).toBe(3);
      expect(processed!.conflictDetails!.allowedChoices).toEqual([
        "RETRY_WITH_LATEST",
        "DISCARD",
        "FORCE_APPLY",
      ]);
    });

    it("detects conflict when executor throws a ConflictException", async () => {
      const op = await queue.enqueue({
        type: "UPDATE_NOTIFICATION_SETTINGS",
        entityId: "notif-pref-1",
        expectedVersion: 1,
        payload: { emailAlerts: true },
      });

      const processed = await queue.processNext(async () => {
        throw new ConflictException({
          actualVersion: 2,
          message: "Record was updated concurrently",
        });
      });

      expect(processed).toBeDefined();
      expect(processed!.status).toBe("CONFLICT");
      expect(processed!.conflictDetails!.actualVersion).toBe(2);
    });
  });

  describe("Deterministic Conflict Resolution Choices", () => {
    it("resolves via RETRY_WITH_LATEST: re-aligns version and marks PENDING for retry", async () => {
      const op = await queue.enqueue({
        type: "STAKE_ASSETS",
        entityId: "stake-pool-1",
        expectedVersion: 1,
        payload: { amount: 1000 },
      });

      // Cause conflict
      await queue.processNext(async () => ({ actualVersion: 4 }));

      // Resolve with RETRY_WITH_LATEST
      const resolved = await queue.resolveConflict(op.id, "RETRY_WITH_LATEST", {
        payload: { amount: 1200 }, // updated payload
      });

      expect(resolved.status).toBe("PENDING");
      expect(resolved.expectedVersion).toBe(4);
      expect(resolved.payload.amount).toBe(1200);
      expect(resolved.conflictDetails).toBeUndefined();

      // Now process again - matches version 4 and completes
      const reprocessed = await queue.processNext(async (item) => {
        expect(item.expectedVersion).toBe(4);
        return { actualVersion: 4 };
      });

      expect(reprocessed!.status).toBe("COMPLETED");
    });

    it("resolves via DISCARD: terminates operation cleanly without retry", async () => {
      const op = await queue.enqueue({
        type: "DEPOSIT_COLLATERAL",
        entityId: "vault-1",
        expectedVersion: 2,
        payload: { depositAmount: 500 },
      });

      await queue.processNext(async () => ({ actualVersion: 5 }));

      const discarded = await queue.resolveConflict(op.id, "DISCARD");
      expect(discarded.status).toBe("DISCARDED");

      // Verify no pending items remain to execute
      const next = await queue.processNext(async () => ({ actualVersion: 5 }));
      expect(next).toBeNull();
    });

    it("resolves via FORCE_APPLY: advances version and re-queues", async () => {
      const op = await queue.enqueue({
        type: "FORCE_UPDATE",
        entityId: "vault-2",
        expectedVersion: 1,
        payload: { param: "new" },
      });

      await queue.processNext(async () => ({ actualVersion: 2 }));

      const forced = await queue.resolveConflict(op.id, "FORCE_APPLY");
      expect(forced.status).toBe("PENDING");
      expect(forced.expectedVersion).toBe(2);
    });
  });

  describe("Offline connectivity simulation", () => {
    it("pauses processing when offline and preserves queue until reconnected", async () => {
      const op = await queue.enqueue({
        type: "OFFLINE_OP",
        entityId: "entity-offline",
        expectedVersion: 1,
        payload: { test: true },
      });

      // Disconnect
      queue.setOnline(false);
      expect(queue.isOnline()).toBe(false);

      const processedWhileOffline = await queue.processNext(async () => ({
        actualVersion: 1,
      }));
      expect(processedWhileOffline).toBeNull();

      const opStillPending = await queue.getOperation(op.id);
      expect(opStillPending!.status).toBe("PENDING");

      // Reconnect
      queue.setOnline(true);
      const processedOnline = await queue.processNext(async () => ({
        actualVersion: 1,
      }));

      expect(processedOnline).toBeDefined();
      expect(processedOnline!.status).toBe("COMPLETED");
    });
  });

  describe("Retry exhaustion", () => {
    it("retries up to maxRetries on transient errors then marks FAILED", async () => {
      const op = await queue.enqueue({
        type: "TRANSIENT_CALL",
        entityId: "api-down",
        expectedVersion: 1,
        payload: {},
        maxRetries: 2,
      });

      // Attempt 1 fails
      await queue.processNext(async () => {
        throw new Error("Network timeout 504");
      });
      let current = await queue.getOperation(op.id);
      expect(current!.status).toBe("PENDING");
      expect(current!.attempts).toBe(1);

      // Attempt 2 fails -> maxRetries reached -> FAILED
      await queue.processNext(async () => {
        throw new Error("Network timeout 504");
      });
      current = await queue.getOperation(op.id);
      expect(current!.status).toBe("FAILED");
      expect(current!.attempts).toBe(2);
      expect(current!.error).toContain("Network timeout 504");
    });
  });
});

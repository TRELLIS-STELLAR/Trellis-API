import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import {
  ConflictResolutionService,
  ConflictResolutionStrategy,
  EditRequest,
} from "./conflict-resolution.service";
import { OptimisticConcurrencyService } from "./optimistic-concurrency.service";

describe("ConflictResolutionService", () => {
  let service: ConflictResolutionService;
  let optimisticConcurrency: OptimisticConcurrencyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConflictResolutionService, OptimisticConcurrencyService],
    }).compile();

    service = module.get<ConflictResolutionService>(ConflictResolutionService);
    optimisticConcurrency = module.get<OptimisticConcurrencyService>(
      OptimisticConcurrencyService
    );
  });

  describe("Normal Path: No Conflicts", () => {
    it("should apply edit when no concurrent modification occurred", async () => {
      const currentState = {
        id: "resource_1",
        name: "Original",
        version: 1,
      };

      const request: EditRequest = {
        resourceId: "resource_1",
        resourceType: "document",
        baseVersion: 1,
        proposedData: {
          id: "resource_1",
          name: "Updated",
          version: 1,
        },
        userId: "user_1",
      };

      const getCurrentState = jest.fn().mockResolvedValue(currentState);
      const saveState = jest.fn().mockResolvedValue({
        ...request.proposedData,
        version: 2,
      });

      const result = await service.resolveEdit(request, getCurrentState, saveState);

      expect(result.success).toBe(true);
      expect(result.data.version).toBe(2);
      expect(result.data.name).toBe("Updated");
      expect(saveState).toHaveBeenCalled();
    });

    it("should detect retry of same edit (base version matches current)", async () => {
      const currentState = {
        id: "resource_1",
        name: "Already Updated",
        version: 2,
      };

      const request: EditRequest = {
        resourceId: "resource_1",
        resourceType: "document",
        baseVersion: 2, // Same as current
        proposedData: {
          id: "resource_1",
          name: "Already Updated",
          version: 2,
        },
        userId: "user_1",
      };

      const getCurrentState = jest.fn().mockResolvedValue(currentState);
      const saveState = jest.fn();

      const result = await service.resolveEdit(request, getCurrentState, saveState);

      expect(result.success).toBe(true);
      expect(result.message).toContain("retry");
      expect(saveState).not.toHaveBeenCalled();
    });
  });

  describe("Failure Path: Concurrent Modifications", () => {
    it("should detect concurrent modification (stale base version)", async () => {
      const currentState = {
        id: "resource_1",
        name: "Modified by another user",
        version: 2,
      };

      const request: EditRequest = {
        resourceId: "resource_1",
        resourceType: "document",
        baseVersion: 1, // Stale
        proposedData: {
          id: "resource_1",
          name: "My changes",
          version: 1,
        },
        userId: "user_1",
        strategy: ConflictResolutionStrategy.MANUAL,
      };

      const getCurrentState = jest.fn().mockResolvedValue(currentState);
      const saveState = jest.fn();

      const result = await service.resolveEdit(request, getCurrentState, saveState);

      expect(result.success).toBe(false);
      expect(result.requiresManualResolution).toBe(true);
      expect(saveState).not.toHaveBeenCalled();
    });

    it("should reject edit with first-write-wins strategy", async () => {
      const currentState = {
        id: "resource_1",
        field1: "changed",
        version: 2,
      };

      const request: EditRequest = {
        resourceId: "resource_1",
        resourceType: "document",
        baseVersion: 1,
        proposedData: {
          id: "resource_1",
          field1: "my edit",
          version: 1,
        },
        userId: "user_1",
        strategy: ConflictResolutionStrategy.FIRST_WRITE_WINS,
      };

      const getCurrentState = jest.fn().mockResolvedValue(currentState);
      const saveState = jest.fn();

      const result = await service.resolveEdit(request, getCurrentState, saveState);

      expect(result.success).toBe(false);
      expect(result.strategy).toBe(ConflictResolutionStrategy.FIRST_WRITE_WINS);
      expect(result.message).toContain("rejected");
      expect(saveState).not.toHaveBeenCalled();
    });
  });

  describe("Retry Path: Conflict Resolution Strategies", () => {
    describe("Three-Way Merge Strategy", () => {
      it("should merge non-conflicting changes from both sides", async () => {
        const currentState = {
          id: "doc_1",
          title: "Original Title",
          content: "Modified by user A",
          tags: ["tag1"],
          version: 2,
        };

        const request: EditRequest = {
          resourceId: "doc_1",
          resourceType: "document",
          baseVersion: 1,
          proposedData: {
            id: "doc_1",
            title: "Updated Title",
            content: "Original Content",
            tags: ["tag1"],
            version: 1,
          },
          userId: "user_b",
          strategy: ConflictResolutionStrategy.THREE_WAY_MERGE,
        };

        const getCurrentState = jest.fn().mockResolvedValue(currentState);
        const saveState = jest.fn().mockImplementation((data) =>
          Promise.resolve({ ...data })
        );

        const result = await service.resolveEdit(request, getCurrentState, saveState);

        expect(result.success).toBe(true);
        expect(result.data.title).toBe("Updated Title"); // User B's change
        expect(result.data.content).toBe("Modified by user A"); // User A's change
        expect(saveState).toHaveBeenCalled();
      });

      it("should detect conflicts when same field edited by both users", async () => {
        const currentState = {
          id: "doc_1",
          title: "Title by User A",
          version: 2,
        };

        const request: EditRequest = {
          resourceId: "doc_1",
          resourceType: "document",
          baseVersion: 1,
          proposedData: {
            id: "doc_1",
            title: "Title by User B",
            version: 1,
          },
          userId: "user_b",
          strategy: ConflictResolutionStrategy.THREE_WAY_MERGE,
        };

        const getCurrentState = jest.fn().mockResolvedValue(currentState);
        const saveState = jest.fn();

        const result = await service.resolveEdit(request, getCurrentState, saveState);

        expect(result.success).toBe(false);
        expect(result.conflicts).toBeDefined();
        expect(result.conflicts?.length).toBeGreaterThan(0);
        expect(result.conflicts?.[0].field).toBe("title");
        expect(saveState).not.toHaveBeenCalled();
      });
    });

    describe("Last Write Wins Strategy", () => {
      it("should overwrite with last write regardless of conflicts", async () => {
        const currentState = {
          id: "doc_1",
          title: "Modified by user A",
          content: "Content A",
          version: 2,
        };

        const request: EditRequest = {
          resourceId: "doc_1",
          resourceType: "document",
          baseVersion: 1,
          proposedData: {
            id: "doc_1",
            title: "Modified by user B",
            content: "Content B",
            version: 1,
          },
          userId: "user_b",
          strategy: ConflictResolutionStrategy.LAST_WRITE_WINS,
        };

        const getCurrentState = jest.fn().mockResolvedValue(currentState);
        const saveState = jest.fn().mockImplementation((data) =>
          Promise.resolve({ ...data })
        );

        const result = await service.resolveEdit(request, getCurrentState, saveState);

        expect(result.success).toBe(true);
        expect(result.data.title).toBe("Modified by user B");
        expect(result.data.content).toBe("Content B");
        expect(result.data.version).toBe(3);
        expect(saveState).toHaveBeenCalled();
      });
    });
  });

  describe("Authorization Path: User Tracking", () => {
    it("should track user ID in resolution attempts", async () => {
      const currentState = { id: "doc_1", version: 1 };

      const request: EditRequest = {
        resourceId: "doc_1",
        resourceType: "document",
        baseVersion: 1,
        proposedData: { id: "doc_1", title: "Updated", version: 1 },
        userId: "user_123",
      };

      const getCurrentState = jest.fn().mockResolvedValue(currentState);
      const saveState = jest.fn().mockResolvedValue({ ...request.proposedData, version: 2 });

      await service.resolveEdit(request, getCurrentState, saveState);

      const stats = service.getStatistics();
      const recentAttempt = stats.recentAttempts[stats.recentAttempts.length - 1];

      expect(recentAttempt.userId).toBe("user_123");
      expect(recentAttempt.resourceId).toBe("doc_1");
    });

    it("should track different users editing the same resource", async () => {
      const currentState = { id: "doc_1", version: 1 };

      for (const userId of ["user_a", "user_b", "user_c"]) {
        const request: EditRequest = {
          resourceId: "doc_1",
          resourceType: "document",
          baseVersion: 1,
          proposedData: { id: "doc_1", version: 1 },
          userId,
        };

        const getCurrentState = jest.fn().mockResolvedValue(currentState);
        const saveState = jest.fn().mockResolvedValue({ version: 2 });

        await service.resolveEdit(request, getCurrentState, saveState);
      }

      const stats = service.getStatistics("document");
      const userIds = stats.recentAttempts.map((a) => a.userId);

      expect(userIds).toContain("user_a");
      expect(userIds).toContain("user_b");
      expect(userIds).toContain("user_c");
    });
  });

  describe("Edge Cases and Recovery", () => {
    it("should handle invalid future version", async () => {
      const currentState = { id: "doc_1", version: 2 };

      const request: EditRequest = {
        resourceId: "doc_1",
        resourceType: "document",
        baseVersion: 5, // Future version
        proposedData: { id: "doc_1", version: 5 },
        userId: "user_1",
      };

      const getCurrentState = jest.fn().mockResolvedValue(currentState);
      const saveState = jest.fn();

      await expect(
        service.resolveEdit(request, getCurrentState, saveState)
      ).rejects.toThrow();
    });

    it("should handle empty proposed data", async () => {
      const currentState = { id: "doc_1", version: 1 };

      const request: EditRequest = {
        resourceId: "doc_1",
        resourceType: "document",
        baseVersion: 1,
        proposedData: {},
        userId: "user_1",
      };

      const getCurrentState = jest.fn().mockResolvedValue(currentState);
      const saveState = jest.fn().mockResolvedValue({ version: 2 });

      const result = await service.resolveEdit(request, getCurrentState, saveState);

      expect(result.success).toBe(true);
    });

    it("should maintain statistics across multiple operations", async () => {
      const operations = [
        { baseVersion: 1, currentVersion: 1, shouldSucceed: true },
        { baseVersion: 1, currentVersion: 2, shouldSucceed: false },
        { baseVersion: 2, currentVersion: 2, shouldSucceed: true },
      ];

      for (const op of operations) {
        const request: EditRequest = {
          resourceId: "doc_1",
          resourceType: "document",
          baseVersion: op.baseVersion,
          proposedData: { version: op.baseVersion },
          userId: "user_1",
          strategy: ConflictResolutionStrategy.MANUAL,
        };

        const getCurrentState = jest
          .fn()
          .mockResolvedValue({ version: op.currentVersion });
        const saveState = jest.fn().mockResolvedValue({ version: op.currentVersion + 1 });

        await service.resolveEdit(request, getCurrentState, saveState);
      }

      const stats = service.getStatistics();
      expect(stats.total).toBe(3);
      expect(stats.byOutcome.success).toBeGreaterThanOrEqual(1);
      expect(stats.byOutcome.conflict).toBeGreaterThanOrEqual(1);
    });

    it("should handle rollback by providing current state", async () => {
      const currentState = {
        id: "doc_1",
        title: "Current State",
        version: 3,
      };

      const request: EditRequest = {
        resourceId: "doc_1",
        resourceType: "document",
        baseVersion: 1, // Stale
        proposedData: { id: "doc_1", title: "Old Edit", version: 1 },
        userId: "user_1",
        strategy: ConflictResolutionStrategy.MANUAL,
      };

      const getCurrentState = jest.fn().mockResolvedValue(currentState);
      const saveState = jest.fn();

      const result = await service.resolveEdit(request, getCurrentState, saveState);

      // Client can rollback by using the returned current state
      expect(result.success).toBe(false);
      expect(result.data).toEqual(currentState);
      expect(result.version).toBe(3);
    });
  });

  describe("Statistics and Monitoring", () => {
    it("should provide comprehensive statistics", async () => {
      // Create multiple attempts with different outcomes
      const scenarios = [
        {
          strategy: ConflictResolutionStrategy.THREE_WAY_MERGE,
          baseVersion: 1,
          currentVersion: 1,
        },
        {
          strategy: ConflictResolutionStrategy.LAST_WRITE_WINS,
          baseVersion: 1,
          currentVersion: 2,
        },
        {
          strategy: ConflictResolutionStrategy.FIRST_WRITE_WINS,
          baseVersion: 1,
          currentVersion: 2,
        },
      ];

      for (const scenario of scenarios) {
        const request: EditRequest = {
          resourceId: "doc_1",
          resourceType: "document",
          baseVersion: scenario.baseVersion,
          proposedData: { version: scenario.baseVersion },
          userId: "user_1",
          strategy: scenario.strategy,
        };

        const getCurrentState = jest
          .fn()
          .mockResolvedValue({ version: scenario.currentVersion });
        const saveState = jest.fn().mockResolvedValue({ version: scenario.currentVersion + 1 });

        await service.resolveEdit(request, getCurrentState, saveState);
      }

      const stats = service.getStatistics();

      expect(stats.total).toBe(3);
      expect(stats.byStrategy).toBeDefined();
      expect(stats.conflictRate).toBeGreaterThanOrEqual(0);
      expect(stats.successRate).toBeGreaterThanOrEqual(0);
    });

    it("should filter statistics by resource type", async () => {
      const resourceTypes = ["document", "spreadsheet", "document"];

      for (let i = 0; i < resourceTypes.length; i++) {
        const request: EditRequest = {
          resourceId: `resource_${i}`,
          resourceType: resourceTypes[i],
          baseVersion: 1,
          proposedData: { version: 1 },
          userId: "user_1",
        };

        const getCurrentState = jest.fn().mockResolvedValue({ version: 1 });
        const saveState = jest.fn().mockResolvedValue({ version: 2 });

        await service.resolveEdit(request, getCurrentState, saveState);
      }

      const allStats = service.getStatistics();
      const docStats = service.getStatistics("document");

      expect(allStats.total).toBe(3);
      expect(docStats.total).toBe(2);
    });

    it("should limit in-memory attempts to 1000", async () => {
      // Create more than 1000 attempts
      for (let i = 0; i < 1100; i++) {
        const request: EditRequest = {
          resourceId: `doc_${i}`,
          resourceType: "document",
          baseVersion: 1,
          proposedData: { version: 1 },
          userId: "user_1",
        };

        const getCurrentState = jest.fn().mockResolvedValue({ version: 1 });
        const saveState = jest.fn().mockResolvedValue({ version: 2 });

        await service.resolveEdit(request, getCurrentState, saveState);
      }

      const stats = service.getStatistics();
      expect(stats.total).toBeLessThanOrEqual(1000);
    });
  });
});

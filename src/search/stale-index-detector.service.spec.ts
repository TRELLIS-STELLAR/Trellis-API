import { StaleIndexDetectorService } from "./stale-index-detector.service";
import { SearchVisibility } from "./entities/search-record.entity";
import {
  DiscrepancySeverity,
  DiscrepancyType,
  RepairActionType,
} from "./stale-detection.types";

describe("StaleIndexDetectorService (#244 Stale Cache/Index Detection & Repair)", () => {
  let service: StaleIndexDetectorService;
  let recordsRepoMock: any;
  let esServiceMock: any;
  let searchServiceMock: any;

  beforeEach(() => {
    recordsRepoMock = {
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    esServiceMock = {
      search: jest.fn(),
      delete: jest.fn(),
      index: jest.fn(),
    };

    searchServiceMock = {
      repairIndex: jest.fn(),
    };

    service = new StaleIndexDetectorService(
      recordsRepoMock,
      esServiceMock,
      searchServiceMock,
      undefined,
    );
  });

  describe("Discrepancy Detection", () => {
    it("detects MISSING_IN_INDEX when active DB record is not in ES", async () => {
      recordsRepoMock.find.mockResolvedValue([
        {
          id: "rec-1",
          title: "First Post",
          content: "Some content",
          visibility: SearchVisibility.PUBLIC,
          deletedAt: null,
          revokedAt: null,
        },
        {
          id: "rec-2",
          title: "Second Post",
          content: "More content",
          visibility: SearchVisibility.PUBLIC,
          deletedAt: null,
          revokedAt: null,
        },
      ]);

      esServiceMock.search.mockResolvedValue({
        hits: {
          hits: [
            {
              _id: "rec-1",
              _source: {
                title: "First Post",
                content: "Some content",
                visibility: SearchVisibility.PUBLIC,
              },
            },
          ],
        },
      });

      const report = await service.auditSearchIndex("posts");

      expect(report.discrepancyCount).toBe(1);
      expect(report.discrepancies[0].type).toBe(DiscrepancyType.MISSING_IN_INDEX);
      expect(report.discrepancies[0].id).toBe("rec-2");
      expect(report.recommendations.length).toBeGreaterThan(0);
    });

    it("detects ZOMBIE_IN_INDEX when soft-deleted/revoked record is still in ES", async () => {
      recordsRepoMock.find.mockResolvedValue([
        {
          id: "rec-zombie",
          title: "Revoked Post",
          content: "Deleted content",
          deletedAt: new Date(),
          revokedAt: null,
        },
      ]);

      esServiceMock.search.mockResolvedValue({
        hits: {
          hits: [
            {
              _id: "rec-zombie",
              _source: { title: "Revoked Post" },
            },
          ],
        },
      });

      const report = await service.auditSearchIndex("posts");

      expect(report.discrepancies.some((d) => d.type === DiscrepancyType.ZOMBIE_IN_INDEX)).toBe(
        true,
      );
      const zombieDiscrepancy = report.discrepancies.find(
        (d) => d.type === DiscrepancyType.ZOMBIE_IN_INDEX,
      );
      expect(zombieDiscrepancy?.id).toBe("rec-zombie");
    });

    it("detects CONTENT_MISMATCH when fields diverge between DB and ES", async () => {
      recordsRepoMock.find.mockResolvedValue([
        {
          id: "rec-updated",
          title: "New Fresh Title",
          content: "Updated DB Content",
          visibility: SearchVisibility.PUBLIC,
          deletedAt: null,
          revokedAt: null,
        },
      ]);

      esServiceMock.search.mockResolvedValue({
        hits: {
          hits: [
            {
              _id: "rec-updated",
              _source: {
                title: "Old Stale Title",
                content: "Updated DB Content",
                visibility: SearchVisibility.PUBLIC,
              },
            },
          ],
        },
      });

      const report = await service.auditSearchIndex("posts");

      expect(report.discrepancies[0].type).toBe(DiscrepancyType.CONTENT_MISMATCH);
      expect(report.discrepancies[0].reason).toContain("title");
    });
  });

  describe("Automated Repair Recommendations", () => {
    it("recommends FULL_REINDEX when drift ratio exceeds 25%", () => {
      const discrepancies = Array.from({ length: 30 }, (_, i) => ({
        id: `rec-${i}`,
        type: DiscrepancyType.MISSING_IN_INDEX,
        reason: "Missing",
        entityType: "SearchRecord",
        detectedAt: new Date(),
      }));

      const recommendations = service.generateRecommendations(
        "search:posts",
        100,
        discrepancies,
        0.3,
      );

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].action).toBe(RepairActionType.FULL_REINDEX);
      expect(recommendations[0].severity).toBe(DiscrepancySeverity.CRITICAL);
    });

    it("recommends BATCH_REINDEX when drift is moderate (10%)", () => {
      const discrepancies = Array.from({ length: 10 }, (_, i) => ({
        id: `rec-${i}`,
        type: DiscrepancyType.MISSING_IN_INDEX,
        reason: "Missing",
        entityType: "SearchRecord",
        detectedAt: new Date(),
      }));

      const recommendations = service.generateRecommendations(
        "search:posts",
        100,
        discrepancies,
        0.1,
      );

      expect(recommendations[0].action).toBe(RepairActionType.BATCH_REINDEX);
      expect(recommendations[0].severity).toBe(DiscrepancySeverity.HIGH);
    });

    it("recommends targeted INLINE_PURGE and INLINE_SYNC for isolated discrepancies", () => {
      const discrepancies = [
        {
          id: "zombie-1",
          type: DiscrepancyType.ZOMBIE_IN_INDEX,
          reason: "Deleted",
          entityType: "SearchRecord",
          detectedAt: new Date(),
        },
        {
          id: "missing-1",
          type: DiscrepancyType.MISSING_IN_INDEX,
          reason: "Not found",
          entityType: "SearchRecord",
          detectedAt: new Date(),
        },
      ];

      const recommendations = service.generateRecommendations(
        "search:posts",
        100,
        discrepancies,
        0.02,
      );

      expect(recommendations).toHaveLength(2);
      expect(recommendations.some((r) => r.action === RepairActionType.INLINE_PURGE)).toBe(true);
      expect(recommendations.some((r) => r.action === RepairActionType.INLINE_SYNC)).toBe(true);
    });
  });

  describe("Repair Execution", () => {
    it("performs dry-run without modifying Elasticsearch or DB", async () => {
      const recommendation = {
        id: "rec-plan-1",
        action: RepairActionType.FULL_REINDEX,
        severity: DiscrepancySeverity.CRITICAL,
        targetScope: "search:posts",
        affectedCount: 50,
        description: "Dry run test",
        automatedRepairPossible: true,
        estimatedImpact: "None",
        suggestedCommand: "test",
      };

      const result = await service.executeRepair(recommendation, { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.success).toBe(true);
      expect(result.repairedCount).toBe(50);
      expect(searchServiceMock.repairIndex).not.toHaveBeenCalled();
    });

    it("executes live FULL_REINDEX calling searchService.repairIndex()", async () => {
      searchServiceMock.repairIndex.mockResolvedValue({ indexed: 10, removed: 2 });

      const recommendation = {
        id: "rec-plan-2",
        action: RepairActionType.FULL_REINDEX,
        severity: DiscrepancySeverity.CRITICAL,
        targetScope: "search:posts",
        affectedCount: 12,
        description: "Full reindex",
        automatedRepairPossible: true,
        estimatedImpact: "Moderate",
        suggestedCommand: "test",
      };

      const result = await service.executeRepair(recommendation, { dryRun: false });

      expect(result.dryRun).toBe(false);
      expect(result.success).toBe(true);
      expect(result.repairedCount).toBe(12);
      expect(searchServiceMock.repairIndex).toHaveBeenCalled();
    });

    it("executes live INLINE_PURGE deleting zombie documents from Elasticsearch", async () => {
      esServiceMock.delete.mockResolvedValue({ result: "deleted" });

      const recommendation = {
        id: "rec-plan-3",
        action: RepairActionType.INLINE_PURGE,
        severity: DiscrepancySeverity.MEDIUM,
        targetScope: "search:posts",
        affectedCount: 2,
        description: "Purge zombies",
        automatedRepairPossible: true,
        estimatedImpact: "Low",
        suggestedCommand: "test",
        targetIds: ["zombie-1", "zombie-2"],
      };

      const result = await service.executeRepair(recommendation, { dryRun: false });

      expect(result.success).toBe(true);
      expect(result.repairedCount).toBe(2);
      expect(esServiceMock.delete).toHaveBeenCalledWith({ index: "posts", id: "zombie-1" });
      expect(esServiceMock.delete).toHaveBeenCalledWith({ index: "posts", id: "zombie-2" });
    });
  });
});

import {
  DeterministicSorter,
  DEFAULT_STATUS_PRIORITY,
} from "./deterministic-sorter";

interface TestEventRecord {
  id: string;
  status: string;
  timestamp: string;
  sequence?: number;
  payload?: string;
}

describe("DeterministicSorter", () => {
  const records: TestEventRecord[] = [
    { id: "evt-001", status: "COMPLETED", timestamp: "2026-10-18T10:00:00.000Z" },
    { id: "evt-002", status: "CRITICAL", timestamp: "2026-10-18T10:01:00.000Z" },
    { id: "evt-003", status: "PROCESSING", timestamp: "2026-10-18T10:00:30.000Z" },
    { id: "evt-004", status: "FAILED", timestamp: "2026-10-18T10:02:00.000Z" },
    { id: "evt-005", status: "PENDING", timestamp: "2026-10-18T10:00:45.000Z" },
    { id: "evt-006", status: "PROCESSING", timestamp: "2026-10-18T10:00:15.000Z" },
  ];

  describe("Status Priority & Multi-Tier Sorting", () => {
    it("should sort records according to status priority hierarchy", () => {
      const sorted = DeterministicSorter.sort(records, {
        sortFields: [{ field: "status", isStatus: true, direction: "ASC" }],
      });

      const sortedStatuses = sorted.map((r) => r.status);
      expect(sortedStatuses).toEqual([
        "CRITICAL",
        "PROCESSING",
        "PROCESSING",
        "PENDING",
        "COMPLETED",
        "FAILED",
      ]);
    });

    it("should break ties within the same status using timestamp", () => {
      const sorted = DeterministicSorter.sort(records, {
        sortFields: [
          { field: "status", isStatus: true, direction: "ASC" },
          { field: "timestamp", direction: "ASC" },
        ],
      });

      // evt-006 (10:00:15) should precede evt-003 (10:00:30) for PROCESSING status
      const processingEvents = sorted.filter((r) => r.status === "PROCESSING");
      expect(processingEvents[0].id).toBe("evt-006");
      expect(processingEvents[1].id).toBe("evt-003");
    });

    it("should deterministically break ties with identical timestamps and statuses using ID", () => {
      const identicalBatch: TestEventRecord[] = [
        { id: "id-zebra", status: "PENDING", timestamp: "2026-10-18T12:00:00.000Z" },
        { id: "id-alpha", status: "PENDING", timestamp: "2026-10-18T12:00:00.000Z" },
        { id: "id-charlie", status: "PENDING", timestamp: "2026-10-18T12:00:00.000Z" },
        { id: "id-bravo", status: "PENDING", timestamp: "2026-10-18T12:00:00.000Z" },
      ];

      const sortedAsc = DeterministicSorter.sort(identicalBatch, {
        sortFields: [
          { field: "status", isStatus: true },
          { field: "timestamp" },
        ],
        tieBreakerField: "id",
        tieBreakerDirection: "ASC",
      });

      expect(sortedAsc.map((r) => r.id)).toEqual([
        "id-alpha",
        "id-bravo",
        "id-charlie",
        "id-zebra",
      ]);

      const sortedDesc = DeterministicSorter.sort(identicalBatch, {
        sortFields: [
          { field: "status", isStatus: true },
          { field: "timestamp" },
        ],
        tieBreakerField: "id",
        tieBreakerDirection: "DESC",
      });

      expect(sortedDesc.map((r) => r.id)).toEqual([
        "id-zebra",
        "id-charlie",
        "id-bravo",
        "id-alpha",
      ]);
    });

    it("should allow custom status priority maps", () => {
      const customPriority = {
        FAILED: 1, // Prioritize errors first
        CRITICAL: 2,
        PROCESSING: 3,
        PENDING: 4,
        COMPLETED: 5,
      };

      const sorted = DeterministicSorter.sort(records, {
        sortFields: [
          {
            field: "status",
            isStatus: true,
            statusPriorityMap: customPriority,
            direction: "ASC",
          },
        ],
      });

      expect(sorted[0].status).toBe("FAILED");
      expect(sorted[1].status).toBe("CRITICAL");
    });
  });

  describe("Deterministic Cursor Pagination", () => {
    it("should paginate smoothly without duplicate items across page boundaries", () => {
      const allItems = records;
      const pageSize = 2;

      // Page 1
      const page1 = DeterministicSorter.paginate(allItems, {
        limit: pageSize,
        options: {
          sortFields: [{ field: "status", isStatus: true }],
          tieBreakerField: "id",
        },
      });

      expect(page1.items).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      // Page 2
      const page2 = DeterministicSorter.paginate(allItems, {
        limit: pageSize,
        cursor: page1.nextCursor!,
        options: {
          sortFields: [{ field: "status", isStatus: true }],
          tieBreakerField: "id",
        },
      });

      expect(page2.items).toHaveLength(2);
      expect(page2.hasMore).toBe(true);

      // Verify no overlap between page 1 and page 2
      const page1Ids = page1.items.map((i) => i.id);
      const page2Ids = page2.items.map((i) => i.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }

      // Page 3
      const page3 = DeterministicSorter.paginate(allItems, {
        limit: pageSize,
        cursor: page2.nextCursor!,
        options: {
          sortFields: [{ field: "status", isStatus: true }],
          tieBreakerField: "id",
        },
      });

      expect(page3.items).toHaveLength(2);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
    });

    it("should throw descriptive error on invalid cursor decoding", () => {
      expect(() => DeterministicSorter.decodeCursor("invalid-corrupted-cursor!#$")).toThrow(
        /Invalid or corrupted pagination cursor/,
      );
    });
  });

  describe("Null and Undefined Handling", () => {
    it("should place nulls at the end when nulls: 'last'", () => {
      const itemsWithNulls: TestEventRecord[] = [
        { id: "1", status: "PENDING", timestamp: "2026-10-18T10:00:00Z", sequence: undefined },
        { id: "2", status: "PENDING", timestamp: "2026-10-18T10:00:00Z", sequence: 10 },
        { id: "3", status: "PENDING", timestamp: "2026-10-18T10:00:00Z", sequence: 5 },
      ];

      const sorted = DeterministicSorter.sort(itemsWithNulls, {
        sortFields: [{ field: "sequence", direction: "ASC", nulls: "last" }],
      });

      expect(sorted[0].sequence).toBe(5);
      expect(sorted[1].sequence).toBe(10);
      expect(sorted[2].sequence).toBeUndefined();
    });
  });
});

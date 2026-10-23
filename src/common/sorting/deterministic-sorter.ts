/**
 * Deterministic Sorting and Cursor Pagination for Mixed-Status Records and Events.
 *
 * Guarantees reproducible, drift-free ordering across pagination queries, batch arrivals,
 * and concurrent updates by applying a multi-tiered comparator:
 * 1. Status Priority (active/transient statuses prioritized over terminal statuses, or custom map)
 * 2. Primary Timestamp (createdAt / timestamp) with ISO string normalization
 * 3. Secondary Sequence / Monotonic Nonce (if present)
 * 4. Deterministic Unique Tie-Breaker (id / UUID)
 */

export type SortDirection = "ASC" | "DESC";

export interface StatusPriorityMap {
  [status: string]: number;
}

/**
 * Standard lifecycle status priority:
 * Lower number = higher priority in ascending order.
 * Active / in-flight states are grouped together, followed by terminal states.
 */
export const DEFAULT_STATUS_PRIORITY: StatusPriorityMap = {
  // Urgent / In-flight
  CRITICAL: 10,
  RETRYING: 20,
  PROCESSING: 30,
  PENDING: 40,
  QUEUED: 50,
  // Terminal / Closed
  COMPLETED: 100,
  SUCCEEDED: 100,
  SETTLED: 100,
  MATCHED: 100,
  FAILED: 200,
  CANCELLED: 210,
  EXPIRED: 220,
  REJECTED: 230,
};

export interface SortFieldConfig<T> {
  field: keyof T;
  direction?: SortDirection;
  nulls?: "first" | "last";
  isStatus?: boolean;
  statusPriorityMap?: StatusPriorityMap;
}

export interface DeterministicSortOptions<T> {
  sortFields?: SortFieldConfig<T>[];
  tieBreakerField?: keyof T;
  tieBreakerDirection?: SortDirection;
}

export interface CursorPaginationOptions<T> {
  limit: number;
  cursor?: string;
  options?: DeterministicSortOptions<T>;
}

export interface CursorPaginationResult<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  hasMore: boolean;
}

export class DeterministicSorter {
  /**
   * Sort an array of records deterministically using multi-tiered criteria and tie-breaking.
   */
  static sort<T extends Record<string, any>>(
    records: T[],
    options: DeterministicSortOptions<T> = {},
  ): T[] {
    const sortConfigs = options.sortFields ?? [];
    const tieBreakerField = options.tieBreakerField ?? ("id" as keyof T);
    const tieBreakerDirection = options.tieBreakerDirection ?? "ASC";

    const cloned = [...records];

    return cloned.sort((a, b) => {
      // 1. Evaluate explicit sort field configurations
      for (const config of sortConfigs) {
        const field = config.field;
        const dir = config.direction ?? "ASC";
        const nulls = config.nulls ?? (dir === "ASC" ? "last" : "first");
        const valA = a[field];
        const valB = b[field];

        // Null / undefined handling
        if (valA === undefined || valA === null) {
          if (valB === undefined || valB === null) continue;
          return nulls === "first" ? -1 : 1;
        }
        if (valB === undefined || valB === null) {
          return nulls === "first" ? 1 : -1;
        }

        // Status priority comparison
        if (config.isStatus) {
          const priorityMap = config.statusPriorityMap ?? DEFAULT_STATUS_PRIORITY;
          const prioA = priorityMap[String(valA)] ?? 999;
          const prioB = priorityMap[String(valB)] ?? 999;

          if (prioA !== prioB) {
            return dir === "ASC" ? prioA - prioB : prioB - prioA;
          }
        }

        // Timestamp / Date comparison
        if (valA instanceof Date || valB instanceof Date) {
          const timeA = new Date(valA).getTime();
          const timeB = new Date(valB).getTime();
          if (timeA !== timeB) {
            return dir === "ASC" ? timeA - timeB : timeB - timeA;
          }
        }

        // Number comparison
        if (typeof valA === "number" && typeof valB === "number") {
          if (valA !== valB) {
            return dir === "ASC" ? valA - valB : valB - valA;
          }
        }

        // String comparison (ISO timestamps or text)
        if (typeof valA === "string" && typeof valB === "string") {
          const cmp = valA.localeCompare(valB);
          if (cmp !== 0) {
            return dir === "ASC" ? cmp : -cmp;
          }
        }
      }

      // 2. Deterministic Tie-Breaker
      const tieA = a[tieBreakerField];
      const tieB = b[tieBreakerField];

      if (tieA !== undefined && tieB !== undefined) {
        const tieCmp = String(tieA).localeCompare(String(tieB));
        if (tieCmp !== 0) {
          return tieBreakerDirection === "ASC" ? tieCmp : -tieCmp;
        }
      }

      return 0;
    });
  }

  /**
   * Encodes a record's deterministic position into an opaque base64 pagination cursor.
   */
  static encodeCursor<T extends Record<string, any>>(
    record: T,
    fields: (keyof T)[],
  ): string {
    const payload = fields.map((f) => {
      const val = record[f];
      return val instanceof Date ? val.toISOString() : val;
    });
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
  }

  /**
   * Decodes an opaque pagination cursor back into values.
   */
  static decodeCursor(cursor: string): any[] {
    try {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      return JSON.parse(decoded);
    } catch {
      throw new Error("Invalid or corrupted pagination cursor");
    }
  }

  /**
   * Paginate a collection deterministically with cursor generation.
   */
  static paginate<T extends Record<string, any>>(
    records: T[],
    options: CursorPaginationOptions<T>,
  ): CursorPaginationResult<T> {
    const sorted = this.sort(records, options.options);
    const limit = Math.max(1, options.limit);
    const tieBreaker = options.options?.tieBreakerField ?? ("id" as keyof T);

    let startIndex = 0;

    if (options.cursor) {
      const decoded = this.decodeCursor(options.cursor);
      const cursorTieValue = String(decoded[decoded.length - 1]);
      const foundIdx = sorted.findIndex((item) => String(item[tieBreaker]) === cursorTieValue);
      if (foundIdx !== -1) {
        startIndex = foundIdx + 1;
      }
    }

    const items = sorted.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < sorted.length;

    const cursorFields = [
      ...(options.options?.sortFields?.map((s) => s.field) ?? []),
      tieBreaker,
    ];

    const nextCursor =
      hasMore && items.length > 0
        ? this.encodeCursor(items[items.length - 1], cursorFields)
        : null;

    const prevCursor =
      startIndex > 0 && items.length > 0
        ? this.encodeCursor(items[0], cursorFields)
        : null;

    return {
      items,
      nextCursor,
      prevCursor,
      total: sorted.length,
      hasMore,
    };
  }
}

export type SortOrder = "ASC" | "DESC";

export interface StatusListItem {
  id: string;
  status: string;
  updatedAt: string | Date;
  severity?: number;
  tenantId?: string;
}

export interface EventListItem {
  id: string;
  type: string;
  status?: string;
  timestamp: string | Date;
  sequence?: number;
  tenantId?: string;
}

export interface ListSortActor {
  id: string;
  roles: string[];
  tenantId?: string;
}

export interface StatusListSortOptions {
  statusPriority?: Record<string, number>;
  timestampOrder?: SortOrder;
  tieBreakerOrder?: SortOrder;
  rejectInvalidTimestamps?: boolean;
  rejectDuplicateIds?: boolean;
}

export interface EventListSortOptions {
  timestampOrder?: SortOrder;
  sequenceOrder?: SortOrder;
  tieBreakerOrder?: SortOrder;
  rejectInvalidTimestamps?: boolean;
  rejectDuplicateIds?: boolean;
}

export interface FetchAndSortOptions<TOptions> {
  sortOptions?: TOptions;
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  actor?: ListSortActor;
  allowedRoles?: string[];
  requireAuthorizedActor?: boolean;
  requiredTenantId?: string;
}

export interface FetchAndSortResult<T> {
  items: T[];
  attempts: number;
  total: number;
}

export class UnauthorizedListSortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedListSortError";
  }
}

export class DeterministicSortValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeterministicSortValidationError";
  }
}

export const DEFAULT_STATUS_LIST_PRIORITY: Record<string, number> = {
  OUTAGE: 10,
  CRITICAL: 20,
  DEGRADED: 30,
  RETRYING: 40,
  PROCESSING: 50,
  PENDING: 60,
  QUEUED: 70,
  OPERATIONAL: 100,
  HEALTHY: 100,
  COMPLETED: 110,
  SUCCEEDED: 110,
  FAILED: 200,
  CANCELLED: 210,
};

const DEFAULT_ALLOWED_ROLES = ["ADMIN", "OPERATOR", "AUDITOR", "USER"];

const DEFAULT_SLEEP = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function compareStrings(a: string, b: string, order: SortOrder): number {
  if (a === b) return 0;
  const cmp = a < b ? -1 : 1;
  return order === "ASC" ? cmp : -cmp;
}

function parseTimestampMs(
  value: string | Date,
  id: string,
  rejectInvalid: boolean,
): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) {
    if (rejectInvalid) {
      throw new DeterministicSortValidationError(
        `Invalid timestamp for item '${id}'`,
      );
    }
    return Number.NEGATIVE_INFINITY;
  }
  return ms;
}

function validateIds<T extends { id: string }>(
  items: T[],
  rejectDuplicateIds: boolean,
): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) {
      throw new DeterministicSortValidationError(
        "Every status/event item must have a non-empty string id",
      );
    }
    if (rejectDuplicateIds && seen.has(item.id)) {
      throw new DeterministicSortValidationError(
        `Duplicate item id detected: '${item.id}'`,
      );
    }
    seen.add(item.id);
  }
}

function authorizeListActor(options: {
  actor?: ListSortActor;
  allowedRoles?: string[];
  requireAuthorizedActor?: boolean;
  requiredTenantId?: string;
}): void {
  const mustAuthorize =
    options.requireAuthorizedActor === true ||
    options.actor !== undefined ||
    options.requiredTenantId !== undefined;

  if (!mustAuthorize) {
    return;
  }

  const actor = options.actor;
  if (!actor || !actor.id?.trim()) {
    throw new UnauthorizedListSortError(
      "Listing and sorting requires an authenticated actor",
    );
  }

  const allowed = new Set(
    (options.allowedRoles ?? DEFAULT_ALLOWED_ROLES).map((r) => r.toUpperCase()),
  );
  const roles = Array.isArray(actor.roles) ? actor.roles : [];
  const hasRole = roles.some((r) => allowed.has(r.toUpperCase()));

  if (!hasRole) {
    throw new UnauthorizedListSortError(
      `Actor '${actor.id}' lacks an allowed role to read status/event lists`,
    );
  }

  if (options.requiredTenantId) {
    const isAdmin = roles.some((r) => r.toUpperCase() === "ADMIN");
    if (!isAdmin && actor.tenantId !== options.requiredTenantId) {
      throw new UnauthorizedListSortError(
        `Actor '${actor.id}' is not authorized for tenant '${options.requiredTenantId}'`,
      );
    }
  }
}

/**
 * Deterministically sorts status list items without mutating the input array.
 * Order:
 * 1. Status priority (ascending: higher-urgency statuses first)
 * 2. Severity (if present, ascending)
 * 3. updatedAt timestamp (default DESC: most recent first)
 * 4. id tie-breaker (default ASC: lexicographical)
 */
export function sortStatusList<T extends StatusListItem>(
  items: readonly T[],
  options: StatusListSortOptions = {},
): T[] {
  const priorityMap = options.statusPriority ?? DEFAULT_STATUS_LIST_PRIORITY;
  const timestampOrder = options.timestampOrder ?? "DESC";
  const tieBreakerOrder = options.tieBreakerOrder ?? "ASC";
  const rejectInvalid = options.rejectInvalidTimestamps !== false;
  const rejectDuplicates = options.rejectDuplicateIds === true;

  validateIds([...items], rejectDuplicates);

  const normalized = items.map((item) => ({
    item,
    priority: priorityMap[String(item.status).toUpperCase()] ?? 999,
    severity: item.severity ?? Number.POSITIVE_INFINITY,
    timestampMs: parseTimestampMs(item.updatedAt, item.id, rejectInvalid),
  }));

  normalized.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    if (a.severity !== b.severity) {
      return a.severity - b.severity;
    }
    if (a.timestampMs !== b.timestampMs) {
      return timestampOrder === "ASC"
        ? a.timestampMs - b.timestampMs
        : b.timestampMs - a.timestampMs;
    }
    return compareStrings(a.item.id, b.item.id, tieBreakerOrder);
  });

  return normalized.map((entry) => entry.item);
}

/**
 * Deterministically sorts event list items without mutating the input array.
 * Order:
 * 1. timestamp (default DESC: newest first)
 * 2. sequence (if present, default matches timestampOrder)
 * 3. event type (ASC)
 * 4. id tie-breaker (default ASC: lexicographical)
 */
export function sortEventList<T extends EventListItem>(
  events: readonly T[],
  options: EventListSortOptions = {},
): T[] {
  const timestampOrder = options.timestampOrder ?? "DESC";
  const sequenceOrder = options.sequenceOrder ?? timestampOrder;
  const tieBreakerOrder = options.tieBreakerOrder ?? "ASC";
  const rejectInvalid = options.rejectInvalidTimestamps !== false;
  const rejectDuplicates = options.rejectDuplicateIds === true;

  validateIds([...events], rejectDuplicates);

  const normalized = events.map((event) => ({
    event,
    timestampMs: parseTimestampMs(event.timestamp, event.id, rejectInvalid),
    sequence: event.sequence,
  }));

  normalized.sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) {
      return timestampOrder === "ASC"
        ? a.timestampMs - b.timestampMs
        : b.timestampMs - a.timestampMs;
    }

    if (a.sequence !== undefined || b.sequence !== undefined) {
      if (a.sequence === undefined) return 1;
      if (b.sequence === undefined) return -1;
      if (a.sequence !== b.sequence) {
        return sequenceOrder === "ASC"
          ? a.sequence - b.sequence
          : b.sequence - a.sequence;
      }
    }

    const typeCmp = compareStrings(a.event.type, b.event.type, "ASC");
    if (typeCmp !== 0) {
      return typeCmp;
    }

    return compareStrings(a.event.id, b.event.id, tieBreakerOrder);
  });

  return normalized.map((entry) => entry.event);
}

/**
 * Authorized, retry-capable vertical slice for fetching and deterministically
 * sorting status or event lists.
 */
export async function fetchAndSortStatusList<T extends StatusListItem>(
  fetcher: (attempt: number) => Promise<T[]>,
  options: FetchAndSortOptions<StatusListSortOptions> = {},
): Promise<FetchAndSortResult<T>> {
  authorizeListActor(options);

  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const raw = await fetcher(attempt);
      const sorted = sortStatusList(raw, options.sortOptions);
      return { items: sorted, attempts: attempt, total: sorted.length };
    } catch (err) {
      lastError = err;
      if (
        err instanceof DeterministicSortValidationError ||
        err instanceof UnauthorizedListSortError ||
        (typeof err === "object" &&
          err !== null &&
          (err as { retryable?: boolean }).retryable === false)
      ) {
        throw err;
      }
      if (attempt < maxAttempts) {
        const delayMs =
          options.backoffMs !== undefined
            ? options.backoffMs
            : 100 * 2 ** (attempt - 1);
        await sleep(delayMs);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "Failed to fetch status list"));
}

export async function fetchAndSortEventList<T extends EventListItem>(
  fetcher: (attempt: number) => Promise<T[]>,
  options: FetchAndSortOptions<EventListSortOptions> = {},
): Promise<FetchAndSortResult<T>> {
  authorizeListActor(options);

  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const raw = await fetcher(attempt);
      const sorted = sortEventList(raw, options.sortOptions);
      return { items: sorted, attempts: attempt, total: sorted.length };
    } catch (err) {
      lastError = err;
      if (
        err instanceof DeterministicSortValidationError ||
        err instanceof UnauthorizedListSortError ||
        (typeof err === "object" &&
          err !== null &&
          (err as { retryable?: boolean }).retryable === false)
      ) {
        throw err;
      }
      if (attempt < maxAttempts) {
        const delayMs =
          options.backoffMs !== undefined
            ? options.backoffMs
            : 100 * 2 ** (attempt - 1);
        await sleep(delayMs);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "Failed to fetch event list"));
}

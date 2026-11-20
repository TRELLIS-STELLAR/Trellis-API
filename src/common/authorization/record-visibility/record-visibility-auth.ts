export type RecordVisibilityState = "ACTIVE" | "HIDDEN" | "ARCHIVED";

export type RecordAccessAction = "READ" | "LIST" | "UPDATE" | "RESTORE";

export interface ProtectedRecord {
  id: string;
  ownerId: string;
  tenantId?: string;
  visibility: RecordVisibilityState;
  hiddenAt?: string;
  archivedAt?: string;
}

export interface RecordAccessActor {
  id: string;
  roles: string[];
  tenantId?: string;
}

export interface RecordVisibilityPolicyOptions {
  maskUnauthorizedAsNotFound?: boolean;
  allowOwnerReadHidden?: boolean;
  allowOwnerReadArchived?: boolean;
}

export interface RecordAccessDecision {
  allowed: boolean;
  statusCode: 200 | 401 | 403 | 404;
  reason: string;
}

export interface FetchAuthorizedRecordOptions
  extends RecordVisibilityPolicyOptions {
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchAuthorizedRecordResult<T extends ProtectedRecord> {
  record: T;
  attempts: number;
  decision: RecordAccessDecision;
}

export class RecordVisibilityAccessError extends Error {
  readonly statusCode: 401 | 403 | 404;

  constructor(statusCode: 401 | 403 | 404, message: string) {
    super(message);
    this.name = "RecordVisibilityAccessError";
    this.statusCode = statusCode;
  }
}

const DEFAULT_SLEEP = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function hasRole(actor: RecordAccessActor, role: string): boolean {
  const target = role.toUpperCase();
  return (
    Array.isArray(actor.roles) &&
    actor.roles.some((r) => r.toUpperCase() === target)
  );
}

/**
 * Evaluates whether an actor may perform `action` on a record given its
 * visibility state (ACTIVE, HIDDEN, ARCHIVED) and tenant/ownership boundaries.
 */
export function evaluateRecordAccess(
  record: ProtectedRecord,
  actor: RecordAccessActor | null | undefined,
  action: RecordAccessAction,
  options: RecordVisibilityPolicyOptions = {},
): RecordAccessDecision {
  if (!actor || !actor.id?.trim()) {
    return {
      allowed: false,
      statusCode: 401,
      reason: "Authentication required to access record",
    };
  }

  const maskAsNotFound = options.maskUnauthorizedAsNotFound !== false;
  const denyHiddenStatus: 403 | 404 = maskAsNotFound ? 404 : 403;

  const isAdmin = hasRole(actor, "ADMIN");
  const isAuditor = hasRole(actor, "AUDITOR");
  const isModerator = hasRole(actor, "MODERATOR");
  const isOwner = actor.id === record.ownerId;

  // Cross-tenant isolation (non-admins cannot access records from another tenant)
  if (record.tenantId && !isAdmin && actor.tenantId !== record.tenantId) {
    return {
      allowed: false,
      statusCode: denyHiddenStatus,
      reason: `Actor '${actor.id}' is outside tenant '${record.tenantId}'`,
    };
  }

  if (record.visibility === "ACTIVE") {
    if (action === "READ" || action === "LIST") {
      return { allowed: true, statusCode: 200, reason: "Active record readable" };
    }
    if (action === "UPDATE") {
      if (isAdmin || isOwner) {
        return { allowed: true, statusCode: 200, reason: "Active record updatable" };
      }
      return {
        allowed: false,
        statusCode: 403,
        reason: "Only owner or ADMIN may update an active record",
      };
    }
    // RESTORE on an already-active record is forbidden
    return {
      allowed: false,
      statusCode: 403,
      reason: "Cannot restore an already active record",
    };
  }

  if (record.visibility === "HIDDEN") {
    if (action === "READ" || action === "LIST") {
      if (
        isAdmin ||
        isAuditor ||
        isModerator ||
        (options.allowOwnerReadHidden === true && isOwner)
      ) {
        return { allowed: true, statusCode: 200, reason: "Authorized to view hidden record" };
      }
      return {
        allowed: false,
        statusCode: denyHiddenStatus,
        reason: "Hidden record is not accessible to this actor",
      };
    }

    if (action === "UPDATE" || action === "RESTORE") {
      if (isAdmin || isModerator) {
        return {
          allowed: true,
          statusCode: 200,
          reason: "Authorized to modify/restore hidden record",
        };
      }
      return {
        allowed: false,
        statusCode: denyHiddenStatus,
        reason: "Only ADMIN or MODERATOR may modify or restore hidden records",
      };
    }
  }

  // ARCHIVED records
  if (record.visibility === "ARCHIVED") {
    if (action === "UPDATE") {
      return {
        allowed: false,
        statusCode: 403,
        reason: "Archived records are immutable; restore before updating",
      };
    }
    if (action === "RESTORE") {
      if (isAdmin) {
        return { allowed: true, statusCode: 200, reason: "ADMIN authorized to restore archived record" };
      }
      return {
        allowed: false,
        statusCode: denyHiddenStatus,
        reason: "Only ADMIN may restore archived records",
      };
    }
    if (action === "READ" || action === "LIST") {
      if (
        isAdmin ||
        isAuditor ||
        (options.allowOwnerReadArchived !== false && isOwner)
      ) {
        return { allowed: true, statusCode: 200, reason: "Authorized to view archived record" };
      }
      return {
        allowed: false,
        statusCode: denyHiddenStatus,
        reason: "Archived record is not accessible to this actor",
      };
    }
  }

  return {
    allowed: false,
    statusCode: 403,
    reason: "Access denied by default fail-closed policy",
  };
}

/**
 * Filters a list of records to only those visible to the given actor.
 */
export function filterVisibleRecords<T extends ProtectedRecord>(
  records: readonly T[],
  actor: RecordAccessActor | null | undefined,
  options: RecordVisibilityPolicyOptions = {},
): T[] {
  return records.filter(
    (record) => evaluateRecordAccess(record, actor, "LIST", options).allowed,
  );
}

/**
 * Fetches a record with transient retry handling and enforces hidden/archived
 * authorization before returning it to the caller.
 */
export async function fetchAuthorizedRecord<T extends ProtectedRecord>(
  fetcher: (attempt: number) => Promise<T | null | undefined>,
  actor: RecordAccessActor | null | undefined,
  action: RecordAccessAction,
  options: FetchAuthorizedRecordOptions = {},
): Promise<FetchAuthorizedRecordResult<T>> {
  if (!actor || !actor.id?.trim()) {
    throw new RecordVisibilityAccessError(
      401,
      "Authentication required to access record",
    );
  }

  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  let lastError: unknown;
  let fetched: T | null | undefined;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      fetched = await fetcher(attempt);
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      const retryable =
        !(
          typeof err === "object" &&
          err !== null &&
          (err as { retryable?: boolean }).retryable === false
        );
      if (!retryable || attempt === maxAttempts) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      const delayMs =
        options.backoffMs !== undefined
          ? options.backoffMs
          : 100 * 2 ** (attempt - 1);
      await sleep(delayMs);
    }
  }

  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  if (!fetched) {
    throw new RecordVisibilityAccessError(404, "Record not found");
  }

  const decision = evaluateRecordAccess(fetched, actor, action, options);
  if (!decision.allowed) {
    throw new RecordVisibilityAccessError(decision.statusCode, decision.reason);
  }

  return { record: fetched, attempts, decision };
}

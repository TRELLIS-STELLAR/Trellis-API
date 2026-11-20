export type SecurityEventType =
  | "PASSWORD_CHANGED"
  | "MFA_DISABLED"
  | "CREDENTIAL_COMPROMISED"
  | "PRIVILEGE_ESCALATION"
  | "ACCOUNT_LOCKED"
  | "SUSPICIOUS_LOGIN"
  | "MANUAL_REVOKE_ALL";

export interface SecuritySessionEvent {
  eventId: string;
  userId: string;
  eventType: SecurityEventType;
  occurredAt: string | Date;
  excludeSessionId?: string;
  reason?: string;
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  active: boolean;
  createdAt: string;
  revokedAt?: string;
  revokedByEventId?: string;
}

export interface SessionRevocationMetadata {
  eventId: string;
  eventType: SecurityEventType;
  revokedAt: string;
  reason?: string;
}

export interface SessionInvalidationStore {
  listActiveSessions(userId: string): Promise<SessionRecord[]>;
  revokeSession(
    sessionId: string,
    metadata: SessionRevocationMetadata,
  ): Promise<void>;
  isEventProcessed?(eventId: string): Promise<boolean>;
  markEventProcessed?(eventId: string, processedAt: string): Promise<void>;
}

export interface SecurityInvalidationActor {
  id: string;
  roles: string[];
}

export interface SecuritySessionInvalidationOptions {
  actor?: SecurityInvalidationActor;
  allowedRoles?: string[];
  allowSelfServiceForUser?: boolean;
  requireAuthorizedActor?: boolean;
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface FailedSessionRevocation {
  sessionId: string;
  attempts: number;
  error: string;
}

export interface SecuritySessionInvalidationReport {
  eventId: string;
  userId: string;
  eventType: SecurityEventType;
  status:
    | "INVALIDATED"
    | "PARTIAL_FAILURE"
    | "ALREADY_PROCESSED"
    | "NO_ACTIVE_SESSIONS";
  invalidatedSessionIds: string[];
  preservedSessionIds: string[];
  failedSessionIds: FailedSessionRevocation[];
  processedAt: string;
}

export class UnauthorizedSessionInvalidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedSessionInvalidationError";
  }
}

export class InvalidSecurityEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSecurityEventError";
  }
}

const VALID_EVENT_TYPES = new Set<SecurityEventType>([
  "PASSWORD_CHANGED",
  "MFA_DISABLED",
  "CREDENTIAL_COMPROMISED",
  "PRIVILEGE_ESCALATION",
  "ACCOUNT_LOCKED",
  "SUSPICIOUS_LOGIN",
  "MANUAL_REVOKE_ALL",
]);

const FORCE_REVOKE_ALL_EVENTS = new Set<SecurityEventType>([
  "CREDENTIAL_COMPROMISED",
  "ACCOUNT_LOCKED",
]);

const SELF_SERVICE_ALLOWED_EVENTS = new Set<SecurityEventType>([
  "PASSWORD_CHANGED",
  "MANUAL_REVOKE_ALL",
]);

const DEFAULT_ALLOWED_ROLES = ["ADMIN", "SECURITY_OFFICER", "SYSTEM"];

const DEFAULT_SLEEP = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function validateEvent(event: SecuritySessionEvent): void {
  if (!event || !event.eventId?.trim()) {
    throw new InvalidSecurityEventError("Security event requires a non-empty eventId");
  }
  if (!event.userId?.trim()) {
    throw new InvalidSecurityEventError("Security event requires a non-empty userId");
  }
  if (!VALID_EVENT_TYPES.has(event.eventType)) {
    throw new InvalidSecurityEventError(
      `Unsupported security event type: '${String(event.eventType)}'`,
    );
  }
  const occurredMs =
    event.occurredAt instanceof Date
      ? event.occurredAt.getTime()
      : Date.parse(event.occurredAt);
  if (Number.isNaN(occurredMs)) {
    throw new InvalidSecurityEventError(
      `Security event '${event.eventId}' has an invalid occurredAt timestamp`,
    );
  }
}

function authorizeInvalidationActor(
  event: SecuritySessionEvent,
  options: SecuritySessionInvalidationOptions,
): void {
  const mustAuthorize =
    options.requireAuthorizedActor === true || options.actor !== undefined;
  if (!mustAuthorize) {
    return;
  }

  const actor = options.actor;
  if (!actor || !actor.id?.trim()) {
    throw new UnauthorizedSessionInvalidationError(
      "Security-event session invalidation requires an authenticated actor",
    );
  }

  const allowedRoles = new Set(
    (options.allowedRoles ?? DEFAULT_ALLOWED_ROLES).map((r) => r.toUpperCase()),
  );
  const roles = Array.isArray(actor.roles) ? actor.roles : [];
  const hasPrivilegedRole = roles.some((r) => allowedRoles.has(r.toUpperCase()));

  if (hasPrivilegedRole) {
    return;
  }

  const isSelfService =
    options.allowSelfServiceForUser === true &&
    actor.id === event.userId &&
    SELF_SERVICE_ALLOWED_EVENTS.has(event.eventType);

  if (isSelfService) {
    return;
  }

  throw new UnauthorizedSessionInvalidationError(
    `Actor '${actor.id}' is not authorized to invalidate sessions for user '${event.userId}' on event '${event.eventType}'`,
  );
}

async function runWithRetry<T>(
  operation: () => Promise<T>,
  maxAttempts: number,
  backoffMs: number | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: string; attempts: number }> {
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await operation();
      return { ok: true, value, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const retryable =
        !(
          typeof err === "object" &&
          err !== null &&
          (err as { retryable?: boolean }).retryable === false
        );
      if (!retryable || attempt === maxAttempts) {
        return { ok: false, error: lastError, attempts: attempt };
      }
      const delay =
        backoffMs !== undefined ? backoffMs : 100 * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }
  return { ok: false, error: lastError, attempts: maxAttempts };
}

export async function invalidateSessionsForSecurityEvent(
  event: SecuritySessionEvent,
  store: SessionInvalidationStore,
  options: SecuritySessionInvalidationOptions = {},
): Promise<SecuritySessionInvalidationReport> {
  validateEvent(event);
  authorizeInvalidationActor(event, options);

  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const now = options.now ?? (() => new Date());
  const processedAt = now().toISOString();

  if (store.isEventProcessed) {
    const alreadyProcessed = await store.isEventProcessed(event.eventId);
    if (alreadyProcessed) {
      return {
        eventId: event.eventId,
        userId: event.userId,
        eventType: event.eventType,
        status: "ALREADY_PROCESSED",
        invalidatedSessionIds: [],
        preservedSessionIds: [],
        failedSessionIds: [],
        processedAt,
      };
    }
  }

  const listResult = await runWithRetry(
    () => store.listActiveSessions(event.userId),
    maxAttempts,
    options.backoffMs,
    sleep,
  );

  if (!listResult.ok) {
    throw new Error(
      `Failed to list active sessions for user '${event.userId}' after ${listResult.attempts} attempt(s): ${listResult.error}`,
    );
  }

  const activeSessions = listResult.value.filter((s) => s.active);
  if (activeSessions.length === 0) {
    if (store.markEventProcessed) {
      await store.markEventProcessed(event.eventId, processedAt);
    }
    return {
      eventId: event.eventId,
      userId: event.userId,
      eventType: event.eventType,
      status: "NO_ACTIVE_SESSIONS",
      invalidatedSessionIds: [],
      preservedSessionIds: [],
      failedSessionIds: [],
      processedAt,
    };
  }

  const forceRevokeAll = FORCE_REVOKE_ALL_EVENTS.has(event.eventType);
  const invalidatedSessionIds: string[] = [];
  const preservedSessionIds: string[] = [];
  const failedSessionIds: FailedSessionRevocation[] = [];

  for (const session of activeSessions) {
    if (
      !forceRevokeAll &&
      event.excludeSessionId &&
      session.sessionId === event.excludeSessionId
    ) {
      preservedSessionIds.push(session.sessionId);
      continue;
    }

    const revokeResult = await runWithRetry(
      () =>
        store.revokeSession(session.sessionId, {
          eventId: event.eventId,
          eventType: event.eventType,
          revokedAt: processedAt,
          reason: event.reason,
        }),
      maxAttempts,
      options.backoffMs,
      sleep,
    );

    if (revokeResult.ok) {
      invalidatedSessionIds.push(session.sessionId);
    } else {
      failedSessionIds.push({
        sessionId: session.sessionId,
        attempts: revokeResult.attempts,
        error: revokeResult.error,
      });
    }
  }

  const hasFailures = failedSessionIds.length > 0;
  if (!hasFailures && store.markEventProcessed) {
    await store.markEventProcessed(event.eventId, processedAt);
  }

  return {
    eventId: event.eventId,
    userId: event.userId,
    eventType: event.eventType,
    status: hasFailures ? "PARTIAL_FAILURE" : "INVALIDATED",
    invalidatedSessionIds,
    preservedSessionIds,
    failedSessionIds,
    processedAt,
  };
}

export class InMemorySessionInvalidationStore implements SessionInvalidationStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly processedEvents = new Map<string, string>();

  constructor(initialSessions: SessionRecord[] = []) {
    for (const s of initialSessions) {
      this.sessions.set(s.sessionId, { ...s });
    }
  }

  async listActiveSessions(userId: string): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId && s.active,
    );
  }

  async revokeSession(
    sessionId: string,
    metadata: SessionRevocationMetadata,
  ): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    this.sessions.set(sessionId, {
      ...existing,
      active: false,
      revokedAt: metadata.revokedAt,
      revokedByEventId: metadata.eventId,
    });
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    return this.processedEvents.has(eventId);
  }

  async markEventProcessed(eventId: string, processedAt: string): Promise<void> {
    this.processedEvents.set(eventId, processedAt);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }
}

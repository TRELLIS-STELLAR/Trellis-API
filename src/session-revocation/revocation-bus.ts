import { ForbiddenException, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Role } from "../common/guard/roles.enum";

/**
 * Session revocation broadcast bus with token family invalidation (#526).
 *
 * Problem: a refresh-token family revoked on one replica (reuse detected,
 * "log out everywhere", an operator action) must also stop being honoured on
 * every other replica. Per-process state cannot do that. This bus carries a
 * `token-family` event to all instances and each one records the invalidation
 * locally, so the check at rotation time is a cheap in-memory lookup.
 *
 * Design:
 *  - Local first. `revokeFamily` records the invalidation on this node before
 *    anything is published, so a broken transport never leaves this node
 *    accepting a revoked family.
 *  - Publish with retry. Transient publish failures are retried with backoff.
 *    A still-failing event stays in an outbox, and `flushOutbox()` resends it.
 *  - Idempotent receive. Every event carries a stable id. A receiver that has
 *    already applied an id ignores the duplicate, so retries and redelivery are
 *    safe.
 *  - Additive only. An invalidation is never cleared by an event. It expires
 *    by TTL, which is set to the longest refresh-token lifetime, so it outlives
 *    every token it could cover.
 *  - Authorization. Only ADMIN and SERVICE_ACTOR may initiate a revocation.
 *    The check runs before any local or remote state changes.
 *
 * Transport: `RevocationTransport` is the only infrastructure seam. The
 * in-memory hub is used for single-process deployments and tests. A Redis
 * pub/sub transport implementing the same interface is the production path for
 * multi-replica deployments. It is not included in this change.
 */

export type RevocationEventKind = "token-family";

export interface RevocationEvent {
  /** Stable across retries and redelivery. Receivers dedupe on it. */
  id: string;
  kind: RevocationEventKind;
  /** The refresh-token family id to invalidate. */
  target: string;
  reason: string;
  /** Epoch ms when the revocation was issued. */
  issuedAt: number;
  /** Node that issued the revocation. */
  origin: string;
}

export interface RevocationTransport {
  publish(event: RevocationEvent): Promise<void>;
  subscribe(handler: (event: RevocationEvent) => void): () => void;
}

/** A transport that fans every event out to all subscribers. Shared by nodes in one process. */
export class InMemoryRevocationHub implements RevocationTransport {
  private readonly subscribers = new Set<(event: RevocationEvent) => void>();
  /** Test hook: the next N publishes reject, to exercise retry and outbox paths. */
  failNextPublishes = 0;

  async publish(event: RevocationEvent): Promise<void> {
    if (this.failNextPublishes > 0) {
      this.failNextPublishes--;
      throw new Error("broadcast transport unavailable");
    }
    for (const handler of [...this.subscribers]) {
      handler(event);
    }
  }

  subscribe(handler: (event: RevocationEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }
}

export interface TokenFamilyInvalidationRecord {
  familyId: string;
  reason: string;
  invalidatedAt: number;
  eventId: string;
}

export interface TokenFamilyInvalidationsOptions {
  /** How long an invalidation is remembered. Set to the longest refresh lifetime. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Per-node record of invalidated token families and of applied event ids.
 * Both are bounded by TTL, so the maps cannot grow without limit.
 */
export class TokenFamilyInvalidations {
  private readonly families = new Map<
    string,
    TokenFamilyInvalidationRecord & { expiresAt: number }
  >();
  private readonly appliedEvents = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TokenFamilyInvalidationsOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  invalidate(record: TokenFamilyInvalidationRecord): void {
    this.sweep();
    const existing = this.families.get(record.familyId);
    // Keep the first record. A later duplicate must not rewrite the audit trail.
    if (existing) return;
    this.families.set(record.familyId, {
      ...record,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  isInvalidated(familyId: string): boolean {
    this.sweep();
    return this.families.has(familyId);
  }

  get(familyId: string): TokenFamilyInvalidationRecord | undefined {
    this.sweep();
    const entry = this.families.get(familyId);
    if (!entry) return undefined;
    const { expiresAt: _expiresAt, ...record } = entry;
    return record;
  }

  /** Returns true the first time an event id is seen, false for a duplicate. */
  markApplied(eventId: string): boolean {
    this.sweep();
    if (this.appliedEvents.has(eventId)) return false;
    this.appliedEvents.set(eventId, this.now() + this.ttlMs);
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.families) {
      if (now > entry.expiresAt) this.families.delete(id);
    }
    for (const [id, expiresAt] of this.appliedEvents) {
      if (now > expiresAt) this.appliedEvents.delete(id);
    }
  }
}

export interface RevocationBusOptions {
  node: string;
  transport: RevocationTransport;
  invalidations: TokenFamilyInvalidations;
  /** Publish attempts per event before it is parked in the outbox. Defaults to 3. */
  maxPublishAttempts?: number;
  /** Base backoff in ms, doubled per attempt. Defaults to 50. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RevocationResult {
  eventId: string;
  /** The family is invalidated on this node. Always true on success. */
  localInvalidated: boolean;
  /** Every attempt to publish succeeded. */
  broadcast: boolean;
  /** Publish attempts made. */
  attempts: number;
}

export interface RevocationActor {
  id: string;
  roles: Role[];
}

const MAX_REASON_LENGTH = 200;
const KINDS: ReadonlySet<string> = new Set<RevocationEventKind>([
  "token-family",
]);

export class RevocationBus {
  private readonly logger = new Logger(RevocationBus.name);
  private readonly outbox = new Map<string, RevocationEvent>();
  private readonly unsubscribe: () => void;
  private readonly maxPublishAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: RevocationBusOptions) {
    this.maxPublishAttempts = Math.max(1, options.maxPublishAttempts ?? 3);
    this.retryDelayMs = options.retryDelayMs ?? 50;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    // A node also receives its own events, so its local state goes through the same path.
    this.unsubscribe = options.transport.subscribe((event) =>
      this.receive(event),
    );
  }

  /** Stop receiving events. Call on module destroy. */
  close(): void {
    this.unsubscribe();
  }

  /**
   * Invalidate a token family on every node.
   *
   * Throws ForbiddenException for an unauthorized actor, before anything changes.
   * Throws for an invalid family or reason, before anything changes.
   */
  async revokeFamily(
    actor: RevocationActor,
    familyId: string,
    reason: string,
  ): Promise<RevocationResult> {
    if (
      !actor.roles.includes(Role.ADMIN) &&
      !actor.roles.includes(Role.SERVICE_ACTOR)
    ) {
      throw new ForbiddenException(
        "Only ADMIN or SERVICE_ACTOR may revoke a token family",
      );
    }
    if (!familyId || familyId.trim() !== familyId) {
      throw new Error(
        "revokeFamily requires a non-empty family id without surrounding whitespace",
      );
    }
    if (!reason || reason.length > MAX_REASON_LENGTH) {
      throw new Error(
        `revokeFamily reason must be 1-${MAX_REASON_LENGTH} characters`,
      );
    }

    const event: RevocationEvent = {
      id: randomUUID(),
      kind: "token-family",
      target: familyId,
      reason,
      issuedAt: this.now(),
      origin: this.options.node,
    };

    // Local first: this node refuses the family even if the broadcast fails.
    this.apply(event);

    const { delivered, attempts } = await this.publishWithRetry(event);
    if (!delivered) {
      this.outbox.set(event.id, event);
      this.logger.error(
        `revocation ${event.id} for family ${familyId} applied locally; broadcast parked in outbox`,
      );
    }
    return {
      eventId: event.id,
      localInvalidated: true,
      broadcast: delivered,
      attempts,
    };
  }

  /**
   * Resend parked events. Safe to call repeatedly: receivers dedupe by id, and
   * an event leaves the outbox only once it has been published.
   * Returns the number of events delivered.
   */
  async flushOutbox(): Promise<number> {
    let delivered = 0;
    for (const event of [...this.outbox.values()]) {
      const result = await this.publishWithRetry(event);
      if (result.delivered) {
        this.outbox.delete(event.id);
        delivered++;
      }
    }
    return delivered;
  }

  pendingBroadcasts(): number {
    return this.outbox.size;
  }

  /** Receive an event from the transport. Invalid or duplicate events are ignored. */
  receive(event: RevocationEvent): boolean {
    if (!isValidEvent(event)) {
      this.logger.warn("dropped malformed revocation event");
      return false;
    }
    return this.apply(event);
  }

  private apply(event: RevocationEvent): boolean {
    const { invalidations } = this.options;
    if (!invalidations.markApplied(event.id)) return false;
    invalidations.invalidate({
      familyId: event.target,
      reason: event.reason,
      invalidatedAt: event.issuedAt,
      eventId: event.id,
    });
    return true;
  }

  private async publishWithRetry(
    event: RevocationEvent,
  ): Promise<{ delivered: boolean; attempts: number }> {
    let attempts = 0;
    for (let attempt = 1; attempt <= this.maxPublishAttempts; attempt++) {
      attempts = attempt;
      try {
        await this.options.transport.publish(event);
        return { delivered: true, attempts };
      } catch (error) {
        this.logger.warn(
          `revocation publish attempt ${attempt}/${this.maxPublishAttempts} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (attempt < this.maxPublishAttempts && this.retryDelayMs > 0) {
          await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
        }
      }
    }
    return { delivered: false, attempts };
  }
}

export function isValidEvent(event: unknown): event is RevocationEvent {
  if (!event || typeof event !== "object") return false;
  const e = event as Partial<RevocationEvent>;
  return (
    typeof e.id === "string" &&
    e.id.length > 0 &&
    typeof e.kind === "string" &&
    KINDS.has(e.kind) &&
    typeof e.target === "string" &&
    e.target.length > 0 &&
    typeof e.reason === "string" &&
    e.reason.length > 0 &&
    e.reason.length <= MAX_REASON_LENGTH &&
    typeof e.issuedAt === "number" &&
    Number.isFinite(e.issuedAt) &&
    typeof e.origin === "string"
  );
}

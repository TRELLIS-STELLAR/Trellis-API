import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { DomainEventEnvelope } from "../domain-event-schema";
import {
  DeadLetterAuthorizationError,
  DeadLetterNotFoundError,
  DomainEventHandlerNotFoundError,
} from "./event-dead-letter.errors";
import {
  DeadLetterEntry,
  DeadLetterListFilter,
  DeadLetterOperator,
  DeadLetterReplayResult,
  DeadLetterStats,
  DeadLetterSummary,
  DispatchOutcome,
  DomainEventHandlerRegistration,
} from "./event-dead-letter.types";

const MAX_ERROR_LENGTH = 500;

/**
 * Dead-letter recovery for failed domain-event handlers (issue #354).
 *
 * Delivery model:
 * 1. `dispatch(envelope)` fans the event out to every handler registered for
 *    that event name.
 * 2. Each handler runs with a bounded retry budget (exponential-ish backoff).
 * 3. A handler that exhausts its budget is captured in the dead-letter store;
 *    the other handlers and the caller are unaffected.
 * 4. An operator can inspect, `replay()` after a fix, or `discard()` with a
 *    reason. Replays run the original envelope through the same retry loop.
 *
 * Paths covered: normal delivery, failure (handler exhausts retries), retry
 * (transient handler failure then success), replay (fixed handler succeeds)
 * and authorization (operator-only inspection/recovery).
 *
 * The store is process-local, matching the other recovery slices (#356); the
 * seam is the service, so a durable store can be swapped in later.
 */
@Injectable()
export class EventDeadLetterService {
  private readonly logger = new Logger(EventDeadLetterService.name);
  private readonly handlers = new Map<string, DomainEventHandlerRegistration>();
  private readonly entries = new Map<string, DeadLetterEntry>();
  private readonly defaultMaxAttempts: number;
  private readonly defaultRetryDelayMs: number;
  private readonly maxEntries: number;

  constructor(private readonly configService: ConfigService) {
    this.defaultMaxAttempts =
      Number(this.configService.get("EVENT_DEAD_LETTER_MAX_ATTEMPTS")) || 3;
    this.defaultRetryDelayMs =
      Number(this.configService.get("EVENT_DEAD_LETTER_RETRY_DELAY_MS")) || 50;
    this.maxEntries =
      Number(this.configService.get("EVENT_DEAD_LETTER_MAX_ENTRIES")) || 1000;
  }

  /** Register (or replace) a handler by name. */
  register(registration: DomainEventHandlerRegistration): void {
    this.handlers.set(registration.name, registration);
    this.logger.log(
      `Registered handler '${registration.name}' for event '${registration.eventName}'`,
    );
  }

  unregister(handlerName: string): boolean {
    return this.handlers.delete(handlerName);
  }

  listHandlers(): Array<Pick<DomainEventHandlerRegistration, "name" | "eventName">> {
    return Array.from(this.handlers.values()).map(({ name, eventName }) => ({
      name,
      eventName,
    }));
  }

  /**
   * Deliver an event to every registered handler for its event name.
   * Never throws for handler failures — those become dead letters. A malformed
   * envelope (no eventId/eventName) is rejected so it cannot silently vanish.
   */
  async dispatch(envelope: DomainEventEnvelope): Promise<DispatchOutcome> {
    if (!envelope?.eventId || !envelope?.eventName) {
      throw new Error("Domain event envelope requires eventId and eventName");
    }

    const targets = Array.from(this.handlers.values()).filter(
      (registration) => registration.eventName === envelope.eventName,
    );

    const outcome: DispatchOutcome = {
      eventId: envelope.eventId,
      eventName: envelope.eventName,
      delivered: [],
      deadLettered: [],
    };

    for (const registration of targets) {
      const result = await this.runWithRetry(registration, envelope);
      if (result.ok) {
        outcome.delivered.push(registration.name);
        this.resolvePendingAfterSuccess(envelope, registration.name);
      } else {
        outcome.deadLettered.push(registration.name);
        this.recordDeadLetter(envelope, registration.name, result.error, result.attempts);
      }
    }

    return outcome;
  }

  list(filter: DeadLetterListFilter = {}): DeadLetterSummary[] {
    return this.filtered(filter)
      .sort((a, b) => b.firstFailedAt.localeCompare(a.firstFailedAt))
      .map((entry) => this.toSummary(entry));
  }

  get(id: string): DeadLetterEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new DeadLetterNotFoundError(id);
    return { ...entry };
  }

  stats(): DeadLetterStats {
    const all = Array.from(this.entries.values());
    const pending = all.filter((entry) => entry.status === "pending");
    const oldestPendingAt = pending
      .map((entry) => entry.firstFailedAt)
      .sort()[0];
    return {
      total: all.length,
      pending: pending.length,
      replayed: all.filter((entry) => entry.status === "replayed").length,
      discarded: all.filter((entry) => entry.status === "discarded").length,
      oldestPendingAt,
    };
  }

  async replay(id: string, operator: DeadLetterOperator): Promise<DeadLetterReplayResult> {
    this.assertOperator(operator, false);
    const entry = this.entries.get(id);
    if (!entry) throw new DeadLetterNotFoundError(id);
    if (entry.status === "discarded") {
      throw new DeadLetterNotFoundError(id);
    }

    const registration = this.handlers.get(entry.handlerName);
    if (!registration || registration.eventName !== entry.eventName) {
      throw new DomainEventHandlerNotFoundError(entry.eventName, entry.handlerName);
    }

    const envelope = this.envelopeFrom(entry);
    const result = await this.runWithRetry(registration, envelope);

    entry.attempts += result.attempts;
    entry.lastFailedAt = new Date().toISOString();
    if (result.ok) {
      entry.status = "replayed";
      entry.replayedAt = new Date().toISOString();
      entry.replayedBy = operator.id;
      this.logger.log(`Dead letter ${id} replayed by ${operator.id}`);
    } else {
      entry.error = result.error;
      this.logger.warn(`Dead letter ${id} replay failed: ${result.error}`);
    }

    return {
      entry: this.toSummary(entry),
      success: result.ok,
      error: result.ok ? undefined : result.error,
    };
  }

  async replayAll(
    filter: DeadLetterListFilter,
    operator: DeadLetterOperator,
  ): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
    results: DeadLetterReplayResult[];
  }> {
    this.assertOperator(operator, false);
    const pending = this.filtered({ ...filter, status: "pending" });
    const results: DeadLetterReplayResult[] = [];
    for (const entry of pending) {
      results.push(await this.replay(entry.id, operator));
    }
    return {
      attempted: results.length,
      succeeded: results.filter((result) => result.success).length,
      failed: results.filter((result) => !result.success).length,
      results,
    };
  }

  discard(
    id: string,
    reason: string,
    operator: DeadLetterOperator,
  ): DeadLetterSummary {
    this.assertOperator(operator, true);
    const entry = this.entries.get(id);
    if (!entry) throw new DeadLetterNotFoundError(id);

    entry.status = "discarded";
    entry.discardedAt = new Date().toISOString();
    entry.discardedBy = operator.id;
    entry.discardReason = reason;
    this.logger.warn(`Dead letter ${id} discarded by ${operator.id}: ${reason}`);
    return this.toSummary(entry);
  }

  clear(): void {
    this.entries.clear();
    this.handlers.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async runWithRetry(
    registration: DomainEventHandlerRegistration,
    envelope: DomainEventEnvelope,
  ): Promise<{ ok: boolean; attempts: number; error?: string }> {
    const maxAttempts = Math.max(1, registration.maxAttempts ?? this.defaultMaxAttempts);
    const retryDelayMs = registration.retryDelayMs ?? this.defaultRetryDelayMs;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await registration.handler(envelope);
        return { ok: true, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && retryDelayMs > 0) {
          await this.delay(retryDelayMs * attempt);
        }
      }
    }
    return {
      ok: false,
      attempts: maxAttempts,
      error: this.describeError(lastError),
    };
  }

  private recordDeadLetter(
    envelope: DomainEventEnvelope,
    handlerName: string,
    error: string | undefined,
    attempts: number,
  ): DeadLetterEntry {
    const now = new Date().toISOString();
    const existing = this.findByEventAndHandler(envelope.eventId, handlerName);

    if (existing && existing.status === "pending") {
      existing.attempts += attempts;
      existing.lastFailedAt = now;
      existing.error = error;
      this.trim();
      return existing;
    }

    const entry: DeadLetterEntry = {
      id: randomUUID(),
      eventId: envelope.eventId,
      eventName: envelope.eventName,
      schemaVersion: envelope.schemaVersion,
      handlerName,
      payload: envelope.payload,
      error: error ?? "handler failed",
      attempts,
      status: "pending",
      firstFailedAt: now,
      lastFailedAt: now,
    };
    this.entries.set(entry.id, entry);
    this.trim();
    return entry;
  }

  private resolvePendingAfterSuccess(
    envelope: DomainEventEnvelope,
    handlerName: string,
  ): void {
    const existing = this.findByEventAndHandler(envelope.eventId, handlerName);
    if (existing && existing.status === "pending") {
      existing.status = "replayed";
      existing.replayedAt = new Date().toISOString();
      existing.replayedBy = "system:dispatch";
    }
  }

  private findByEventAndHandler(
    eventId: string,
    handlerName: string,
  ): DeadLetterEntry | undefined {
    for (const entry of this.entries.values()) {
      if (
        entry.eventId === eventId &&
        entry.handlerName === handlerName &&
        entry.status !== "discarded"
      ) {
        return entry;
      }
    }
    return undefined;
  }

  private filtered(filter: DeadLetterListFilter): DeadLetterEntry[] {
    return Array.from(this.entries.values()).filter((entry) => {
      if (filter.status && entry.status !== filter.status) return false;
      if (filter.eventName && entry.eventName !== filter.eventName) return false;
      if (filter.handlerName && entry.handlerName !== filter.handlerName) return false;
      return true;
    });
  }

  private envelopeFrom(entry: DeadLetterEntry): DomainEventEnvelope {
    return {
      eventId: entry.eventId,
      eventName: entry.eventName,
      schemaVersion: entry.schemaVersion,
      timestamp: entry.firstFailedAt,
      producer: "dead-letter-replay",
      payload: entry.payload,
    };
  }

  private toSummary(entry: DeadLetterEntry): DeadLetterSummary {
    return {
      id: entry.id,
      eventId: entry.eventId,
      eventName: entry.eventName,
      schemaVersion: entry.schemaVersion,
      handlerName: entry.handlerName,
      error: entry.error,
      attempts: entry.attempts,
      status: entry.status,
      firstFailedAt: entry.firstFailedAt,
      lastFailedAt: entry.lastFailedAt,
      replayedAt: entry.replayedAt,
      replayedBy: entry.replayedBy,
      discardedAt: entry.discardedAt,
      discardedBy: entry.discardedBy,
      discardReason: entry.discardReason,
    };
  }

  private assertOperator(operator: DeadLetterOperator, adminOnly: boolean): void {
    const role = String(operator?.role ?? "").toUpperCase();
    const allowed = adminOnly ? role === "ADMIN" : role === "ADMIN" || role === "MAINTAINER";
    if (!allowed) {
      throw new DeadLetterAuthorizationError(
        adminOnly
          ? "Only ADMIN may discard dead letters"
          : "Only ADMIN or MAINTAINER may recover dead letters",
      );
    }
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? "unknown error");
    const singleLine = message.replace(/\s+/g, " ").trim();
    return singleLine.length > MAX_ERROR_LENGTH
      ? `${singleLine.slice(0, MAX_ERROR_LENGTH)}...`
      : singleLine;
  }

  private trim(): void {
    if (this.entries.size <= this.maxEntries) return;
    const ordered = Array.from(this.entries.values()).sort((a, b) =>
      a.firstFailedAt.localeCompare(b.firstFailedAt),
    );
    const overflow = this.entries.size - this.maxEntries;
    const evictable = [
      ...ordered.filter((entry) => entry.status !== "pending"),
      ...ordered.filter((entry) => entry.status === "pending"),
    ].slice(0, overflow);
    for (const entry of evictable) {
      this.entries.delete(entry.id);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

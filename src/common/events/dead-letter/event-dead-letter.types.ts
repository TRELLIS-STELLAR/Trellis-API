import { DomainEventEnvelope } from "../domain-event-schema";

/**
 * Types for dead-letter recovery of failed domain-event handlers (issue #354).
 *
 * A domain event is delivered to one or more handlers. When a handler keeps
 * failing after its retry budget, the event is captured in a dead-letter store
 * so an operator can inspect it, fix the handler and replay it — instead of
 * losing the event or blocking the whole stream.
 */

export type DeadLetterStatus = "pending" | "replayed" | "discarded";

export type DomainEventHandler = (
  envelope: DomainEventEnvelope,
) => Promise<void> | void;

export interface DomainEventHandlerRegistration {
  /** Stable handler name used to key dead letters. */
  name: string;
  /** Event this handler consumes. */
  eventName: string;
  handler: DomainEventHandler;
  /** Attempts per delivery, including the first. Defaults to the service config. */
  maxAttempts?: number;
  /** Base delay between attempts in milliseconds. Defaults to the service config. */
  retryDelayMs?: number;
}

export interface DeadLetterEntry {
  id: string;
  eventId: string;
  eventName: string;
  schemaVersion: string;
  handlerName: string;
  /** Original envelope payload, kept verbatim so the event can be replayed. */
  payload: unknown;
  /** Truncated, sanitized failure detail (no stack, no secrets). */
  error: string;
  attempts: number;
  status: DeadLetterStatus;
  firstFailedAt: string;
  lastFailedAt: string;
  replayedAt?: string;
  replayedBy?: string;
  discardedAt?: string;
  discardedBy?: string;
  discardReason?: string;
}

/** Payload-free view safe to return from list endpoints. */
export interface DeadLetterSummary {
  id: string;
  eventId: string;
  eventName: string;
  schemaVersion: string;
  handlerName: string;
  error: string;
  attempts: number;
  status: DeadLetterStatus;
  firstFailedAt: string;
  lastFailedAt: string;
  replayedAt?: string;
  replayedBy?: string;
  discardedAt?: string;
  discardedBy?: string;
  discardReason?: string;
}

export interface DispatchOutcome {
  eventId: string;
  eventName: string;
  /** Names of handlers that eventually succeeded. */
  delivered: string[];
  /** Names of handlers that exhausted their retries and were dead-lettered. */
  deadLettered: string[];
}

export interface DeadLetterListFilter {
  status?: DeadLetterStatus;
  eventName?: string;
  handlerName?: string;
}

export interface DeadLetterReplayResult {
  entry: DeadLetterSummary;
  success: boolean;
  error?: string;
}

export interface DeadLetterStats {
  total: number;
  pending: number;
  replayed: number;
  discarded: number;
  oldestPendingAt?: string;
}

export interface DeadLetterOperator {
  id: string;
  role: string;
}

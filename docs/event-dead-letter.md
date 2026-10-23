# Dead-letter recovery for failed domain-event handlers (#354)

## What this is

Domain events are delivered to handlers (projections, notifications, audit).
A handler can fail for a transient reason (a write timed out) or a persistent
one (a projection bug). Without a recovery path an event is either lost or
blocks the stream.

This slice adds a dead-letter store (`src/common/events/dead-letter/`):

1. `dispatch(envelope)` fans an event out to every handler registered for its
   event name.
2. Each handler runs with a bounded retry budget.
3. A handler that exhausts its budget is captured as a dead letter; the other
   handlers and the caller are unaffected.
4. Operators inspect the queue, replay after fixing the handler, or discard with
   a reason.

The module reuses the existing `DomainEventEnvelope` (issue #116); the envelope
shape is unchanged.

## Dead-letter entry

| Field | Meaning |
| --- | --- |
| `id` | Dead-letter id. |
| `eventId`, `eventName`, `schemaVersion` | Identity of the original event. |
| `handlerName` | Handler that failed. |
| `payload` | Original payload, kept verbatim so the event can be replayed. |
| `error` | Single-line failure detail (truncated to 500 chars, no stack/secrets). |
| `attempts` | Total attempts across deliveries, including replays. |
| `status` | `pending`, `replayed` or `discarded`. |
| `firstFailedAt`, `lastFailedAt`, `replayedAt/By`, `discardedAt/By/Reason` | Audit trail. |

List endpoints return a **payload-free** summary; only `GET /:id` returns the
payload, and only to operators.

## Paths covered

| Path | Behaviour |
| --- | --- |
| **Normal** | Every matching handler succeeds; nothing is stored. Events with no registered handler are ignored. |
| **Retry** | A handler throws transiently; it is retried up to `EVENT_DEAD_LETTER_MAX_ATTEMPTS` (default 3) with backoff `EVENT_DEAD_LETTER_RETRY_DELAY_MS` (default 50ms). Success within budget leaves no dead letter. |
| **Failure** | The handler exhausts its budget and a `pending` entry is captured. Re-dispatching the same event updates the existing entry instead of duplicating it. |
| **Replay** | After the handler is fixed, `replay()` re-runs the original envelope. Success marks the entry `replayed`; another failure keeps it `pending` and records the new error. Replay fails with 404 if the handler is no longer registered. Discarded entries cannot be replayed. |
| **Authorization** | Listing, inspecting and replaying require `ADMIN`/`MAINTAINER`; discarding is `ADMIN`-only (`DeadLetterAuthorizationError` → HTTP 403). |

## Endpoints

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/event-dead-letters` | `ADMIN`/`MAINTAINER` | List summaries; filter by `status`, `eventName`, `handlerName`. |
| `GET` | `/api/v1/event-dead-letters/stats` | `ADMIN`/`MAINTAINER` | Queue depth by status and oldest pending timestamp. |
| `GET` | `/api/v1/event-dead-letters/:id` | `ADMIN`/`MAINTAINER` | Full entry including payload. |
| `POST` | `/api/v1/event-dead-letters/:id/replay` | `ADMIN`/`MAINTAINER` | Replay one event. |
| `POST` | `/api/v1/event-dead-letters/replay` | `ADMIN`/`MAINTAINER` | Replay all pending entries matching the filter. |
| `POST` | `/api/v1/event-dead-letters/:id/discard` | `ADMIN` | Discard with a reason. |

## Registering a handler

```ts
deadLetters.register({
  name: "settlement-projection",
  eventName: "trade.settled",
  handler: async (envelope) => { /* ... */ },
  maxAttempts: 5,
  retryDelayMs: 200,
});
```

`EventDeadLetterModule` exports `EventDeadLetterService`, so a producer/consumer
module imports it and registers handlers on startup.

## Operational edge cases

- **At-least-once.** A replay re-runs the handler; handlers should be
  idempotent by `eventId`.
- **Bounded store.** The in-memory store is capped at
  `EVENT_DEAD_LETTER_MAX_ENTRIES` (default 1000). Resolved entries are evicted
  before pending ones; the `/stats` count is the signal to drain the queue.
- **Restart.** The store is process-local (consistent with the other recovery
  slices); a restart loses the queue. For durable retention, persist entries at
  capture time — the seam is the service.
- **Poison events.** Discarding records who discarded it and why, so the audit
  trail explains why an event was never applied.
- **Secrets.** `error` is a single truncated line; the payload is only exposed
  to operators via `GET /:id`.

## Recovery / rollback

- The module is additive; removing it does not change the event envelope or
  existing replay/projection code.
- To recover a stuck handler: deploy the fix, then
  `POST /:id/replay` (or the bulk route). Successfully replayed entries leave
  the pending queue.
- To abandon an event, `discard` with a reason; the entry remains queryable as
  `discarded`.

## Contract preservation / migration

- `DomainEventEnvelope` and the projection replay machinery are untouched.
- New configuration is optional with safe defaults:
  `EVENT_DEAD_LETTER_MAX_ATTEMPTS`, `EVENT_DEAD_LETTER_RETRY_DELAY_MS`,
  `EVENT_DEAD_LETTER_MAX_ENTRIES`.

## Verification

```bash
node node_modules/jest/bin/jest.js src/common/events/dead-letter/event-dead-letter.service.spec.ts
```

Covers normal delivery, transient retry, exhausted retries, de-duplication,
successful and failed replay, missing handler, bulk replay, and authorization.

import { ConfigService } from "@nestjs/config";
import { DomainEventEnvelope } from "../domain-event-schema";
import { EventDeadLetterService } from "./event-dead-letter.service";
import { DomainEventHandler } from "./event-dead-letter.types";
import {
  DeadLetterAuthorizationError,
  DeadLetterNotFoundError,
  DomainEventHandlerNotFoundError,
} from "./event-dead-letter.errors";

function buildService(): EventDeadLetterService {
  const config = { get: () => undefined } as unknown as ConfigService;
  return new EventDeadLetterService(config);
}

function envelope(eventId = "evt-1"): DomainEventEnvelope {
  return {
    eventId,
    eventName: "trade.settled",
    schemaVersion: "1.0",
    timestamp: new Date().toISOString(),
    producer: "test",
    payload: { tradeId: "trade-1", amount: 42 },
  };
}

const admin = { id: "admin-1", role: "ADMIN" };
const maintainer = { id: "maint-1", role: "MAINTAINER" };
const user = { id: "user-1", role: "USER" };

function registerOnce(
  service: EventDeadLetterService,
  handler: DomainEventHandler,
  name = "settlement",
): void {
  service.register({
    name,
    eventName: "trade.settled",
    handler,
    maxAttempts: 3,
    retryDelayMs: 0,
  });
}

describe("EventDeadLetterService", () => {
  it("normal path: delivers to every matching handler and records nothing", async () => {
    const service = buildService();
    const calls: string[] = [];
    registerOnce(service, () => void calls.push("settlement"));
    service.register({
      name: "audit",
      eventName: "trade.settled",
      handler: () => void calls.push("audit"),
    });
    service.register({
      name: "unrelated",
      eventName: "user.registered",
      handler: () => void calls.push("unrelated"),
    });

    const outcome = await service.dispatch(envelope());

    expect(outcome.delivered.sort()).toEqual(["audit", "settlement"]);
    expect(outcome.deadLettered).toEqual([]);
    expect(calls.sort()).toEqual(["audit", "settlement"]);
    expect(service.stats()).toMatchObject({ total: 0, pending: 0 });
  });

  it("retry path: a transient handler failure succeeds within the retry budget", async () => {
    const service = buildService();
    let attempts = 0;
    registerOnce(service, async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("transient");
    });

    const outcome = await service.dispatch(envelope());

    expect(attempts).toBe(2);
    expect(outcome.delivered).toEqual(["settlement"]);
    expect(outcome.deadLettered).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  it("failure path: exhausts retries and captures a dead letter", async () => {
    const service = buildService();
    let attempts = 0;
    registerOnce(service, async () => {
      attempts += 1;
      throw new Error("projection write failed");
    });

    const outcome = await service.dispatch(envelope());

    expect(attempts).toBe(3);
    expect(outcome.deadLettered).toEqual(["settlement"]);

    const [summary] = service.list({ status: "pending" });
    expect(summary.eventName).toBe("trade.settled");
    expect(summary.handlerName).toBe("settlement");
    expect(summary.attempts).toBe(3);
    expect(summary.error).toContain("projection write failed");
    expect((summary as any).payload).toBeUndefined();

    const full = service.get(summary.id);
    expect(full.payload).toEqual({ tradeId: "trade-1", amount: 42 });
  });

  it("does not duplicate a dead letter when the same event fails again", async () => {
    const service = buildService();
    registerOnce(service, async () => {
      throw new Error("still broken");
    });

    await service.dispatch(envelope());
    await service.dispatch(envelope());

    const entries = service.list({ status: "pending" });
    expect(entries).toHaveLength(1);
    expect(entries[0].attempts).toBe(6);
  });

  it("replay path: replays a dead letter after the handler is fixed", async () => {
    const service = buildService();
    registerOnce(service, async () => {
      throw new Error("bug");
    });
    await service.dispatch(envelope());
    const [entry] = service.list({ status: "pending" });

    registerOnce(service, () => undefined);
    const result = await service.replay(entry.id, maintainer);

    expect(result.success).toBe(true);
    expect(result.entry.status).toBe("replayed");
    expect(result.entry.replayedBy).toBe("maint-1");
    expect(service.stats()).toMatchObject({ pending: 0, replayed: 1 });
  });

  it("replay failure: keeps the entry pending and records the new error", async () => {
    const service = buildService();
    registerOnce(service, async () => {
      throw new Error("bug");
    });
    await service.dispatch(envelope());
    const [entry] = service.list({ status: "pending" });

    const result = await service.replay(entry.id, admin);

    expect(result.success).toBe(false);
    expect(result.entry.status).toBe("pending");
    expect(result.entry.attempts).toBe(6);
    expect(result.error).toContain("bug");
  });

  it("replay fails when the handler is no longer registered", async () => {
    const service = buildService();
    registerOnce(service, async () => {
      throw new Error("bug");
    });
    await service.dispatch(envelope());
    const [entry] = service.list({ status: "pending" });
    service.unregister("settlement");

    await expect(service.replay(entry.id, admin)).rejects.toBeInstanceOf(
      DomainEventHandlerNotFoundError,
    );
  });

  it("authorization path: rejects non-operators and non-admin discards", async () => {
    const service = buildService();
    registerOnce(service, async () => {
      throw new Error("bug");
    });
    await service.dispatch(envelope());
    const [entry] = service.list({ status: "pending" });

    await expect(service.replay(entry.id, user)).rejects.toBeInstanceOf(
      DeadLetterAuthorizationError,
    );
    expect(() => service.discard(entry.id, "cleanup", maintainer)).toThrow(
      DeadLetterAuthorizationError,
    );

    const discarded = service.discard(entry.id, "cleanup", admin);
    expect(discarded.status).toBe("discarded");
    expect(discarded.discardedBy).toBe("admin-1");
    expect(discarded.discardReason).toBe("cleanup");

    await expect(service.replay(entry.id, admin)).rejects.toBeInstanceOf(
      DeadLetterNotFoundError,
    );
  });

  it("replayAll recovers every pending entry matching the filter", async () => {
    const service = buildService();
    registerOnce(service, async (event) => {
      if ((event.payload as any).amount > 10) throw new Error("big trade");
    });

    await service.dispatch(envelope("evt-1"));
    await service.dispatch(envelope("evt-2"));
    expect(service.stats().pending).toBe(2);

    registerOnce(service, () => undefined);
    const result = await service.replayAll({ eventName: "trade.settled" }, admin);

    expect(result).toMatchObject({ attempted: 2, succeeded: 2, failed: 0 });
    expect(service.stats().pending).toBe(0);
  });

  it("ignores events with no registered handler", async () => {
    const service = buildService();
    const outcome = await service.dispatch(envelope());
    expect(outcome.delivered).toEqual([]);
    expect(outcome.deadLettered).toEqual([]);
  });
});

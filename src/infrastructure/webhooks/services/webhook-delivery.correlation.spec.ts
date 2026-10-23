import { Logger } from "@nestjs/common";
import { of, throwError } from "rxjs";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookHmacService } from "./webhook-hmac.service";
import { WebhookProcessor } from "./webhook-processor.service";
import { WebhookDeliveryStatus } from "../entities/webhook-delivery.entity";
import { WebhookSubscriptionStatus } from "../entities/webhook-subscription.entity";
import {
  CORRELATION_ID_HEADER,
  JOB_CORRELATION_FIELD,
  REQUEST_ID_HEADER,
  getCorrelationId,
  runWithCorrelation,
} from "../../../common/correlation/correlation-context";

/**
 * Outbound webhook calls carry the correlation ID of the request that raised
 * the event on every attempt (#270); persisted request headers and errors are
 * redacted (#271).
 */
describe("WebhookDeliveryService correlation and redaction", () => {
  const subscription = {
    id: "sub-1",
    url: "https://hooks.example.com/trellis",
    signingKey: "whsec_test",
    headers: { Authorization: "Bearer subscriber-secret-token" },
    maxRetries: 3,
    retryDelayMs: 1000,
    backoffMultiplier: 2,
    timeoutMs: 1000,
    userId: "user-1",
    status: WebhookSubscriptionStatus.ACTIVE,
  };
  const event = { id: "evt-1", eventType: "payment.completed", aggregateId: "p1", payload: { amount: 1 } };

  let deliveries: Map<string, any>;
  let deadLetters: any[];
  let http: { post: jest.Mock };
  let service: WebhookDeliveryService;

  beforeEach(() => {
    deliveries = new Map();
    deadLetters = [];
    let nextId = 0;
    const deliveryRepo = {
      // Mirrors the entity's column default.
      create: jest.fn((value) => ({ attempts: 0, ...value })),
      save: jest.fn(async (value) => {
        value.id = value.id ?? `del-${++nextId}`;
        deliveries.set(value.id, { ...value });
        return value;
      }),
      findOne: jest.fn(async ({ where }) =>
        deliveries.has(where.id) ? { ...deliveries.get(where.id) } : null,
      ),
    };
    const deadLetterRepo = {
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => {
        value.id = value.id ?? `dl-${deadLetters.length + 1}`;
        deadLetters.push(value);
        return value;
      }),
      findOne: jest.fn(async ({ where }) => deadLetters.find((d) => d.id === where.id) ?? null),
    };
    const updateChain = { update: () => updateChain, set: () => updateChain, where: () => updateChain, execute: async () => ({}) };
    const eventRepo = {
      findOne: jest.fn(async () => event),
      createQueryBuilder: () => updateChain,
    };
    const subscriptionRepo = { findOne: jest.fn(async () => subscription) };
    http = {
      post: jest.fn(() =>
        of({ status: 200, data: "ok", headers: { "content-type": "text/plain" } }),
      ),
    };
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    service = new WebhookDeliveryService(
      deliveryRepo as any,
      deadLetterRepo as any,
      eventRepo as any,
      subscriptionRepo as any,
      http as any,
      new WebhookHmacService(),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const sentHeaders = (call = 0) => http.post.mock.calls[call][2].headers;

  it("normal path: pins the raising request's ID at creation and sends it", async () => {
    const [delivery] = await runWithCorrelation("raise-request", () =>
      service.createDeliveries(event as any, [subscription as any]),
    );
    expect(delivery.metadata).toEqual({ correlationId: "raise-request" });

    // Delivery runs later in the queue worker, outside the request.
    const done = await service.processDelivery(delivery.id);
    expect(done.status).toBe(WebhookDeliveryStatus.SUCCESS);
    expect(sentHeaders()).toMatchObject({
      [CORRELATION_ID_HEADER]: "raise-request",
      [REQUEST_ID_HEADER]: "raise-request",
    });
  });

  it("retry path: every attempt and a replayed dead letter reuse the original ID", async () => {
    http.post.mockImplementation(() => throwError(() => new Error("connect ECONNREFUSED")));
    const [delivery] = await runWithCorrelation("raise-request", () =>
      service.createDeliveries(event as any, [subscription as any]),
    );
    for (let attempt = 0; attempt < subscription.maxRetries; attempt++)
      await service.processDelivery(delivery.id);

    expect(http.post).toHaveBeenCalledTimes(3);
    for (let call = 0; call < 3; call++)
      expect(sentHeaders(call)[CORRELATION_ID_HEADER]).toBe("raise-request");
    expect(deliveries.get(delivery.id).status).toBe(WebhookDeliveryStatus.DEAD_LETTERED);

    const replay = await runWithCorrelation("operator-request", () =>
      service.retryDeadLetter(deadLetters[0].id),
    );
    expect(replay.metadata).toEqual({ correlationId: "raise-request" });
  });

  it("authorization path: subscriber credentials reach the receiver but are never persisted", async () => {
    const [delivery] = await service.createDeliveries(event as any, [subscription as any]);
    await service.processDelivery(delivery.id);

    expect(sentHeaders().Authorization).toBe("Bearer subscriber-secret-token");
    const stored = deliveries.get(delivery.id);
    expect(stored.requestHeaders.Authorization).toBe("[REDACTED]");
    expect(JSON.stringify(stored)).not.toContain("subscriber-secret-token");
  });

  it("failure path: dead-letter records redact headers and transport errors", async () => {
    http.post.mockImplementation(() =>
      throwError(() => new Error("getaddrinfo failed for https://svc:hunter2@hooks.example.com")),
    );
    const [delivery] = await service.createDeliveries(event as any, [subscription as any]);
    for (let attempt = 0; attempt < subscription.maxRetries; attempt++)
      await service.processDelivery(delivery.id);

    const [dead] = deadLetters;
    const serialized = JSON.stringify(dead);
    expect(serialized).not.toContain("subscriber-secret-token");
    expect(serialized).not.toContain("hunter2");
    expect(dead.lastErrorMessage).toContain("hooks.example.com");
  });

  it("the queue processor restores the stamped ID around the delivery", async () => {
    const seen: Array<string | undefined> = [];
    const processor = new WebhookProcessor({
      processDelivery: jest.fn(async () => {
        seen.push(getCorrelationId());
        return { status: WebhookDeliveryStatus.SUCCESS, id: "del-1", attempts: 1 };
      }),
    } as any);
    await processor.handleDelivery({
      id: "job-1",
      data: { deliveryId: "del-1", eventId: "evt-1", [JOB_CORRELATION_FIELD]: "raise-request" },
    } as any);
    expect(seen).toEqual(["raise-request"]);
  });
});

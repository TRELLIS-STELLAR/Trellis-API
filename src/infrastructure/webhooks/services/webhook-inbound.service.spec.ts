import { ConflictException } from "@nestjs/common";
import { createHmac } from "crypto";
import { WebhookEvent } from "../entities/webhook-event.entity";
import {
  WebhookSubscription,
  WebhookSubscriptionStatus,
} from "../entities/webhook-subscription.entity";
import { WebhookEventService } from "./webhook-event.service";
import { WebhookHmacService } from "./webhook-hmac.service";
import { WebhookInboundService } from "./webhook-inbound.service";

const SECRET = "inbound_test_secret";
const SUBSCRIPTION_ID = "a14c12d9-d238-4fd9-a19f-81e5cbd024d8";
const NOW = 1_800_000_000_000;

function makeSignature(body: string, timestamp: string): string {
  return `sha256=${createHmac("sha256", SECRET)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex")}`;
}

function buildService(
  publishEvent = jest.fn().mockResolvedValue({ id: "stored-event" }),
) {
  const subscription = {
    id: SUBSCRIPTION_ID,
    signingKey: SECRET,
    status: WebhookSubscriptionStatus.ACTIVE,
    events: ["invoice.paid"],
  } as WebhookSubscription;
  const subscriptions = {
    findOne: jest.fn().mockResolvedValue(subscription),
  };
  const events = { publishEvent } as unknown as WebhookEventService;
  const config = { get: jest.fn((_key, fallback) => fallback) } as any;
  const service = new WebhookInboundService(
    subscriptions as any,
    events,
    new WebhookHmacService(),
    config,
  );

  return { service, subscriptions, publishEvent };
}

function signedRequest(body: string, timestamp = String(NOW / 1000)) {
  return {
    body: Buffer.from(body),
    headers: {
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": makeSignature(body, timestamp),
    },
  };
}

describe("WebhookInboundService", () => {
  const payload = JSON.stringify({ id: "evt-1", type: "invoice.paid" });

  it("accepts a valid signed event and persists it once before dispatch", async () => {
    const { service, publishEvent } = buildService();
    const request = signedRequest(payload);

    const result = await service.accept(
      SUBSCRIPTION_ID,
      request.body,
      request.headers,
      NOW,
    );

    expect(result).toMatchObject({ accepted: true, duplicate: false });
    expect(publishEvent).toHaveBeenCalledWith(
      {
        eventType: "invoice.paid",
        payload: { id: "evt-1", type: "invoice.paid" },
        aggregateId: null,
      },
      { subscriptionId: SUBSCRIPTION_ID, externalEventId: "evt-1" },
    );
  });

  it("rejects an invalid signature without dispatching", async () => {
    const { service, publishEvent } = buildService();
    const request = signedRequest(payload);

    await expect(
      service.accept(
        SUBSCRIPTION_ID,
        request.body,
        { ...request.headers, "x-webhook-signature": "sha256=wrong" },
        NOW,
      ),
    ).rejects.toMatchObject({
      response: { reason: "invalid_signature" },
      status: 400,
    });
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed stale timestamp", async () => {
    const { service, publishEvent } = buildService();
    const staleTimestamp = String(NOW / 1000 - 301);
    const request = signedRequest(payload, staleTimestamp);

    await expect(
      service.accept(SUBSCRIPTION_ID, request.body, request.headers, NOW),
    ).rejects.toMatchObject({
      response: { reason: "stale_timestamp" },
      status: 400,
    });
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("returns a structured conflict for a duplicate event ID", async () => {
    const { service } = buildService(
      jest.fn().mockRejectedValue(
        new ConflictException({
          statusCode: 409,
          reason: "duplicate_event",
          message: "This webhook event ID has already been processed.",
        }),
      ),
    );
    const request = signedRequest(payload);

    await expect(
      service.accept(SUBSCRIPTION_ID, request.body, request.headers, NOW),
    ).rejects.toMatchObject({
      response: { reason: "duplicate_event" },
      status: 409,
    });
  });

  it("rejects malformed signed JSON before persistence", async () => {
    const { service, publishEvent } = buildService();
    const request = signedRequest("{");

    await expect(
      service.accept(SUBSCRIPTION_ID, request.body, request.headers, NOW),
    ).rejects.toMatchObject({
      response: { reason: "malformed_event" },
      status: 400,
    });
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("rejects a non-object body and missing event identifiers", async () => {
    const { service, publishEvent } = buildService();
    const primitive = signedRequest("[]");
    await expect(
      service.accept(SUBSCRIPTION_ID, primitive.body, primitive.headers, NOW),
    ).rejects.toMatchObject({ response: { reason: "malformed_event" } });

    const missingId = signedRequest(JSON.stringify({ type: "invoice.paid" }));
    await expect(
      service.accept(SUBSCRIPTION_ID, missingId.body, missingId.headers, NOW),
    ).rejects.toMatchObject({ response: { reason: "malformed_event" } });
    expect(publishEvent).not.toHaveBeenCalled();
  });
});

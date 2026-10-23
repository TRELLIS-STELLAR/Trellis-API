import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { runJobWithCorrelation } from "../../../common/correlation/correlation-context";
import { sanitizeErrorMessage } from "../../../logging/sanitize.util";

export interface WebhookDeliveryJobData {
  deliveryId: string;
  eventId: string;
  /** Correlation ID of the request that raised the event (#270). */
  _correlationId?: string;
}

@Processor("webhook-delivery")
export class WebhookProcessor {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(private readonly deliveryService: WebhookDeliveryService) {}

  @Process("deliver")
  async handleDelivery(job: Job<WebhookDeliveryJobData>) {
    return runJobWithCorrelation(job.data, (correlationId) =>
      this.deliver(job, correlationId),
    );
  }

  private async deliver(job: Job<WebhookDeliveryJobData>, correlationId: string) {
    const { deliveryId } = job.data;
    this.logger.log(
      `Processing webhook delivery job ${job.id} for delivery ${deliveryId} [correlationId=${correlationId}]`,
    );

    try {
      const delivery = await this.deliveryService.processDelivery(deliveryId);
      return {
        status: delivery.status,
        deliveryId: delivery.id,
        attempts: delivery.attempts,
        statusCode: delivery.statusCode,
        durationMs: delivery.durationMs,
      };
    } catch (err: any) {
      this.logger.error(
        `Webhook delivery job ${job.id} failed [correlationId=${correlationId}]: ${sanitizeErrorMessage(String(err?.message ?? err))}`,
      );
      throw err;
    }
  }
}

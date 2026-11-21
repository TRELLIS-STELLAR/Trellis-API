import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as crypto from "crypto";
import {
  Notification,
  NotificationStatus,
} from "../entities/notification.entity";
import {
  NotificationDeliveryLog,
  DeliveryStatus,
} from "../entities/notification-delivery-log.entity";
import {
  DeliveryReceiptDto,
  ReceiptOverallStatus,
  ChannelDeliveryReceiptDto,
} from "../dto/delivery-receipt.dto";

@Injectable()
export class NotificationDeduplicationService {
  private readonly logger = new Logger(NotificationDeduplicationService.name);
  private readonly hmacSecret =
    process.env.NOTIFICATION_RECEIPT_SECRET || "trellis-notification-receipt-secret-v1";

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(NotificationDeliveryLog)
    private readonly deliveryLogRepo: Repository<NotificationDeliveryLog>,
  ) {}

  /**
   * Checks if an identical notification was previously processed for this user and key.
   * Time Complexity: O(1) indexed database lookup.
   * Space Complexity: O(1).
   */
  async findDuplicate(
    userId: string,
    deduplicationKey: string,
  ): Promise<{ duplicate: Notification; receipt: DeliveryReceiptDto } | null> {
    if (!deduplicationKey) return null;

    const existing = await this.notificationRepo.findOne({
      where: {
        userId,
        deduplicationKey,
        deleted: false,
      },
    });

    if (!existing) {
      return null;
    }

    const receipt = await this.generateReceipt(existing, true);
    this.logger.log(
      `Notification deduplicated for user ${userId} with key "${deduplicationKey}" (id: ${existing.id}, receipt: ${receipt.receiptId})`,
    );

    return { duplicate: existing, receipt };
  }

  /**
   * Generates a signed, verifiable delivery receipt for a notification.
   * Preserves channel-level delivery logs and provides an aggregate receipt status.
   */
  async generateReceipt(
    notification: Notification,
    isDuplicate = false,
  ): Promise<DeliveryReceiptDto> {
    const logs = await this.deliveryLogRepo.find({
      where: { notificationId: notification.id },
      order: { createdAt: "ASC" },
    });

    const channelReceipts: ChannelDeliveryReceiptDto[] = logs.map((log) => ({
      channel: log.channel,
      status: log.status,
      attemptCount: log.attemptCount ?? 1,
      provider: log.provider,
      providerMessageId: log.providerMessageId,
      sentAt: log.sentAt ? log.sentAt.toISOString() : undefined,
      deliveredAt: log.deliveredAt ? log.deliveredAt.toISOString() : undefined,
      errorMessage: log.errorMessage,
    }));

    const deliveryStatus = this.calculateOverallStatus(notification, logs);
    const issuedAt = new Date().toISOString();
    const originalSubmittedAt = notification.createdAt
      ? notification.createdAt.toISOString()
      : issuedAt;

    // Deterministic or stored receipt ID
    const existingReceiptId = notification.metadata?.deliveryReceipt?.receiptId;
    const receiptId =
      existingReceiptId || `rcpt-${notification.id}`;

    // Cryptographic signature over receipt elements ensuring tamper verification
    const signaturePayload = `${receiptId}:${notification.id}:${notification.userId}:${
      notification.deduplicationKey || "none"
    }:${originalSubmittedAt}:${deliveryStatus}`;

    const receiptSignature = crypto
      .createHmac("sha256", this.hmacSecret)
      .update(signaturePayload)
      .digest("hex");

    const receipt: DeliveryReceiptDto = {
      receiptId,
      notificationId: notification.id,
      userId: notification.userId,
      deduplicationKey: notification.deduplicationKey,
      isDuplicate,
      deliveryStatus,
      channelReceipts,
      receiptSignature,
      issuedAt,
      originalSubmittedAt,
    };

    // Cache receipt metadata in notification entity if not already present
    if (!existingReceiptId) {
      try {
        notification.metadata = {
          ...(notification.metadata || {}),
          deliveryReceipt: {
            receiptId,
            receiptSignature,
            firstIssuedAt: issuedAt,
          },
        };
        await this.notificationRepo.update(notification.id, {
          metadata: notification.metadata,
        });
      } catch (err) {
        this.logger.warn(`Failed to persist receipt metadata for ${notification.id}: ${err}`);
      }
    }

    return receipt;
  }

  /**
   * Cryptographically verifies the signature of a delivery receipt.
   * Ensures tamper detection across receiptId, notificationId, userId, deduplicationKey,
   * originalSubmittedAt, and deliveryStatus.
   */
  verifyReceiptSignature(receipt: DeliveryReceiptDto): boolean {
    if (!receipt || !receipt.receiptSignature) return false;

    const signaturePayload = `${receipt.receiptId}:${receipt.notificationId}:${receipt.userId}:${
      receipt.deduplicationKey || "none"
    }:${receipt.originalSubmittedAt}:${receipt.deliveryStatus}`;

    const expectedSignature = crypto
      .createHmac("sha256", this.hmacSecret)
      .update(signaturePayload)
      .digest("hex");

    try {
      const a = Buffer.from(receipt.receiptSignature, "hex");
      const b = Buffer.from(expectedSignature, "hex");
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Retrieves the delivery receipt for a specific notification ID with authorization check.
   */
  async getReceiptByNotificationId(
    notificationId: string,
    requestingUserId?: string,
    isAdmin = false,
  ): Promise<DeliveryReceiptDto> {
    const notification = await this.notificationRepo.findOne({
      where: { id: notificationId, deleted: false },
    });

    if (!notification) {
      throw new NotFoundException(`Notification with ID "${notificationId}" was not found.`);
    }

    // Authorization: User can only read their own receipt unless caller is an admin
    if (requestingUserId && !isAdmin && notification.userId !== requestingUserId) {
      throw new ForbiddenException("You are not authorized to access this delivery receipt.");
    }

    return this.generateReceipt(notification, false);
  }

  /**
   * Retrieves the delivery receipt by deduplication key with owner authorization check.
   */
  async getReceiptByDeduplicationKey(
    userId: string,
    deduplicationKey: string,
  ): Promise<DeliveryReceiptDto> {
    const notification = await this.notificationRepo.findOne({
      where: {
        userId,
        deduplicationKey,
        deleted: false,
      },
    });

    if (!notification) {
      throw new NotFoundException(
        `No notification found for user "${userId}" and deduplicationKey "${deduplicationKey}".`,
      );
    }

    return this.generateReceipt(notification, false);
  }

  private calculateOverallStatus(
    notification: Notification,
    logs: NotificationDeliveryLog[],
  ): ReceiptOverallStatus {
    if (notification.status === NotificationStatus.CANCELLED) {
      return ReceiptOverallStatus.SUPPRESSED;
    }

    if (logs.length === 0) {
      if (notification.status === NotificationStatus.FAILED) {
        return ReceiptOverallStatus.FAILED;
      }
      return ReceiptOverallStatus.PENDING;
    }

    const hasDelivered = logs.some(
      (l) => l.status === DeliveryStatus.DELIVERED || l.status === DeliveryStatus.SENT,
    );
    const hasFailed = logs.some(
      (l) => l.status === DeliveryStatus.FAILED || l.status === DeliveryStatus.BOUNCED,
    );
    const hasPending = logs.some((l) => l.status === DeliveryStatus.PENDING);

    if (hasDelivered && !hasFailed && !hasPending) {
      return ReceiptOverallStatus.DELIVERED;
    }

    if (hasDelivered && (hasFailed || hasPending)) {
      return ReceiptOverallStatus.PARTIALLY_DELIVERED;
    }

    if (hasFailed && !hasDelivered && !hasPending) {
      return ReceiptOverallStatus.FAILED;
    }

    return ReceiptOverallStatus.PENDING;
  }
}


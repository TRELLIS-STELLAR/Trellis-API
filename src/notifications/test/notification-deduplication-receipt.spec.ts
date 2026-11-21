import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { NotificationDeduplicationService } from "../services/notification-deduplication.service";
import {
  Notification,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
} from "../entities/notification.entity";
import {
  NotificationDeliveryLog,
  DeliveryStatus,
} from "../entities/notification-delivery-log.entity";
import { ReceiptOverallStatus } from "../dto/delivery-receipt.dto";

describe("Notification Deduplication with Delivery Receipts (#436)", () => {
  let service: NotificationDeduplicationService;

  const mockNotificationRepo = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const mockDeliveryLogRepo = {
    find: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDeduplicationService,
        {
          provide: getRepositoryToken(Notification),
          useValue: mockNotificationRepo,
        },
        {
          provide: getRepositoryToken(NotificationDeliveryLog),
          useValue: mockDeliveryLogRepo,
        },
      ],
    }).compile();

    service = module.get<NotificationDeduplicationService>(
      NotificationDeduplicationService,
    );
  });

  describe("Normal Path: Initial Notification Submission & Receipt Generation", () => {
    it("should return null when checking for non-existent deduplication key", async () => {
      mockNotificationRepo.findOne.mockResolvedValue(null);

      const result = await service.findDuplicate("user-1", "key-new-123");

      expect(result).toBeNull();
      expect(mockNotificationRepo.findOne).toHaveBeenCalledWith({
        where: { userId: "user-1", deduplicationKey: "key-new-123", deleted: false },
      });
    });

    it("should generate a signed delivery receipt with PENDING status when logs are empty", async () => {
      const notif = {
        id: "notif-1",
        userId: "user-1",
        deduplicationKey: "key-1",
        priority: NotificationPriority.NORMAL,
        status: NotificationStatus.PENDING,
        createdAt: new Date("2026-11-19T10:00:00.000Z"),
        metadata: {},
      } as Notification;

      mockDeliveryLogRepo.find.mockResolvedValue([]);

      const receipt = await service.generateReceipt(notif, false);

      expect(receipt.receiptId).toBe("rcpt-notif-1");
      expect(receipt.notificationId).toBe("notif-1");
      expect(receipt.userId).toBe("user-1");
      expect(receipt.deduplicationKey).toBe("key-1");
      expect(receipt.isDuplicate).toBe(false);
      expect(receipt.deliveryStatus).toBe(ReceiptOverallStatus.PENDING);
      expect(receipt.receiptSignature).toBeDefined();
      expect(receipt.receiptSignature).toHaveLength(64); // SHA-256 hex string
    });
  });

  describe("Deduplication Path: Duplicate Submissions", () => {
    it("should detect duplicate submission and return existing notification with duplicate delivery receipt", async () => {
      const existingNotif = {
        id: "notif-existing-99",
        userId: "user-1",
        deduplicationKey: "tx-submitted-stellar-123",
        status: NotificationStatus.SENT,
        createdAt: new Date("2026-11-19T09:30:00.000Z"),
        metadata: {
          deliveryReceipt: {
            receiptId: "rcpt-existing-99",
            receiptSignature: "abc123sig",
          },
        },
      } as unknown as Notification;

      mockNotificationRepo.findOne.mockResolvedValue(existingNotif);
      mockDeliveryLogRepo.find.mockResolvedValue([
        {
          channel: NotificationChannel.IN_APP,
          status: DeliveryStatus.DELIVERED,
          attemptCount: 1,
          deliveredAt: new Date(),
        },
      ]);

      const result = await service.findDuplicate("user-1", "tx-submitted-stellar-123");

      expect(result).not.toBeNull();
      expect(result!.duplicate.id).toBe("notif-existing-99");
      expect(result!.receipt.isDuplicate).toBe(true);
      expect(result!.receipt.receiptId).toBe("rcpt-existing-99");
      expect(result!.receipt.deliveryStatus).toBe(ReceiptOverallStatus.DELIVERED);
    });
  });

  describe("Channel Aggregation & Failure Path", () => {
    it("should compute DELIVERED when all channel logs succeed", async () => {
      const notif = {
        id: "notif-2",
        userId: "user-2",
        status: NotificationStatus.SENT,
        createdAt: new Date(),
      } as Notification;

      mockDeliveryLogRepo.find.mockResolvedValue([
        { channel: NotificationChannel.EMAIL, status: DeliveryStatus.DELIVERED },
        { channel: NotificationChannel.PUSH, status: DeliveryStatus.SENT },
      ]);

      const receipt = await service.generateReceipt(notif, false);

      expect(receipt.deliveryStatus).toBe(ReceiptOverallStatus.DELIVERED);
      expect(receipt.channelReceipts).toHaveLength(2);
    });

    it("should compute PARTIALLY_DELIVERED when one channel succeeds and another failed or is pending", async () => {
      const notif = {
        id: "notif-3",
        userId: "user-3",
        status: NotificationStatus.SENDING,
        createdAt: new Date(),
      } as Notification;

      mockDeliveryLogRepo.find.mockResolvedValue([
        { channel: NotificationChannel.EMAIL, status: DeliveryStatus.DELIVERED },
        { channel: NotificationChannel.SMS, status: DeliveryStatus.FAILED, errorMessage: "Provider timeout" },
      ]);

      const receipt = await service.generateReceipt(notif, false);

      expect(receipt.deliveryStatus).toBe(ReceiptOverallStatus.PARTIALLY_DELIVERED);
      expect(receipt.channelReceipts[1].errorMessage).toBe("Provider timeout");
    });

    it("should compute FAILED when all delivery channels fail", async () => {
      const notif = {
        id: "notif-4",
        userId: "user-4",
        status: NotificationStatus.FAILED,
        createdAt: new Date(),
      } as Notification;

      mockDeliveryLogRepo.find.mockResolvedValue([
        { channel: NotificationChannel.EMAIL, status: DeliveryStatus.FAILED },
        { channel: NotificationChannel.WEBHOOK, status: DeliveryStatus.BOUNCED },
      ]);

      const receipt = await service.generateReceipt(notif, false);

      expect(receipt.deliveryStatus).toBe(ReceiptOverallStatus.FAILED);
    });

    it("should compute SUPPRESSED when notification was cancelled", async () => {
      const notif = {
        id: "notif-5",
        userId: "user-5",
        status: NotificationStatus.CANCELLED,
        createdAt: new Date(),
      } as Notification;

      mockDeliveryLogRepo.find.mockResolvedValue([]);

      const receipt = await service.generateReceipt(notif, false);

      expect(receipt.deliveryStatus).toBe(ReceiptOverallStatus.SUPPRESSED);
    });
  });

  describe("Authorization & Security Path", () => {
    it("should allow owner to fetch their delivery receipt", async () => {
      const notif = {
        id: "notif-auth-1",
        userId: "user-owner",
        createdAt: new Date(),
      } as Notification;

      mockNotificationRepo.findOne.mockResolvedValue(notif);
      mockDeliveryLogRepo.find.mockResolvedValue([]);

      const receipt = await service.getReceiptByNotificationId("notif-auth-1", "user-owner", false);

      expect(receipt.notificationId).toBe("notif-auth-1");
    });

    it("should throw ForbiddenException when non-owner attempts to fetch receipt", async () => {
      const notif = {
        id: "notif-auth-2",
        userId: "user-owner",
        createdAt: new Date(),
      } as Notification;

      mockNotificationRepo.findOne.mockResolvedValue(notif);

      await expect(
        service.getReceiptByNotificationId("notif-auth-2", "attacker-user", false),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should allow ADMIN to fetch delivery receipt for any user", async () => {
      const notif = {
        id: "notif-auth-3",
        userId: "user-owner",
        createdAt: new Date(),
      } as Notification;

      mockNotificationRepo.findOne.mockResolvedValue(notif);
      mockDeliveryLogRepo.find.mockResolvedValue([]);

      const receipt = await service.getReceiptByNotificationId("notif-auth-3", "admin-user", true);

      expect(receipt.notificationId).toBe("notif-auth-3");
    });

    it("should throw NotFoundException when notification does not exist", async () => {
      mockNotificationRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getReceiptByNotificationId("non-existent-id", "user-1"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("Retry & Idempotency Path", () => {
    it("should produce consistent cryptographic signatures for identical notification receipt states", async () => {
      const notif = {
        id: "notif-retry-1",
        userId: "user-retry",
        deduplicationKey: "key-retry",
        status: NotificationStatus.SENT,
        createdAt: new Date("2026-11-19T12:00:00.000Z"),
        metadata: { deliveryReceipt: { receiptId: "rcpt-retry-fixed" } },
      } as unknown as Notification;

      mockDeliveryLogRepo.find.mockResolvedValue([
        { channel: NotificationChannel.IN_APP, status: DeliveryStatus.DELIVERED },
      ]);

      const receipt1 = await service.generateReceipt(notif, false);
      const receipt2 = await service.generateReceipt(notif, false);

      expect(receipt1.receiptSignature).toBe(receipt2.receiptSignature);
      expect(receipt1.receiptId).toBe(receipt2.receiptId);
    });

    it("should cryptographically verify untampered delivery receipts and reject tampered receipts", async () => {
      const notif = {
        id: "notif-verify-1",
        userId: "user-verify",
        deduplicationKey: "key-verify-1",
        status: NotificationStatus.SENT,
        createdAt: new Date("2026-11-19T14:00:00.000Z"),
        metadata: {},
      } as unknown as Notification;

      mockDeliveryLogRepo.find.mockResolvedValue([
        { channel: NotificationChannel.EMAIL, status: DeliveryStatus.DELIVERED },
      ]);

      const receipt = await service.generateReceipt(notif, false);
      expect(service.verifyReceiptSignature(receipt)).toBe(true);

      // Tampered payload status
      const tamperedStatusReceipt = { ...receipt, deliveryStatus: ReceiptOverallStatus.FAILED };
      expect(service.verifyReceiptSignature(tamperedStatusReceipt)).toBe(false);

      // Tampered user ID
      const tamperedUserReceipt = { ...receipt, userId: "malicious-user" };
      expect(service.verifyReceiptSignature(tamperedUserReceipt)).toBe(false);

      // Tampered signature
      const tamperedSigReceipt = { ...receipt, receiptSignature: "00112233445566778899aabbccddeeff" };
      expect(service.verifyReceiptSignature(tamperedSigReceipt)).toBe(false);

      // Null or invalid receipt
      expect(service.verifyReceiptSignature(null as any)).toBe(false);
    });
  });
});


import { NotificationPreferenceService } from "../services/notification-preference.service";
import { NotificationProcessor } from "../services/notification-processor.service";
import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
} from "../entities/notification.entity";
import {
  NotificationChannelPreference,
  NotificationDeliveryMode,
} from "../entities/notification-preference.entity";
import { DeliveryStatus } from "../entities/notification-delivery-log.entity";
import { BadRequestException } from "@nestjs/common";

describe("Durable Notification Preference & Mandatory Alert Routing (#243)", () => {
  describe("NotificationPreferenceService Guards", () => {
    let prefService: NotificationPreferenceService;
    let mockPrefRepo: any;

    beforeEach(() => {
      mockPrefRepo = {
        find: jest.fn(),
        findOne: jest.fn(),
        save: jest.fn().mockImplementation((entity) => Promise.resolve({ id: "pref-1", ...entity })),
        create: jest.fn().mockImplementation((dto) => ({ ...dto })),
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      prefService = new NotificationPreferenceService(mockPrefRepo);
    });

    it("rejects user attempt to set SECURITY alerts to DISABLED on EMAIL", async () => {
      await expect(
        prefService.updatePreference("user-1", {
          category: NotificationCategory.SECURITY,
          channel: NotificationChannel.EMAIL,
          preference: NotificationChannelPreference.DISABLED,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects user attempt to set COMPLIANCE alerts to DISABLED on IN_APP", async () => {
      await expect(
        prefService.updatePreference("user-1", {
          category: NotificationCategory.COMPLIANCE,
          channel: NotificationChannel.IN_APP,
          preference: NotificationChannelPreference.DISABLED,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("allows user to disable non-essential categories like MARKETING", async () => {
      mockPrefRepo.findOne.mockResolvedValue(null);

      const result = await prefService.updatePreference("user-1", {
        category: NotificationCategory.MARKETING,
        channel: NotificationChannel.EMAIL,
        preference: NotificationChannelPreference.DISABLED,
      });

      expect(result.preference).toBe(NotificationChannelPreference.DISABLED);
      expect(mockPrefRepo.save).toHaveBeenCalled();
    });

    it("preserves mandatory SECURITY and COMPLIANCE channels when applying all_off preset", async () => {
      mockPrefRepo.findOne.mockResolvedValue(null);

      const results = await prefService.setAllChannels("user-1", {
        preset: "all_off",
      });

      // Find security on email/in-app in results
      const securityEmail = results.find(
        (p) => p.category === NotificationCategory.SECURITY && p.channel === NotificationChannel.EMAIL,
      );
      const securityInApp = results.find(
        (p) => p.category === NotificationCategory.SECURITY && p.channel === NotificationChannel.IN_APP,
      );
      const marketingEmail = results.find(
        (p) => p.category === NotificationCategory.MARKETING && p.channel === NotificationChannel.EMAIL,
      );

      expect(securityEmail?.preference).toBe(NotificationChannelPreference.ENABLED);
      expect(securityInApp?.preference).toBe(NotificationChannelPreference.ENABLED);
      expect(marketingEmail?.preference).toBe(NotificationChannelPreference.DISABLED);
    });
  });

  describe("NotificationProcessor Mandatory Routing", () => {
    let processor: NotificationProcessor;
    let mockNotificationRepo: any;
    let mockPreferenceRepo: any;
    let mockDeliveryLogRepo: any;
    let mockEmailProvider: any;
    let mockInAppProvider: any;

    beforeEach(() => {
      mockNotificationRepo = {
        findOne: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      };

      mockPreferenceRepo = {
        findOne: jest.fn(),
      };

      mockDeliveryLogRepo = {
        create: jest.fn().mockImplementation((data) => ({ id: "log-1", ...data })),
        save: jest.fn().mockImplementation((log) => Promise.resolve(log)),
        update: jest.fn().mockResolvedValue(undefined),
        find: jest.fn().mockResolvedValue([
          { status: DeliveryStatus.SENT },
        ]),
      };

      mockEmailProvider = {
        channel: NotificationChannel.EMAIL,
        deliver: jest.fn().mockResolvedValue({
          status: DeliveryStatus.SENT,
          provider: "smtp",
          providerMessageId: "msg-123",
        }),
      };

      mockInAppProvider = {
        channel: NotificationChannel.IN_APP,
        deliver: jest.fn().mockResolvedValue({
          status: DeliveryStatus.DELIVERED,
          provider: "internal",
          providerMessageId: "inapp-456",
        }),
      };

      processor = new NotificationProcessor(
        mockNotificationRepo,
        mockDeliveryLogRepo,
        mockPreferenceRepo,
      );
      processor.registerProvider(mockEmailProvider as any);
      processor.registerProvider(mockInAppProvider as any);
    });

    it("delivers mandatory SECURITY notification even when channel preference is DISABLED and records audit note", async () => {
      const notification = {
        id: "notif-sec-1",
        userId: "user-victim",
        category: NotificationCategory.SECURITY,
        priority: NotificationPriority.HIGH,
        primaryChannel: NotificationChannel.EMAIL,
        channels: [NotificationChannel.EMAIL],
        title: "Suspicious Login Detected",
        body: "Login from unrecognized IP address",
        maxAttempts: 3,
        attemptCount: 0,
      };

      mockNotificationRepo.findOne.mockResolvedValue(notification);

      // User preference was disabled (e.g. historical or anomalous state)
      mockPreferenceRepo.findOne.mockResolvedValue({
        userId: "user-victim",
        category: NotificationCategory.SECURITY,
        channel: NotificationChannel.EMAIL,
        preference: NotificationChannelPreference.DISABLED,
        emailAddress: "victim@example.com",
      });

      await (processor as any).processNotification({
        id: "job-1",
        data: { notificationId: notification.id },
      });

      // Provider was still called!
      expect(mockEmailProvider.deliver).toHaveBeenCalledTimes(1);
      expect(mockEmailProvider.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientAddress: "victim@example.com",
          title: "Suspicious Login Detected",
        }),
      );

      // Delivery log records the preference bypass audit record
      expect(mockDeliveryLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationId: "notif-sec-1",
          providerResponse: {
            bypassedUserPreference: true,
            bypassReason: "MANDATORY_ALERT",
          },
        }),
      );
    });

    it("delivers CRITICAL priority notifications bypassing quiet hours and minPriority", async () => {
      const criticalNotif = {
        id: "notif-crit-1",
        userId: "user-vip",
        category: NotificationCategory.SYSTEM,
        priority: NotificationPriority.CRITICAL,
        primaryChannel: NotificationChannel.IN_APP,
        channels: [NotificationChannel.IN_APP],
        title: "Emergency Circuit Breaker",
        body: "System entering read-only safe mode",
        maxAttempts: 3,
        attemptCount: 0,
      };

      mockNotificationRepo.findOne.mockResolvedValue(criticalNotif);

      // Preference has quiet hours and minPriority = high
      mockPreferenceRepo.findOne.mockResolvedValue({
        userId: "user-vip",
        category: NotificationCategory.SYSTEM,
        channel: NotificationChannel.IN_APP,
        preference: NotificationChannelPreference.ENABLED,
        quietHoursStart: 0,
        quietHoursEnd: 24, // all day quiet hours
        timezone: "UTC",
        minPriority: "critical",
        userId: "user-vip",
      });

      await (processor as any).processNotification({
        id: "job-2",
        data: { notificationId: criticalNotif.id },
      });

      expect(mockInAppProvider.deliver).toHaveBeenCalledTimes(1);
      expect(mockInAppProvider.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientAddress: "user-vip",
          title: "Emergency Circuit Breaker",
        }),
      );
    });

    it("respects preferences and suppresses routine marketing notifications when disabled", async () => {
      const routineNotif = {
        id: "notif-mkt-1",
        userId: "user-reg",
        category: NotificationCategory.MARKETING,
        priority: NotificationPriority.LOW,
        primaryChannel: NotificationChannel.EMAIL,
        channels: [NotificationChannel.EMAIL],
        title: "New Year Promotion",
        body: "Check out our rewards",
        maxAttempts: 3,
        attemptCount: 0,
      };

      mockNotificationRepo.findOne.mockResolvedValue(routineNotif);

      mockPreferenceRepo.findOne.mockResolvedValue({
        userId: "user-reg",
        category: NotificationCategory.MARKETING,
        channel: NotificationChannel.EMAIL,
        preference: NotificationChannelPreference.DISABLED,
        emailAddress: "reg@example.com",
      });

      await (processor as any).processNotification({
        id: "job-3",
        data: { notificationId: routineNotif.id },
      });

      // Provider was NOT called
      expect(mockEmailProvider.deliver).not.toHaveBeenCalled();
    });

    it("provides fallback recipient address for mandatory alerts if specific channel preference is missing", async () => {
      const mandatoryNotif = {
        id: "notif-mand-1",
        userId: "user-fallback",
        category: NotificationCategory.SECURITY,
        priority: NotificationPriority.HIGH,
        primaryChannel: NotificationChannel.IN_APP,
        channels: [NotificationChannel.IN_APP],
        title: "Password Changed",
        body: "Your password was changed from Chrome on Windows",
        maxAttempts: 3,
        attemptCount: 0,
      };

      mockNotificationRepo.findOne.mockResolvedValue(mandatoryNotif);
      mockPreferenceRepo.findOne.mockResolvedValue(null); // No preference found at all

      await (processor as any).processNotification({
        id: "job-4",
        data: { notificationId: mandatoryNotif.id },
      });

      expect(mockInAppProvider.deliver).toHaveBeenCalledTimes(1);
      expect(mockInAppProvider.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientAddress: "user-fallback",
        }),
      );
    });
  });
});

import { NotificationProcessor } from "./notification-processor.service";
import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
} from "../entities/notification.entity";
import { DeliveryStatus } from "../entities/notification-delivery-log.entity";

describe("NotificationProcessor duplicate suppression", () => {
  const notification = {
    id: "n-1", userId: "u-1", channels: [NotificationChannel.EMAIL],
    primaryChannel: NotificationChannel.EMAIL, category: NotificationCategory.SYSTEM,
    priority: NotificationPriority.NORMAL, status: NotificationStatus.QUEUED,
    attemptCount: 0, maxAttempts: 3, title: "Title", body: "Body", metadata: {},
  } as any;

  function setup(previousLog: any) {
    const notificationRepo = { findOne: jest.fn().mockResolvedValue(notification), update: jest.fn() };
    const deliveryLogRepo = {
      findOne: jest.fn().mockResolvedValue(previousLog),
      find: jest.fn().mockResolvedValue(previousLog ? [previousLog] : []),
      create: jest.fn((value) => ({ id: "new-log", attemptCount: 0, ...value })),
      save: jest.fn(async (value) => value), update: jest.fn(),
    };
    const preferenceRepo = { findOne: jest.fn().mockResolvedValue({
      userId: "u-1", emailAddress: "user@example.test", preference: "enabled",
    }) };
    const processor = new NotificationProcessor(notificationRepo as any, deliveryLogRepo as any, preferenceRepo as any);
    const deliver = jest.fn().mockResolvedValue({ status: DeliveryStatus.SENT, provider: "test" });
    processor.registerProvider({ channel: NotificationChannel.EMAIL, deliver } as any);
    return { processor, deliveryLogRepo, deliver };
  }

  it("suppresses a retry after a channel was already accepted by its provider", async () => {
    const { processor, deliver } = setup({ id: "log-1", notificationId: "n-1", channel: NotificationChannel.EMAIL, status: DeliveryStatus.SENT, attemptCount: 1 });
    await processor.processNotification({ data: { notificationId: "n-1" } } as any);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("reuses the failed delivery record on retry instead of creating a duplicate", async () => {
    const previousLog = { id: "log-1", notificationId: "n-1", channel: NotificationChannel.EMAIL, status: DeliveryStatus.FAILED, attemptCount: 1 };
    const { processor, deliveryLogRepo, deliver } = setup(previousLog);
    await processor.processNotification({ data: { notificationId: "n-1" } } as any);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliveryLogRepo.save).not.toHaveBeenCalled();
    expect(deliveryLogRepo.update).toHaveBeenCalledWith("log-1", expect.objectContaining({ attemptCount: 2 }));
  });
});

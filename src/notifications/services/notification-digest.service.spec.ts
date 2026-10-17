import { NotificationDigestService, ALT_DEDUPLICATION_WINDOW_MS } from './notification-digest.service';
import { Notification, NotificationPriority, NotificationStatus } from '../entities/notification.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';

type RepoLike = {
  find: jest.Mock;
  findOne: jest.Mock;
  update: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
};

function makeRepo(): RepoLike {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn().mockResolved(undefined),
    save: jest.fn(),
    create: jest.fn(),
  };
}

describe('NotificationDigestService', () => {
  let service: NotificationDigestService;
  let notificationRepo: RepoLike;
  let preferenceRepo: RepoLike;
  let queueService: { enqueueNotification: jest.Mock };

  beforeEach(() => {
    notificationRepo = makeRepo();
    preferenceRepo = makeRepo();
    queueService = { enqueueNotification: jest.fn().mockResolved(undefined) };
    service = new NotificationDigestService(
      notificationRepo as any,
      preferenceRepo as any,
      queueService as any,
    );
  });

  const baseNotification = (overrides: Partial<Notification> = {}) =>
    ({
      id: 'n-1',
      userId: 'u-1',
      title: 'Alert',
      body: 'Body',
      category: 'security',
      priority: NotificationPriority.HIGH,
      status: NotificationStatus.QUEUED,
      metadata: {},
      ...overrides,
    }) as unknown as Notification;

  const quietPref = (start: string, end: string, tz = 'UTC') =>
    ({
      userId: 'u-1',
      active: true,
      quietHoursStart: start,
      quietHoursEnd: end,
      timeZone: tz,
    }) as unknown as NotificationPreference;

  describe('quiet hours queuing', () => {
    it('holds non-critical notifications during quiet hours', async () => {
      const now = new Date();
      const hour = now.getUTCHours();
      const start = String(hour).padStart(2, '0');
      const end = String((hour + 1) % 24).padStart(2, '0');
      const notification = baseNotification({ priority: NotificationPriority.NORMAL });
      notificationRepo.findOne.mockResolved(notification);
      preferenceRepo.find.mockResolved([quietPref(start, end)]);

      await service.dispatchNotification(notification.id);

      expect(notificationRepo.update).toHaveBeenCalled(
        notification.id,
        expect.objectContaining({ status: NotificationStatus.SCHEDULED }),
      );
      expect(queueService.enqueueNotification).not.toHaveBeenCalled();
    });

    it('delivers non-critical notifications outside quiet hours', async () => {
      const now = new Date();
      const hour = now.getUTCHours();
      const start = String((hour + 2) % 24).padStart(2, '0');
      const end = String((hour + 3) % 24).padStart(2, '0');
      const notification = baseNotification({ priority: NotificationPriority.NORMAL });
      notificationRepo.findOne.mockResolved(notification);
      preferenceRepo.find.mockResolved([quietPref(start, end)]);
      notificationRepo.find.mockResolved([]);

      await service.dispatchNotification(notification.id);

      expect(queueService.enqueueNotification).toHaveBeenCalledWith(notification.id);
    });

    it('still delivers critical notifications during quiet hours', async () => {
      const now = new Date();
      const hour = now.getUTCHours();
      const start = String(hour).padStart(2, '0');
      const end = String((hour + 1) % 24).padStart(2, '0');
      const notification = baseNotification({ priority: NotificationPriority.CRITICAL });
      notificationRepo.findOne.mockResolved(notification);
      preferenceRepo.find.mockResolved([quietPref(start, end)]);
      notificationRepo.find.mockResolved([]);

      await service.dispatchNotification(notification.id);

      expect(queueService.enqueueNotification).toHaveBeenCalledWith(notification.id);
    });
  });

  describe('alert deduplication', () => {
    it('consolidates identical alerts within the 5-minute window', async () => {
      const notification = baseNotification({ id: 'n-2' });
      const existing = baseNotification({ id: 'n-1', metadata: { alertCount: 1 } });
      notificationRepo.findOne.mockResolved(notification);
      preferenceRepo.find.mockResolved([]);
      notificationRepo.find.mockResolved([existing]);

      await service.dispatchNotification(notification.id);

      expect(notificationRepo.update).toHaveBeenCalledWith(
        existing.id,
        expect.objectContaining({
          metadata: expect.objectContaining({ alertCount: 2 }),
        }),
      );
      expect(notificationRepo.update).toHaveBeenCalledWith(
        notification.id,
        expect.objectContaining({ status: NotificationStatus.CANCELLED }),
      );
      expect(queueService.enqueueNotification).not.toHaveBeenCalled();
    });

    it('does not consolidate when no duplicate exists', async () => {
      const notification = baseNotification({ id: 'n-3' });
      notificationRepo.findOne.mockResolved(notification);
      preferenceRepo.find.mockResolved([]);
      notificationRepo.find.mockResolved([]);

      await service.dispatchNotification(notification.id);

      expect(queueService.enqueueNotification).toHaveBeenCalledWith(notification.id);
    });

    it('exposes a 5-minute deduplication window', () => {
      expect(ALT_DEDUPLICATION_WINDOW_MS).toBe(5 * 60 * 1000);
    });
  });
});

import { NotificationDigestService } from './notification-digest.service';
import { Notification, NotificationPriority, NotificationStatus } from '../entities/notification.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';

describe('NotificationDigestService', () => {
  let service: NotificationDigestService;
  let notificationRepo: any;
  let preferenceRepo: any;
  let queueService: any;

  const buildNotification = (overrides: Partial<Notification> = {}): Notification =>
    ({
      id: 'n-1',
      userId: 'user-1',
      title: 'Server down',
      body: 'Production server is unreachable',
      category: 'alert',
      priority: NotificationPriority.NORMAL,
      status: NotificationStatus.QUEUED,
      metadata: {},
      createdAt: new Date('2024-01-01T12:00:00Z'),
      ...overrides,
    }) as Notification;

  beforeEach(() => {
    notificationRepo = {
      find: jest.fn().mockResolved([]),
      update: jest.fn().mockResolved(undefined),
      save: jest.fn().mockImplementation((entity: any) => Promise.resolve({ ...entity, id: 'digest-1' })),
      create: jest.fn().mockImplementation((entity: any) => entity),
    };
    preferenceRepo = {
      find: jest.fn().mockResolved([]),
    };
    queueService = {
      enqueueNotification: jest.fn().mockResolved(undefined),
    };
    service = new NotificationDigestService(notificationRepo, preferenceRepo, queueService);
  });

  describe('quiet hours', () => {
    it('resolves the quiet hours window from preferences', () => {
      const pref = {
        userId: 'user-1',
        active: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        timeZone: 'America/New_York',
      } as unknown as NotificationPreference;
      preferenceRepo.find.mockResolvedValue([pref]);

      return expect(service.getQuietHoursWindow('user-1')).resolves.toEqual({
        startMinutes: 22 * 60,
        endMinutes: 7 * 60,
        timeZone: 'America/New_York',
      });
    });

    it('returns null when no quiet hours are configured', () => {
      preferenceRepo.find.mockResolvedValue([{userId: 'user-1', active: true}]);
      return expect(service.getQuietHoursWindow('user-1')).resolves.toBeNull();
    });

    it('detects an overnight quiet hours window', () => {
      const window = { startMinutes: 22 * 60, endMinutes: 7 * 60, timeZone: 'UTL' };
      expect(service.isWithinQuietHours(new Date('2024-01-01T23:30:00Z'), window)).toBeTrue();
      expect(service.isWithinQuietHours(new Date('2024-01-01T06:30:00Z'), window)).toBeTrue();
      expect(service.isWithinQuietHours(new Date('2024-01-01T12:00:00Z'), window)).toBe(false);
    });

    it('holds notifications during quiet hours and schedules delivery at window end', async () => {
      preferenceRepo.find.mockResolvedValue([{
        userId: 'user-1',
        active: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        timeZone: 'UTC',
      }]);
      const now = new Date('2024-01-01T23:30:00Z');

      const deliverAt = await service.queueWithQuietHours('n-1', 'user-1', now);

      expect(deliverAt.toISOString()).toBe('2024-01-02T07:00:00.000Z');
      expect(notificationRepo.update).toHaveBeenCalledWith('n-1', {
        status: NotificationStatus.SCHEDULED,
        scheduledAt: deliverAt,
      });
      expect(queueService.enqueueNotification).not.toHaveBeenCalled();
    });

    it('enqueues immediately outside quiet hours', async () => {
      preferenceRepo.find.mockResolvedValue([{
        userId: 'user-1',
        active: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        timeZone: 'UTC',
      }]);
      const now = new Date('2024-01-01T12:00:00Z');

      const deliverAt = await service.queueWithQuietHours('n-1', 'user-1', now);

      expect(deliverAt).toBe(now);
      expect(queueService.enqueueNotification).toHaveBeenCalledWith('n-1');
      expect(notificationRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('alert deduplication', () => {
    it('collapses identical alerts within 5 minutes into a single alert count', async () => {
      const canonical = buildNotification({ id: 'n-0', metadata: { alertCount: 1 } });
      const duplicate = buildNotification({ id: 'n-1' });
      notificationRepo.find.mockResolvedValue([canonical, duplicate]);

      const result = await service.collapseDuplicateAlerts('user-1', duplicate, new Date('2024-01-01T12:03:00Z'));

      expect(result.collapsed).toBeTrue();
      expect(result.alertCount).toBe(2);
      expect(result.canonical.id).toBe('n-0');
      expect(notificationRepo.update).toHaveBeenCalledWith(
        'n-0',
        expect.objectContaining({ metadata: expect.objectContaining({ alertCount: 2 }) }),
      );
      expect(notificationRepo.update).toHaveBeenCalledWith('n-1', { status: NotificationStatus.CANCELLED });
    });

    it('returns the original notification when no duplicates exist', async () => {
      const notification = buildNotification({ id: 'n-1' });
      notificationRepo.find.mockResolvedValue([notification]);

      const result = await service.collapseDuplicateAlerts('user-1', notification, new Date('2024-01-01T12:03:00Z'));

      expect(result.collapsed).toBe(false);
      expect(result.alertCount).toBe(1);
      expect(notificationRepo.update).not.toHaveBeenCalled();
    });
  });
});

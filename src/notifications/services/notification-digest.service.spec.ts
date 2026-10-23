import { NotificationDigestService } from './notification-digest.service';

describe('NotificationDigestService', () => {
  let service: NotificationDigestService;
  let pushSender: jest.Mocked<Function>;
  let clock: jest.Mocked<Function>;

  const userId = 'user-1';

  const basePush = {
    userId,
    title: 'Alert',
    body: 'Something happened',
    critical: false,
  };

  const quietHoursPrefs = {
    quietHoursStart: 22,
    quietHoursEnd: 7,
    timeZone: 'America/New_York',
  };

  beforeEach(() => {
    pushSender = jest.fn().mockResolved(undefined);
    clock = jest.fn();
    service = new NotificationDigestService({
      pushSender,
      clock,
    } as any);
  });

  describe('quiet hours queuing', () => {
    it('holds non-critical pushes during quiet hours and delivers them after quiet hours end', async () => {
      // 2024-01-15T03:30:00 Z = 22:30 New York (quiet hours)
      clock.mockReturnValue(new Date('2024-01-15T03:30:00.000Z'));
      service.setQuietHoursPreferences(userId, quietHoursPrefs);

      await service.dispatch(basePush);

      expect(pushSender).not.toHaveBeenCalled();
      expect(service.getQueuedCount(userId)).toBe(1);

      // 2024-01-15T12:30:00 Z = 07:30 New York (after quiet hours end)
      clock.mockReturnValue(new Date('2024-01-15T12:30:00.000Z'));
      await service.flushQueued();

      expect(pushSender).toHaveBeenCalledTimes(1);
      expect(pushSender.mock.calls[0][0]).toMatchObject({
        userId,
        title: basePush.title,
      });
      expect(service.getQueuedCount(userId)).toBe(0);
    });

    it('delivers critical pushes immediately even during quiet hours', async () => {
      clock.mockReturnValue(new Date('2024-01-15T03:30:00.000Z'));
      service.setQuietHoursPreferences(userId, quietHoursPrefs);

      await service.dispatch({ ...basePush, critical: true });

      expect(pushSender).toHaveBeenCalledTimes(1);
      expect(service.getQueuedCount(userId)).toBe(0);
    });

    it('delivers non-critical pushes immediately outside quiet hours', async () => {
      // 2024-01-15T18:00:00 Z = 13:00 New York
      clock.mockReturnValue(new Date('2024-01-15T18:00:00.000Z'));
      service.setQuietHoursPreferences(userId, quietHoursPrefs);

      await service.dispatch(basePush);

      expect(pushSender).toHaveBeenCalledTimes(1);
      expect(service.getQueuedCount(userId)).toBe(0);
    });

    it('handles quiet hours that wrap around midnight', async () => {
      // 2024-01-15T06:00:00 Z = 01:00 New York (inside 22:00->07:00 window)
      clock.mockReturnValue(new Date('2024-01-15T06:00:00.000Z'));
      service.setQuietHoursPreferences(userId, quietHoursPrefs);

      await service.dispatch(basePush);

      expect(pushSender).not.toHaveBeenCalled();
      expect(service.getQueuedCount(userId)).toBe(1);
    });
  });

  describe('alert deduplication', () => {
    it('collapses identical alerts within 5 minutes into a single push with a count', async () => {
      clock.mockReturnValue(new Date('2024-01-15T18:00:00.000Z'));

      await service.dispatch(basePush);
      clock.mockReturnValue(new Date('2024-01-15T18:02:00.000Z'));
      await service.dispatch(basePush);
      clock.mockReturnValue(new Date('2024-01-15T18:04:00.000Z'));
      await service.dispatch(basePush);

      expect(pushSender).toHaveBeenCalledTimes(1);
      expect(pushSender.mock.calls[0][0]).toMatchObject({ userId, title: basePush.title });
    });

    it('sends a follow-up push with the consolidated count after the dedup window', async () => {
      clock.mockReturnValue(new Date('2024-01-15T18:00:00.000Z'));
      await service.dispatch(basePush);

      clock.mockReturnValue(new Date('2024-01-15T18:02:00.000Z'));
      await service.dispatch(basePush);

      // Six minutes after the first alert: dedup window has expired.
      clock.mockReturnValue(new Date('2024-01-15T18:06:00.000Z'));
      await service.dispatch(basePush);

      expect(pushSender).toHaveBeenCalledTimes(2);
    });

    it('does not collapse different alerts', async () => {
      clock.mockReturnValue(new Date('2024-01-15T18:00:00.000Z'));
      await service.dispatch(basePush);

      clock.mockReturnValue(new Date('2024-01-15T18:01:00.000Z'));
      await service.dispatch({ ...basePush, title: 'Other alert' });

      expect(pushSender).toHaveBeenCalledTimes(2);
    });

    it('deduplicates alerts that were queued during quiet hours', async () => {
      clock.mockReturnValue(new Date('2024-01-15T03:30:00.000Z'));
      service.setQuietHoursPreferences(userId, quietHoursPrefs);
      await service.dispatch(basePush);

      clock.mockReturnValue(new Date('2024-01-15T03:32:00.000Z'));
      await service.dispatch(basePush);

      expect(pushSender).not.toHaveBeenCalled();
      expect(service.getQueuedCount(userId)).toBe(1);

      clock.mockReturnValue(new Date('2024-01-15T12:30:00.000Z'));
      await service.flushQueued();

      expect(pushSender).toHaveBeenCalledTimes(1);
    });
  });
});

import { ForbiddenException } from '@nestjs/common';
import { NotificationController } from './notification.controller';

describe('NotificationController history ownership', () => {
  it('uses the authenticated principal for the scoped history query', async () => {
    const notificationService = { getHistory: jest.fn().mockResolvedValue({ data: [], total: 0, nextCursor: null }) };
    const controller = new NotificationController(notificationService as any, {} as any, {} as any, {} as any, {} as any);
    const query = {} as any;

    await controller.getHistory({ user: { id: 'owner-1' } }, 'owner-1', query);

    expect(query.userId).toBe('owner-1');
    expect(notificationService.getHistory).toHaveBeenCalledWith(query);
  });

  it('denies a different or missing authenticated principal', async () => {
    const notificationService = { getHistory: jest.fn() };
    const controller = new NotificationController(notificationService as any, {} as any, {} as any, {} as any, {} as any);

    await expect(controller.getHistory({ user: { id: 'user-1' } }, 'user-2', {} as any))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(notificationService.getHistory).not.toHaveBeenCalled();
  });
});

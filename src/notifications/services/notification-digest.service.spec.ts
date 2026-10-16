import { NotificationDigestService } from './notification-digest.service';

describe('NotificationDigestService', () => {
  let service: NotificationDigestService;

  beforeEach(() => {
    service = new NotificationDigestService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

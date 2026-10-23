import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Not, Repository } from 'typeorm';
import { Notification, NotificationPriority, NotificationStatus, NotificationChannel } from '../entities/notification.entity';
import { NotificationPreference, NotificationChannelPreference, NotificationDeliveryMode } from '../entities/notification-preference.entity';
import { NotificationQueueService } from './notification-queue.service';
import { DistributedLock } from "../../infrastructure/distributed-lock/distributed-lock.decorator";

export interface QuietHoursSettings {
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  timeZone?: string | null;
}

export interface QuietHoursWindow {
  startMinutes: number;
  endMinutes: number;
  timeZone: string;
}

const ANALYTICS_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_TIME_ZONE = 'UTC';

function parseHourMinute(value?: string | null): number | null {
  if (!value) return null;
  const match = /^([0-1]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesInTimeZone(date: Date, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    });
    const parts = formatter.formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return hour * 60 + minute;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

function isWithinWindow(minutesOfDay: number, window: QuietHoursWindow): boolean {
  const { startMinutes, endMinutes } = window;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return minutesOfDay >= startMinutes && minutesOfDay < endMinutes;
  }
  // Overnight window (e.g. 22:00 - 07:00)
  return minutesOfDay >= startMinutes || minutesOfDay < endMinutes;
}

function nextWindowEnd(date: Date, window: QuietHoursWindow): Date {
  const minutesOfDay = minutesInTimeZone(date, window.timeZone);
  const { endMinutes } = window;
  let deltaMinutes = endMinutes - minutesOfDay;
  if (deltaMinutes <= 0) deltaMinutes += 24 * 60;
  return new Date(date.getTime() + deltaMinutes * 60 * 1000);
}

@Injectable()
export class NotificationDigestService {
  private readonly logger = new Logger(NotificationDigestService.name);

  constructor(
    @InjectRepository(Notification) private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(NotificationPreference) private readonly preferenceRepo: Repository<NotificationPreference>,
    private readonly queueService: NotificationQueueService,
  ) {}

  /**
   * Resolve the quiet hours window for a user from their active preferences.
   * Returns null when the user has no quiet hours configured.
   */
  async getQuietHoursWindow(userId: string): Promise<QuietHoursWindow | null> {
    const prefs = await this.preferenceRepo.find({ where: { userId, active: true } });
    for (const pref of prefs) {
      const settings = (pref as any) as QuietHoursSettings;
      const start = parseHourMinute(settings.quietHoursStart);
      const end = parseHourMinute(settings.quietHoursEnd);
      if (start === null || end === null) continue;
      return {
        startMinutes: start,
        endMinutes: end,
        timeZone: settings.timeZone || DEFAULT_TIME_ZONE,
      };
    }
    return null;
  }

  /**
   * Returns true when the given date falls within the user's quiet hours.
   */
  isWithinQuietHours(date: Date, window: QuietHoursWindow | null): boolean {
    if (!window) return false;
    const minutesOfDay = minutesInTimeZone(date, window.timeZone);
    return isWithinWindow(minutesOfDay, window);
  }

  /**
   * Compute the timestamp at which a notification held during quiet hours can be delivered.
   */
  getQuietHoursEnd(date: Date, window: QuietHoursWindow): Date {
    return nextWindowEnd(date, window);
  }

  /**
   * Queue a non-critical notification for delivery, holding it until quiet hours end.
   * Returns the effective delivery date (now or the quiet hours end).
   */
  async queueWithQuietHours(notificationId: string, userId: string, now: Date = new Date()): Promise<Date> {
    const window = await this.getQuietHoursWindow(userId);
    if (window && this.isWithinQuietHours(now, window)) {
      const deliverAt = this.getQuietHoursEnd(now, window);
      await this.notificationRepo.update(notificationId, {
        status: NotificationStatus.SCHEDULED,
        scheduledAt: deliverAt,
      } as any);
      this.logger.log(`Notification ${notificationId} held until quiet hours end at ${deliverAt.toISOString()}`);
      return deliverAt;
    }
    await this.queueService.enqueueNotification(notificationId);
    return now;
  }

  /**
   * Collapse identical alert notifications for a user within a 5-minute window.
   * Returns the canonical notification and the consolidated alert count.
   */
  async collapseDuplicateAlerts(
    userId: string,
    notification: Notification,
    now: Date = new Date(),
  ): Promise<{ canonical: Notification; alertCount: number; collapsed: boolean }> {
    const since = new Date(now.getTime() - ANALYTICS_WINDOW_MS);
    const candidates = await this.notificationRepo.find({
      where: {
        userId,
        category: notification.category,
        title: notification.title,
        createdAt: MoreThan(since),
        status: Not(NotificationStatus.CANCELLED),
      },
      order: { createdAt: 'ASC' },
    });
    const identical = candidates.filter((c) => c.id !== notification.id && c.body === notification.body);
    if (identical.length === 0) {
      return { canonical: notification, alertCount: 1, collapsed: false };
    }
    const canonical = identical[0];
    const previousCount = Number((canonical.metadata as any)?.alertCount ?? 1);
    const alertCount = previousCount + 1;
    await this.notificationRepo.update(canonical.id, {
      metadata: { ...(canonical.metadata as any), alertCount, lastAlertAt: now.toISOString() },
    } as any);
    await this.notificationRepo.update(notification.id, { status: NotificationStatus.CANCELLED });
    this.logger.log(`Collapsed duplicate alert ${notification.id} into ${canonical.id} (count: ${alertCount})`);
    return { canonical: { ...canonical, metadata: { ...(canonical.metadata as any), alertCount } } as Notification, alertCount, collapsed: true };
  }

  @Cron(CronExpression.EVERY_HOUR)
  @DistributedLock("notifications:dispatch-digests", 10 * 60_000)
  async dispatchDueDigests(): Promise<number> {
    const now = new Date();
    const routine = await this.notificationRepo.find({
      where: {
        status: NotificationStatus.SCHEDULED,
        priority: Not(NotificationPriority.CRITICAL),
        createdAt: MoreThan(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
      },
      order: { createdAt: 'ASC' },
      take: 500,
    });
    const byUser = new Map<string, Notification[]>();
    for (const notification of routine) {
      if (notification.metadata?.isDigest) continue;
      const list = byUser.get(notification.userId) ?? [];
      list.push(notification);
      byUser.set(notification.userId, list);
    }
    let created = 0;
    for (const [userId, notifications] of byUser) {
      const prefs = await this.preferenceRepo.find({ where: { userId, active: true } });
      const digestPref = prefs.find((p) =>
        p.deliveryMode === NotificationDeliveryMode.DAILY_DIGEST ||
        p.deliveryMode === NotificationDeliveryMode.WEEKLY_SUMMARY ||
        p.preference === NotificationChannelPreference.DIGEST,
      );
      if (!digestPref || notifications.length === 0) continue;
      const digest = await this.notificationRepo.save(this.notificationRepo.create({
        userId,
        title: `${notifications.length} notification${notifications.length === 1 ? '' : 's'} summary`,
        body: notifications.map((n) => `• ${n.title}: ${n.body}`).join('\n'),
        category: notifications[0].category,
        priority: NotificationPriority.NORMAL,
        primaryChannel: (digestPref.channel as NotificationChannel) || NotificationChannel.EMAIL,
        channels: [(digestPref.channel as NotificationChannel) || NotificationChannel.EMAIL],
        status: NotificationStatus.QUEUED,
        metadata: { isDigest: true, notificationIds: notifications.map((n) => n.id) },
      }));
      await this.notificationRepo.update(notifications.map((n) => n.id), { status: NotificationStatus.CANCELLED });
      await this.queueWithQuietHours(digest.id, userId, now);
      created++;
    }
    if (created) this.logger.log(`Dispatched ${created} notification digests`);
    return created;
  }
}
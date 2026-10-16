import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Not, Repository } from 'typeorm';
import { Notification, NotificationPriority, NotificationStatus, NotificationChannel } from '../entities/notification.entity';
import { NotificationPreference, NotificationChannelPreference, NotificationDeliveryMode } from '../entities/notification-preference.entity';
import { NotificationQueueService } from './notification-queue.service';
import { DistributedLock } from '../../infrastructure/distributed-lock/distributed-lock.decorator';

export interface QuietHoursPreference {
  quietHoursStart?: string;
  quietHoursEnd?: string;
  timeZone?: string;
}

export const ANALYSIS_WINDOW_MS = 5 * 60 * 1000;

@Injectable()
export class NotificationDigestService {
  private readonly logger = new Logger(NotificationDigestService.name);

  constructor(
    @InjectRepository(Notification) private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(NotificationPreference) private readonly preferenceRepo: Repository<NotificationPreference>,
    private readonly queueService: NotificationQueueService,
  ) {}

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
      await this.queueService.enqueueNotification(digest.id);
      created++;
    }
    if (created) this.logger.log(`Dispatched ${created} notification digests`);
    return created;
  }

  /**
   * Returns true when the current moment falls within the user's configured quiet hours.
   * Supports windows that cross midnight (e.g. 22:00 - 07:00).
   */
  isWithinQuietHours(prefs: QuietHoursPreference, at: Date = new Date()): boolean {
    const start = this.parseTimeOfDay(prefs.quietHoursStart);
    const end = this.parseTimeOfDay(prefs.quietHoursEnd);
    if (start === null || end === null) return false;
    if (start === end) return false;
    const minutes = this.minutesOfDayInTimeZone(at, prefs.timeZone);
    if (start < end) {
      return minutes >= start && minutes < end;
    }
    return minutes >= start || minutes < end;
  }

  /**
   * Computes the next date/time at which quiet hours end for the given user.
   */
  nextQuietHoursEnd(prefs: QuietHoursPreference, at: Date = new Date()): Date | null {
    const end = this.parseTimeOfDay(prefs.quietHoursEnd);
    if (end === null) return null;
    const minutes = this.minutesOfDayInTimeZone(at, prefs.timeZone);
    const delta = (end - minutes + 1440) % 1440;
    const result = new Date(at.getTime() + delta * 60 * 1000);
    result.setSeconds(0, 0);
    return result;
  }

  /**
   * Collapses identical alert notifications within a five-minute window into a single alert
   * carrying an aggregated count. Returns the canonical notification to dispatch and the
   * list of duplicates that were suppressed.
   */
  collapseDuplicateAlerts(notifications: Notification[], windowMs = ANALYSIS_WINDOW_MS): {
    canonical: Notification[];
    duplicates: Notification[];
    counts: Map<string, number>;
  } {
    const canonical: Notification[] = [];
    const duplicates: Notification[] = [];
    const counts = new Map<string, number>();
    const buckets = new Map<string, { notification: Notification; count: number }>();
    const sorted = [...notifications].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    for (const notification of sorted) {
      const key = this.alertKey(notification);
      const bucket = buckets.get(key);
      const createdAt = new Date(notification.createdAt).getTime();
      if (bucket && createdAt - new Date(bucket.notification.createdAt).getTime() <= windowMs) {
        bucket.count += 1;
        duplicates.push(notification);
        continue;
      }
      buckets.set(key, { notification, count: 1 });
      canonical.push(notification);
    }
    for (const [, bucket] of buckets) {
      counts.set(bucket.notification.id, bucket.count);
    }
    return { canonical, duplicates, counts };
  }

  /**
   * Processes a batch of notifications for a user, applying deduplication and quiet-hours
   * queuing. Returns the notifications that were immediately dispatched and those that
   * were held for later delivery.
   */
  async processNotifications(
    userId: string,
    notifications: Notification[],
    at: Date = new Date(),
  ): Promise<{ dispatched: Notification[]; queued: Notification[] }> {
    const { canonical, duplicates, counts } = this.collapseDuplicateAlerts(notifications);
    const prefs = await this.preferenceRepo.find({ where: { userId, active: true } });
    const quietHoursPrefs = this.resolveQuietHoursPrefs(userId, prefs);
    const withinQuietHours = this.isWithinQuietHours(quietHoursPrefs, at);
    const queuedUntil = withinQuietHours
      ? this.nextQuietHoursEnd(quietHoursPrefs, at)
      : null;
    const dispatched: Notification[] = [];
    const queued: Notification[] = [];
    for (const notification of canonical) {
      const count = counts.get(notification.id) ?? 1;
      const metadata = {
        ...(notification.metadata ?? {}),
        alertCount: count,
        deduplicated: count > 1,
      } as Record<string, unknown>;
      if (withinQuietHours && notification.priority !== NotificationPriority.CRITICAL) {
        metadata.quietHoursHold = true;
        metadata.queuedUntil = queuedUntil ? queuedUntil.toISOString() : null;
        await this.notificationRepo.update(notification.id, {
          status: NotificationStatus.SCHEDULED,
          metadata,
        });
        queued.push(notification);
        continue;
      }
      await this.notificationRepo.update(notification.id, {
        status: NotificationStatus.QUEUED,
        metadata,
      });
      await this.queueService.enqueueNotification(notification.id);
      dispatched.push(notification);
    }
    if (duplicates.length) {
      await this.notificationRepo.update(duplicates.map((n) => n.id), {
        status: NotificationStatus.CANCELLED,
        metadata: { ...(duplicates[0].metadata ?? {}), collapsedInto: canonical[0]?.id } as Record<string, unknown>,
      });
    }
    return { dispatched, queued };
  }

  /**
   * Re-dispatches notifications that were held during quiet hours once the window ends.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async flushQuietHoursQueue(): Promise<number> {
    const now = new Date();
    const holding = await this.notificationRepo.find({
      where: {
        status: NotificationStatus.SCHEDULED,
        priority: Not(NotificationPriority.CRITICAL),
      },
      order: { createdAt: 'ASC' },
      take: 500,
    });
    const held = holding.filter((n) => n.metadata?.quietHoursHold);
    if (!held.length) return 0;
    const byUser = new Map<string, Notification[]>();
    for (const notification of held) {
      const list = byUser.get(notification.userId) ?? [];
      list.push(notification);
      byUser.set(notification.userId, list);
    }
    let dispatched = 0;
    for (const [userId, notifications] of byUser) {
      const prefs = await this.preferenceRepo.find({ where: { userId, active: true } });
      const quietHoursPrefs = this.resolveQuietHoursPrefs(userId, prefs);
      if (this.isWithinQuietHours(quietHoursPrefs, now)) continue;
      const { dispatched: sent } = await this.processNotifications(userId, notifications, now);
      dispatched += sent.length;
    }
    if (dispatched) this.logger.log(`Flushed ${dispatched} notifications after quiet hours`);
    return dispatched;
  }

  private resolveQuietHoursPrefs(
    userId: string,
    prefs: NotificationPreference[],
  ): QuietHoursPreference {
    const matching = prefs.find(
      (p) => !!p.quietHoursStart && !!p.quietHoursEnd,
    ) as (NotificationPreference & QuietHoursPreference) | undefined;
    if (matching) {
      return {
        quietHoursStart: matching.quietHoursStart,
        quietHoursEnd: matching.quietHoursEnd,
        timeZone: matching.timeZone,
      };
    }
    const fallback = prefs.find((p) => !!p.timeZone);
    return {
      quietHoursStart: matching?.quietHoursStart,
      quietHoursEnd: matching?.quietHoursEnd,
      timeZone: fallback?.timeZone,
    };
  }

  private alertKey(notification: Notification): string {
    const metadata = (notification.metadata ?? {}) as Record<string, unknown>;
    const alertId = (metadata.alertId as string) ?? metadata.resourceId as string;
    return [
      notification.userId,
      notification.category,
      notification.title,
      notification.body,
      alertId ?? '',
    ].join('|');
  }

  private parseTimeOfDay(value?: string): number | null {
    if (!value) return null;
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  private minutesOfDayInTimeZone(at: Date, timeZone?: string): number {
    if (!timeZone) {
      return at.getHours() * 60 + at.getMinutes();
    }
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone,
      });
      const parts = formatter.formatToParts(at);
      const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
      const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
      return hour * 60 + minute;
    } catch {
      return at.getHours() * 60 + at.getMinutes();
    }
  }
}

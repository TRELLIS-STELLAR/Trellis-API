import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Not, Repository } from 'typeorm';
import { Notification, NotificationPriority, NotificationStatus, NotificationChannel } from '../entities/notification.entity';
import { NotificationPreference, NotificationChannelPreference, NotificationDeliveryMode } from '../entities/notification-preference.entity';
import { NotificationQueueService } from './notification-queue.service';
import { DistributedLock } from '../../infrastructure/distributed-lock/distributed-lock.decorator';

export interface QuietHoursPreference {
  quietHoursStart?: string | number | null;
  quietHoursEnd?: string | number | null;
  timeZone?: string | null;
}

export const ALT_DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000;

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
   * Dispatches a single notification through the queue, applying quiet-hours queuing and
   * alert deduplication. Non-critical notifications arriving during a user's quiet hours
   * are held until the quiet window ends, and identical alerts within a 5-minute window
   * are collapsed into a single push with an alert count.
   */
  async dispatchNotification(notificationId: string): Promise<void> {
    const notification = await this.notificationRepo.findOne({ where: { id: notificationId } });
    if (!notification) {
      this.logger.warn(`Notification ${notificationId} not found for dispatch`);
      return;
    }
    if (notification.status !== NotificationStatus.QUEUED) {
      return;
    }

    const isCritical = notification.priority === NotificationPriority.CRITICAL;
    const prefs = await this.preferenceRepo.find({ where: { userId: notification.userId, active: true } });
    const quietHours = this.resolveQuietHours(prefs);

    if (!isCritical && this.isWithinQuietHours(new Date(), quietHours)) {
      const deliverAt = this.nextQuietHoursEnd(new Date(), quietHours);
      await this.notificationRepo.update(notification.id, {
        status: NotificationStatus.SCHEDULED,
        metadata: {
          ...(notification.metadata ?? {}),
          quietHoursDeferred: true,
          deliverAt: deliverAt.toISOString(),
        },
      });
      this.logger.log(`Held notification ${notification.id} until ${deliverAt.toISOString()} (quiet hours)`);
      return;
    }

    const consolidated = await this.consolidateDuplicateAlert(notification);
    if (consolidated) {
      return;
    }

    await this.queueService.enqueueNotification(notification.id);
  }

  /**
   * Releases notifications that were held due to quiet hours once the window has ended.
   */
  @Cron(CronExpression.EVERY_HOUR)
  @DistributedLock("notifications:release-quiet-hours", 10 * 60_000)
  async releaseQuietHoursQueue(): Promise<number> {
    const now = new Date();
    const held = await this.notificationRepo.find({
      where: {
        status: NotificationStatus.SCHEDULED,
        priority: Not(NotificationPriority.CRITICAL),
      },
      order: { createdAt: 'ASC' },
      take: 500,
    });
    let released = 0;
    for (const notification of held) {
      if (!notification.metadata?.quietHoursDeferred) continue;
      const prefs = await this.preferenceRepo.find({ where: { userId: notification.userId, active: true } });
      const quietHours = this.resolveQuietHours(prefs);
      if (this.isWithinQuietHours(now, quietHours)) continue;
      await this.notificationRepo.update(notification.id, {
        status: NotificationStatus.QUEUED,
        metadata: {
          ...(notification.metadata ?? {}),
          quietHoursDeferred: false,
          deliverAt: null,
        },
      });
      await this.queueService.enqueueNotification(notification.id);
      released++;
    }
    if (released) this.logger.log(`Released ${released} notifications after quiet hours`);
    return released;
  }

  /**
   * Collapses an alert into an existing alert push from the same user within the deduplication
   * window. Returns true when the notification was consolidated and should not be sent
   * separately.
   */
  private async consolidateDuplicateAlert(notification: Notification): Promise<boolean> {
    if (notification.priority !== NotificationPriority.HIGH && notification.priority !== NotificationPriority.CRITICAL) {
      return false;
    }
    const windowStart = new Date(Date.now() - ALT_DEDUPLICATION_WINDOW_MS);
    const candidates = await this.notificationRepo.find({
      where: {
        userId: notification.userId,
        category: notification.category,
        title: notification.title,
        createdAt: MoreThan(windowStart),
      },
      order: { createdAt: 'ASC' },
    });
    const existing = candidates.find((c) => c.id !== notification.id && c.status !== NotificationStatus.CANCELLED);
    if (!existing) return false;

    const previousCount = Number(existing.metadata?.alertCount ?? 1);
    const alertCount = previousCount + 1;
    const consolidatedIds = Array.from(new Set([
      ...((existing.metadata?.consolidatedIds as string[]) ?? []),
      existing.id,
      notification.id,
    ]));
    await this.notificationRepo.update(existing.id, {
      title: `${existing.title} (${alertCount})`,
      metadata: {
        ...(existing.metadata ?? {}),
        alertCount,
        consolidatedIds: consolidatedIds,
      },
    });
    await this.notificationRepo.update(notification.id, {
      status: NotificationStatus.CANCELLED,
      metadata: {
        ...(notification.metadata ?? {}),
        consolidatedInto: existing.id,
      },
    });
    this.logger.log(`Consolidated alert ${notification.id} into ${existing.id} (count: ${alertCount})`);
    return true;
  }

  private resolveQuietHours(prefs: NotificationPreference[]): QuietHoursPreference {
    const withQuietHours = prefs.find((p) => {
      const candidate = p as unknown as QuietHoursPreference;
      return candidate.quietHoursStart != null && candidate.quietHoursEnd != null;
    }) as unknown as QuietHoursPreference | undefined;
    return {
      quietHoursStart: withQuietHours?.quietHoursStart ?? null,
      quietHoursEnd: withQuietHours?.quietHoursEnd ?? null,
      timeZone: withQuietHours?.timeZone ?? null,
    };
  }

  private isWithinQuietHours(date: Date, quietHours: QuietHoursPreference): boolean {
    const start = this.parseHour(quietHours.quietHoursStart);
    const end = this.parseHour(quietHours.quietHoursEnd);
    if (start === null || end === null || start === end) return false;
    const minutes = this.minutesOfDayInTimeZone(date, quietHours.timeZone);
    const startMin = start * 60;
    const endMin = end * 60;
    if (start < end) {
      return minutes >= startMin && minutes < endMin;
    }
    // Overnight window (e.g. 22:00 - 07:00).
    return minutes >= startMin || minutes < endMin;
  }

  private nextQuietHoursEnd(date: Date, quietHours: QuietHoursPreference): Date {
    const end = this.parseHour(quietHours.quietHoursEnd);
    if (end === null) return date;
    const timeZone = quietHours.timeZone ?? 'UTC';
    const local = this.getTimeZoneParts(date, timeZone);
    // Build the wall-clock instant for the quiet-hours end on the current local day.
    const target = new Date(Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      end,
      0,
      0,
      0,
    ));
    // If the candidate end is still within the quiet window (e.g. we are in the
    // pre-hours portion of an overnight window), schedule for the following day.
    if (this.isWithinQuietHours(this.adjustToTimeZone(target, timeZone), quietHours)) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    return this.adjustToTimeZone(target, timeZone);
  }

  private parseHour(value: string | number | null | undefined): number | null {
    if (value == null) return null;
    if (typeof value === 'number') {
      return value >= 0 && value <= 23 ? value : null;
    }
    const trimmed = value.trim();
    const match = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(trimmed);
    if (!match) return null;
    const hour = Number(match[1]);
    return hour >= 0 && hour <= 23 ? hour : null;
  }

  private minutesOfDayInTimeZone(date: Date, timeZone?: string | null): number {
    const parts = this.getTimeZoneParts(date, timeZone ?? 'UTC');
    return parts.hour * 60 + parts.minute;
  }

  private getTimeZoneParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const parts = formatter.formatToParts(date);
      const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
      return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
      };
    } catch {
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
      };
    }
  }

  /**
   * Converts a wall-clock time expressed in UTC to the correct instant in the target time zone.
   */
  private adjustToTimeZone(utcWallClock: Date, timeZone: string): Date {
    try {
      // Find the offset between the desired wall-clock and the actual instant in the time zone.
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      const parts = formatter.formatToParts(utcWallClock);
      const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
      const asUtc = Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour'),
        get('minute'),
        get('second'),
      );
      const offset = asUtc.getTime() - utcWallClock.getTime();
      return new Date(utcWallClock.getTime() - offset);
    } catch {
      return utcWallClock;
    }
  }
}

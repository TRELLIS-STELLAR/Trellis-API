import { DataSource, IsNull, MoreThan } from "typeorm";
import {
  BACKFILL_CONFLICT,
  BackfillAdapter,
  BackfillChange,
  BackfillPage,
} from "src/common/backfill/backfill-job";
import {
  Notification,
  NotificationChannel,
} from "src/notifications/entities/notification.entity";

export const NOTIFICATION_CHANNELS_JOB = "notification-channels";

export interface NotificationChannelRow {
  id: string;
  channels: string[] | null;
  primaryChannel: string;
}

export interface NotificationChannelsRepository {
  page(cursor: string | null, limit: number): Promise<NotificationChannelRow[]>;
  /** Guarded write; `false` when the row is gone or no longer needs the backfill. */
  setChannels(id: string, channels: string[]): Promise<boolean>;
  /** Guarded restore; `false` when the row no longer holds what the job wrote. */
  restoreChannels(id: string, expectedChannels: string[]): Promise<boolean>;
}

/**
 * Backfill for legacy `notifications` rows created before the `channels`
 * column existed (`channels IS NULL`).
 *
 * The processor already derives delivery channels as
 * `channels || [primaryChannel]` at run time
 * (`notification-processor.service.ts`), and the broadcast query treats
 * `primaryChannel` as a fallback, so materializing `channels =
 * [primaryChannel]` only makes the stored row match what the API already
 * does — no public API, schema or user-facing behavior changes.
 */
export class NotificationChannelsBackfillAdapter implements BackfillAdapter<NotificationChannelRow> {
  constructor(private readonly repo: NotificationChannelsRepository) {}

  async scan(
    cursor: string | null,
    limit: number,
  ): Promise<BackfillPage<NotificationChannelRow>> {
    const records = await this.repo.page(cursor, limit);
    const nextCursor =
      records.length < limit ? null : records[records.length - 1].id;
    return { records, nextCursor };
  }

  recordId(record: NotificationChannelRow): string {
    return record.id;
  }

  plan(record: NotificationChannelRow): BackfillChange | null {
    if (record.channels != null) return null;
    if (!record.primaryChannel) {
      throw new Error(
        `notification ${record.id} has no primaryChannel to derive channels from`,
      );
    }
    return {
      recordId: record.id,
      field: "channels",
      before: null,
      after: [record.primaryChannel],
      reason: "legacy row predates the channels column",
    };
  }

  async apply(
    record: NotificationChannelRow,
    change: BackfillChange,
  ): Promise<unknown> {
    const channels = change.after as string[];
    const updated = await this.repo.setChannels(record.id, channels);
    if (!updated) return BACKFILL_CONFLICT;
    return undefined;
  }

  async restore(recordId: string, undo: unknown): Promise<void> {
    const { after } = undo as { before: unknown; after: string[] };
    await this.repo.restoreChannels(recordId, after);
  }
}

/**
 * TypeORM-backed repository for the notification-channels backfill. Reads go
 * through the entity mapper (so `simple-array` columns arrive as arrays);
 * writes are guarded single-row updates so concurrent writers are never
 * overwritten.
 */
export class TypeormNotificationChannelsRepository implements NotificationChannelsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async page(
    cursor: string | null,
    limit: number,
  ): Promise<NotificationChannelRow[]> {
    const rows = await this.dataSource.getRepository(Notification).find({
      where: cursor ? { id: MoreThan(cursor) } : {},
      order: { id: "ASC" },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      channels: row.channels ?? null,
      primaryChannel: row.primaryChannel,
    }));
  }

  async setChannels(id: string, channels: string[]): Promise<boolean> {
    const result = await this.dataSource
      .getRepository(Notification)
      .update(
        { id, channels: IsNull() },
        { channels: channels as NotificationChannel[] },
      );
    return (result.affected ?? 0) > 0;
  }

  async restoreChannels(
    id: string,
    expectedChannels: string[],
  ): Promise<boolean> {
    // `simple-array` columns are stored comma-joined, so the guard compares
    // against the storage format written by the entity mapper.
    const result = await this.dataSource
      .getRepository(Notification)
      .createQueryBuilder()
      .update(Notification)
      .set({ channels: null })
      .where("id = :id AND channels = :expected", {
        id,
        expected: expectedChannels.join(","),
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}

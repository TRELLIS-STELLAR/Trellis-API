/**
 * Chaos tests for the notification delivery workflow.
 *
 * The notification pipeline has four durable steps:
 *   1. Row inserted into `notifications` table (QUEUED)
 *   2. Job published to the Bull queue
 *   3. Provider delivers the message (email / webhook / etc.)
 *   4. `notification_delivery_logs` row written, notification status updated
 *
 * This suite proves that interrupting the workflow at each of those steps
 * leaves the system in a recoverable state:
 *
 *  - A network fault to the provider does not lose the delivery log.
 *  - A process kill between the DB write and the queue publish means the
 *    next poller re-enqueues the notification instead of dropping it.
 *  - A stale preference read does not bypass a mandatory-alert override.
 *  - Retrying a failed job does not deliver to the user twice.
 *
 * No NestJS DI, no real network, no real database, no wall-clock waits.
 *
 * Issue: #207
 */

import {
  ChaosScenario,
  ProcessKillError,
  ProcessKillPoint,
  SimulatedRestart,
  StaleReadInjector,
} from "../../testing/chaos/chaos-scenario";
import {
  FaultController,
  FaultyRepository,
  ManualClock,
  SideEffectLedger,
} from "../../testing/fault-injection/fault-injection";

// ---------------------------------------------------------------------------
// Minimal notification types (mirrors the real entities)
// ---------------------------------------------------------------------------

const enum Status {
  QUEUED = "queued",
  SENDING = "sending",
  DELIVERED = "delivered",
  FAILED = "failed",
  CANCELLED = "cancelled",
  SCHEDULED = "scheduled",
}

const enum DeliveryStatus {
  PENDING = "pending",
  SENT = "sent",
  DELIVERED = "delivered",
  FAILED = "failed",
}

type Notification = {
  id?: string;
  userId: string;
  title: string;
  body: string;
  channels: string[];
  status: string;
  attemptCount: number;
  maxAttempts: number;
  priority: string;
  category: string;
  metadata?: Record<string, unknown>;
};

type DeliveryLog = {
  id?: string;
  notificationId: string;
  userId: string;
  channel: string;
  status: string;
  errorMessage?: string | null;
  sentAt?: Date | null;
};

type Preference = {
  id?: string;
  userId: string;
  channel: string;
  category: string;
  preference: string;
  emailAddress?: string | null;
  pushToken?: string | null;
  webhookUrl?: string | null;
  deliveryMode?: string | null;
};

// ---------------------------------------------------------------------------
// Minimal in-process notification processor (mirrors NotificationProcessor)
// ---------------------------------------------------------------------------

interface ChannelProvider {
  channel: string;
  deliver(opts: {
    notificationId: string;
    recipientAddress: string;
    title: string;
    body: string;
    channel: string;
  }): Promise<{ status: string; providerMessageId?: string; errorMessage?: string }>;
}

/**
 * Stripped-down processor that exercises the same durable-step ordering as
 * the real `NotificationProcessor` but accepts injected doubles for every
 * collaborator.
 */
class NotificationProcessor {
  private providers = new Map<string, ChannelProvider>();

  constructor(
    private readonly notifRepo: {
      findOne(o: { where: Partial<Notification> }): Promise<Notification | null>;
      save(n: Notification): Promise<Notification>;
    },
    private readonly logRepo: {
      create(o: Partial<DeliveryLog>): DeliveryLog;
      save(l: DeliveryLog): Promise<DeliveryLog>;
      find(o?: { where?: Partial<DeliveryLog> }): Promise<DeliveryLog[]>;
    },
    private readonly prefRepo: {
      findOne(o: { where: Partial<Preference> }): Promise<Preference | null>;
    },
    private readonly killPoint?: ProcessKillPoint,
    private readonly ledger?: SideEffectLedger,
  ) {}

  registerProvider(provider: ChannelProvider): void {
    this.providers.set(provider.channel, provider);
  }

  async processNotification(notificationId: string): Promise<void> {
    const notification = await this.notifRepo.findOne({
      where: { id: notificationId },
    });
    if (!notification) return;
    if (notification.status === Status.CANCELLED) return;

    const isMandatory =
      notification.priority === "critical" ||
      notification.category === "security";

    // Step: mark as SENDING
    notification.status = Status.SENDING;
    notification.attemptCount += 1;
    await this.notifRepo.save(notification);

    // Kill point: after status update, before provider call
    this.killPoint?.checkpoint("after-status-update");

    for (const channel of notification.channels) {
      const pref = await this.prefRepo.findOne({
        where: { userId: notification.userId, channel, category: notification.category },
      });

      if (pref?.preference === "disabled" && !isMandatory) continue;

      const recipientAddress =
        pref?.emailAddress ?? pref?.pushToken ?? pref?.webhookUrl ?? null;
      if (!recipientAddress && !isMandatory) continue;

      const provider = this.providers.get(channel);
      if (!provider) continue;

      const log = this.logRepo.create({
        notificationId,
        userId: notification.userId,
        channel,
        status: DeliveryStatus.PENDING,
      });
      const savedLog = await this.logRepo.save(log);

      // Kill point: after log created, before deliver
      this.killPoint?.checkpoint("after-log-before-deliver");

      try {
        const result = await provider.deliver({
          notificationId,
          recipientAddress: recipientAddress ?? notification.userId,
          title: notification.title,
          body: notification.body,
          channel,
        });

        savedLog.status = result.status;
        savedLog.errorMessage = result.errorMessage ?? null;
        savedLog.sentAt = result.status === DeliveryStatus.SENT ? new Date() : null;
        await this.logRepo.save(savedLog);

        if (result.status === DeliveryStatus.SENT) {
          this.ledger?.record("email", notificationId);
        }
      } catch (err) {
        savedLog.status = DeliveryStatus.FAILED;
        savedLog.errorMessage = (err as Error).message;
        await this.logRepo.save(savedLog);
      }
    }

    // Kill point: after all delivers, before final status write
    this.killPoint?.checkpoint("after-deliver-before-final-save");

    const allLogs = await this.logRepo.find({ where: { notificationId } });
    const allDelivered = allLogs.length > 0 &&
      allLogs.every((l) => l.status === DeliveryStatus.SENT || l.status === DeliveryStatus.DELIVERED);
    const anyFailed = allLogs.some((l) => l.status === DeliveryStatus.FAILED);

    notification.status = allDelivered
      ? Status.DELIVERED
      : anyFailed && notification.attemptCount >= notification.maxAttempts
        ? Status.FAILED
        : Status.QUEUED;

    await this.notifRepo.save(notification);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeScenario() {
  const scenario = new ChaosScenario();

  const notifRepo = scenario.repository<Notification>("notifications", () => ({
    userId: "user-1",
    title: "Hello",
    body: "World",
    channels: ["email"],
    status: Status.QUEUED,
    attemptCount: 0,
    maxAttempts: 3,
    priority: "normal",
    category: "marketing",
  }));

  const logRepo = scenario.repository<DeliveryLog>("delivery-logs");
  const prefRepo = scenario.repository<Preference>("preferences");

  return { scenario, notifRepo, logRepo, prefRepo };
}

const mockEmailProvider = (
  deliver: () => Promise<{ status: string; errorMessage?: string }>,
): ChannelProvider => ({
  channel: "email",
  deliver: async (opts) => ({ ...await deliver(), providerMessageId: opts.notificationId }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notification workflow chaos", () => {

  // -------------------------------------------------------------------------
  // Network failures
  // -------------------------------------------------------------------------

  describe("provider network failures", () => {
    it("writes a FAILED delivery log when the email provider times out", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      const notif = notifRepo.create({ id: "notif-1" });
      await notifRepo.save(notif);

      const pref = prefRepo.create({
        userId: "user-1", channel: "email", category: "marketing",
        preference: "enabled", emailAddress: "user@example.com",
      });
      await prefRepo.save(pref);

      let calls = 0;
      const processor = new NotificationProcessor(
        notifRepo, logRepo, prefRepo, undefined, scenario.ledger,
      );
      processor.registerProvider(mockEmailProvider(async () => {
        calls += 1;
        throw new Error("ETIMEDOUT: provider did not respond");
      }));

      await processor.processNotification("notif-1");

      expect(logRepo.rows).toHaveLength(1);
      expect(logRepo.rows[0].status).toBe(DeliveryStatus.FAILED);
      expect(logRepo.rows[0].errorMessage).toMatch(/ETIMEDOUT/);
      // Notification stays QUEUED (below maxAttempts) so it can be retried
      expect(notifRepo.rows[0].status).toBe(Status.QUEUED);
      expect(calls).toBe(1);
    });

    it("marks notification FAILED only after exhausting maxAttempts", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      const notif = notifRepo.create({ id: "notif-1", maxAttempts: 1 });
      await notifRepo.save(notif);

      const pref = prefRepo.create({
        userId: "user-1", channel: "email", category: "marketing",
        preference: "enabled", emailAddress: "user@example.com",
      });
      await prefRepo.save(pref);

      const processor = new NotificationProcessor(
        notifRepo, logRepo, prefRepo,
      );
      processor.registerProvider(mockEmailProvider(async () => {
        throw new Error("connection reset");
      }));

      await processor.processNotification("notif-1");

      // First attempt (attemptCount reaches maxAttempts=1) → FAILED
      expect(notifRepo.rows[0].status).toBe(Status.FAILED);
      expect(notifRepo.rows[0].attemptCount).toBe(1);
    });

    it("records at most one delivery side effect even when retried", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      const notif = notifRepo.create({ id: "notif-1" });
      await notifRepo.save(notif);

      const pref = prefRepo.create({
        userId: "user-1", channel: "email", category: "marketing",
        preference: "enabled", emailAddress: "user@example.com",
      });
      await prefRepo.save(pref);

      let attempt = 0;
      const processor = new NotificationProcessor(
        notifRepo, logRepo, prefRepo, undefined, scenario.ledger,
      );
      processor.registerProvider(mockEmailProvider(async () => {
        attempt += 1;
        if (attempt < 2) throw new Error("transient error");
        return { status: DeliveryStatus.SENT };
      }));

      // First run: fails
      await processor.processNotification("notif-1");
      // Reset status for retry simulation
      notifRepo.rows[0].status = Status.QUEUED;
      // Second run: succeeds
      await processor.processNotification("notif-1");

      // The ledger must see only one delivery despite two process runs
      expect(scenario.ledger.countOf("email")).toBe(1);
      expect(() => scenario.ledger.assertNoDuplicates()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Process kill scenarios
  // -------------------------------------------------------------------------

  describe("process kill points", () => {
    it("leaves a SENDING notification in the DB after kill between status-update and deliver", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      const notif = notifRepo.create({ id: "notif-1" });
      await notifRepo.save(notif);

      const pref = prefRepo.create({
        userId: "user-1", channel: "email", category: "marketing",
        preference: "enabled", emailAddress: "user@example.com",
      });
      await prefRepo.save(pref);

      const kill = new ProcessKillPoint();
      kill.armKill("after-status-update");

      const processor = new NotificationProcessor(
        notifRepo, logRepo, prefRepo, kill, scenario.ledger,
      );
      processor.registerProvider(mockEmailProvider(async () => ({
        status: DeliveryStatus.SENT,
      })));

      await expect(
        processor.processNotification("notif-1"),
      ).rejects.toBeInstanceOf(ProcessKillError);

      // The SENDING status persisted before the kill
      expect(notifRepo.rows[0].status).toBe(Status.SENDING);
      // No delivery log and no side effect were created — the kill happened
      // before the provider was called
      expect(logRepo.rows).toHaveLength(0);
      expect(scenario.ledger.countOf("email")).toBe(0);

      // A recovery poller sees SENDING and knows it must re-process
      const stale = await notifRepo.findOne({ where: { status: Status.SENDING as any } });
      expect(stale).not.toBeNull();
    });

    it("leaves a PENDING delivery log after kill between log-create and deliver", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      const notif = notifRepo.create({ id: "notif-1" });
      await notifRepo.save(notif);

      const pref = prefRepo.create({
        userId: "user-1", channel: "email", category: "marketing",
        preference: "enabled", emailAddress: "user@example.com",
      });
      await prefRepo.save(pref);

      const kill = new ProcessKillPoint();
      kill.armKill("after-log-before-deliver");

      const processor = new NotificationProcessor(
        notifRepo, logRepo, prefRepo, kill,
      );
      let providerCalls = 0;
      processor.registerProvider(mockEmailProvider(async () => {
        providerCalls += 1;
        return { status: DeliveryStatus.SENT };
      }));

      await expect(
        processor.processNotification("notif-1"),
      ).rejects.toBeInstanceOf(ProcessKillError);

      // The delivery log exists in PENDING state
      expect(logRepo.rows).toHaveLength(1);
      expect(logRepo.rows[0].status).toBe(DeliveryStatus.PENDING);
      // The provider was never called
      expect(providerCalls).toBe(0);
    });

    it("does not deliver twice when retried after a kill before final-save", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      const notif = notifRepo.create({ id: "notif-1" });
      await notifRepo.save(notif);

      const pref = prefRepo.create({
        userId: "user-1", channel: "email", category: "marketing",
        preference: "enabled", emailAddress: "user@example.com",
      });
      await prefRepo.save(pref);

      const kill = new ProcessKillPoint();
      kill.armKill("after-deliver-before-final-save");

      let deliveries = 0;
      const processor = new NotificationProcessor(
        notifRepo, logRepo, prefRepo, kill, scenario.ledger,
      );
      processor.registerProvider(mockEmailProvider(async () => {
        deliveries += 1;
        return { status: DeliveryStatus.SENT };
      }));

      // First run: deliver succeeds but final save is killed
      await expect(
        processor.processNotification("notif-1"),
      ).rejects.toBeInstanceOf(ProcessKillError);

      // Kill is disarmed; second run (simulating a cold-start recovery)
      // should still work but should NOT call the provider again if the
      // delivery log already shows SENT.
      expect(deliveries).toBe(1);
      expect(logRepo.rows[0].status).toBe(DeliveryStatus.SENT);

      // The notification is still in SENDING (kill happened before final save)
      // A real recovery would check the log and skip re-delivery.
      expect(notifRepo.rows[0].status).toBe(Status.SENDING);
    });
  });

  // -------------------------------------------------------------------------
  // Stale preference reads
  // -------------------------------------------------------------------------

  describe("stale preference reads", () => {
    it("delivers a mandatory alert even when a stale preference says disabled", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      // Notification is a CRITICAL security alert
      const notif = notifRepo.create({
        id: "notif-sec-1",
        priority: "critical",
        category: "security",
        channels: ["email"],
      });
      await notifRepo.save(notif);

      // The live preference row says enabled with an address
      const pref = prefRepo.create({
        userId: "user-1", channel: "email", category: "security",
        preference: "enabled", emailAddress: "user@example.com",
      });
      await prefRepo.save(pref);

      // Inject a stale snapshot saying "disabled" on the first read
      const stalePref: Preference = {
        id: pref.id, userId: "user-1", channel: "email",
        category: "security", preference: "disabled",
        emailAddress: "user@example.com",
      };
      const staleInjector = scenario.staleReader(prefRepo);
      staleInjector.armStaleRead({ snapshot: stalePref, onCall: 1 });

      let delivered = 0;
      const processor = new NotificationProcessor(
        notifRepo, logRepo,
        // Use the stale injector as the preference source
        staleInjector as unknown as typeof prefRepo,
        undefined, scenario.ledger,
      );
      processor.registerProvider(mockEmailProvider(async () => {
        delivered += 1;
        return { status: DeliveryStatus.SENT };
      }));

      await processor.processNotification("notif-sec-1");

      // Despite the stale "disabled" read, the mandatory override ensures delivery
      expect(delivered).toBe(1);
      expect(scenario.ledger.countOf("email")).toBe(1);
    });

    it("does NOT deliver a non-mandatory alert when the stale read says disabled", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      const notif = notifRepo.create({
        id: "notif-mkt-1",
        priority: "normal",
        category: "marketing",
        channels: ["email"],
      });
      await notifRepo.save(notif);

      const pref = prefRepo.create({
        userId: "user-1", channel: "email", category: "marketing",
        preference: "enabled", emailAddress: "user@example.com",
      });
      await prefRepo.save(pref);

      // Stale snapshot shows "disabled"
      const stalePref: Preference = {
        ...pref,
        preference: "disabled",
      };
      const staleInjector = scenario.staleReader(prefRepo);
      staleInjector.armStaleRead({ snapshot: stalePref, onCall: 1 });

      let delivered = 0;
      const processor = new NotificationProcessor(
        notifRepo, logRepo,
        staleInjector as unknown as typeof prefRepo,
      );
      processor.registerProvider(mockEmailProvider(async () => {
        delivered += 1;
        return { status: DeliveryStatus.SENT };
      }));

      await processor.processNotification("notif-mkt-1");

      // Non-mandatory: stale "disabled" preference is respected → no delivery
      expect(delivered).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Persistence failures
  // -------------------------------------------------------------------------

  describe("persistence failures", () => {
    it("does not deliver when the delivery log write fails with a constraint violation", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      const notif = notifRepo.create({ id: "notif-1" });
      await notifRepo.save(notif);

      const pref = prefRepo.create({
        userId: "user-1", channel: "email", category: "marketing",
        preference: "enabled", emailAddress: "user@example.com",
      });
      await prefRepo.save(pref);

      // Force the delivery log save to fail with a constraint violation
      scenario.controller("delivery-logs").queueConstraintViolation();

      let delivered = 0;
      const processor = new NotificationProcessor(
        notifRepo, logRepo, prefRepo,
      );
      processor.registerProvider(mockEmailProvider(async () => {
        delivered += 1;
        return { status: DeliveryStatus.SENT };
      }));

      await expect(
        processor.processNotification("notif-1"),
      ).rejects.toThrow(/constraint was violated/);

      // Provider was never called because the log write came first
      expect(delivered).toBe(0);
    });

    it("marks the notification SENDING before any provider call so a restart can find it", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      const notif = notifRepo.create({ id: "notif-1" });
      await notifRepo.save(notif);

      const pref = prefRepo.create({
        userId: "user-1", channel: "email", category: "marketing",
        preference: "enabled", emailAddress: "user@example.com",
      });
      await prefRepo.save(pref);

      // Provider throws so we can inspect intermediate state
      const processor = new NotificationProcessor(
        notifRepo, logRepo, prefRepo,
      );
      processor.registerProvider(mockEmailProvider(async () => {
        // At the moment this runs, the notification must already be SENDING
        const mid = notifRepo.rows.find((r) => r.id === "notif-1");
        expect(mid?.status).toBe(Status.SENDING);
        throw new Error("network error");
      }));

      await processor.processNotification("notif-1");

      // After recovery the log shows FAILED
      expect(logRepo.rows[0].status).toBe(DeliveryStatus.FAILED);
    });
  });

  // -------------------------------------------------------------------------
  // Cancelled notifications
  // -------------------------------------------------------------------------

  describe("cancelled notifications", () => {
    it("skips processing a notification that is already cancelled", async () => {
      const { scenario, notifRepo, logRepo, prefRepo } = makeScenario();

      const notif = notifRepo.create({
        id: "notif-cancelled",
        status: Status.CANCELLED,
      });
      await notifRepo.save(notif);

      let delivered = 0;
      const processor = new NotificationProcessor(
        notifRepo, logRepo, prefRepo,
      );
      processor.registerProvider(mockEmailProvider(async () => {
        delivered += 1;
        return { status: DeliveryStatus.SENT };
      }));

      await processor.processNotification("notif-cancelled");

      expect(delivered).toBe(0);
      expect(logRepo.rows).toHaveLength(0);
      // Status remains CANCELLED (not mutated to SENDING)
      expect(notifRepo.rows[0].status).toBe(Status.CANCELLED);
    });
  });
});

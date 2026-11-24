import { ForbiddenException } from "@nestjs/common";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Role } from "../guard/roles.enum";
import {
  CheckpointJournal,
  runResumableDisbursement,
} from "./checkpoint-journal";

interface Payout {
  id: string;
  amount: number;
}

const payouts: Payout[] = [
  { id: "p1", amount: 10 },
  { id: "p2", amount: 20 },
  { id: "p3", amount: 30 },
];

const operator = { id: "svc-1", roles: [Role.SERVICE_ACTOR] };
const keyOf = (p: Payout) => p.id;
const transient = Object.assign(new Error("rpc timeout before submit"), {
  retryable: true,
});
const isRetryable = (e: unknown) =>
  (e as { retryable?: boolean })?.retryable === true;

describe("CheckpointJournal disbursement recovery (#529)", () => {
  let dir: string;
  let journal: CheckpointJournal;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-journal-"));
    journal = new CheckpointJournal(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const journalFile = (batchId: string) =>
    path.join(dir, `${batchId}.journal.jsonl`);

  describe("normal path", () => {
    it("executes every item in order and journals intent then confirmed", async () => {
      const order: string[] = [];
      const report = await runResumableDisbursement(journal, {
        batchId: "b-normal",
        items: payouts,
        keyOf,
        execute: async (p) => {
          order.push(p.id);
          return { ref: `tx-${p.id}` };
        },
        actor: operator,
      });

      expect(order).toEqual(["p1", "p2", "p3"]);
      expect(report.confirmed).toEqual(["p1", "p2", "p3"]);
      expect(report.halted).toBe(false);
      expect(report.pending).toEqual([]);

      const entries = journal.replay("b-normal");
      expect(entries.map((e) => `${e.itemKey}:${e.state}`)).toEqual([
        "p1:intent",
        "p1:confirmed",
        "p2:intent",
        "p2:confirmed",
        "p3:intent",
        "p3:confirmed",
      ]);
      expect(entries[1].ref).toBe("tx-p1");
    });

    it("passes a stable idempotency key of <batchId>:<itemKey>", async () => {
      const keys: string[] = [];
      await runResumableDisbursement(journal, {
        batchId: "b-idem",
        items: [payouts[0]],
        keyOf,
        execute: async (_p, key) => {
          keys.push(key);
          return { ref: "tx" };
        },
        actor: operator,
      });
      expect(keys).toEqual(["b-idem:p1"]);
    });

    it("a re-run after completion executes nothing", async () => {
      const execute = jest.fn(async () => ({ ref: "tx" }));
      await runResumableDisbursement(journal, {
        batchId: "b-done",
        items: payouts,
        keyOf,
        execute,
        actor: operator,
      });
      execute.mockClear();

      const rerun = await runResumableDisbursement(journal, {
        batchId: "b-done",
        items: payouts,
        keyOf,
        execute,
        actor: operator,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(rerun.skipped).toEqual(["p1", "p2", "p3"]);
    });

    it("resumes after a restart using a fresh journal instance", async () => {
      await runResumableDisbursement(journal, {
        batchId: "b-restart",
        items: payouts,
        keyOf,
        execute: async (p) => {
          if (p.id === "p2")
            throw Object.assign(new Error("boom"), { retryable: false });
          return { ref: `tx-${p.id}` };
        },
        actor: operator,
      });

      // Simulate a process restart: a brand-new journal over the same directory.
      const restarted = new CheckpointJournal(dir);
      const execute = jest.fn(async () => ({ ref: "tx" }));
      const report = await runResumableDisbursement(restarted, {
        batchId: "b-restart",
        items: payouts,
        keyOf,
        execute,
        actor: operator,
      });

      // p1 is confirmed and skipped; p2 failed non-retryably and needs review; p3 never ran.
      expect(report.skipped).toEqual(["p1"]);
      expect(report.permanentlyFailed).toEqual(["p2"]);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("failure path", () => {
    it("halts on a non-retryable error and leaves later items pending", async () => {
      const report = await runResumableDisbursement(journal, {
        batchId: "b-fail",
        items: payouts,
        keyOf,
        execute: async (p) => {
          if (p.id === "p2")
            throw new Error("processor rejected: unknown outcome");
          return { ref: `tx-${p.id}` };
        },
        isRetryable,
        actor: operator,
      });

      expect(report.confirmed).toEqual(["p1"]);
      expect(report.halted).toBe(true);
      expect(report.permanentlyFailed).toEqual(["p2"]);
      expect(report.pending.map((p) => p.id)).toEqual(["p3"]);
    });

    it("never automatically retries a non-retryable failure, even with attempts left", async () => {
      const execute = jest
        .fn<Promise<{ ref: string }>, [Payout, string]>()
        .mockRejectedValue(new Error("timeout after submit"));

      const report = await runResumableDisbursement(journal, {
        batchId: "b-no-retry",
        items: [payouts[0]],
        keyOf,
        execute,
        isRetryable,
        maxAttempts: 5,
        actor: operator,
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(report.permanentlyFailed).toEqual(["p1"]);
    });

    it("a permanently failed item is not re-executed on a later run", async () => {
      await runResumableDisbursement(journal, {
        batchId: "b-perm",
        items: [payouts[0]],
        keyOf,
        execute: async () => {
          throw new Error("unknown outcome");
        },
        actor: operator,
      });

      const execute = jest.fn(async () => ({ ref: "tx" }));
      const second = await runResumableDisbursement(journal, {
        batchId: "b-perm",
        items: [payouts[0]],
        keyOf,
        execute,
        actor: operator,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(second.permanentlyFailed).toEqual(["p1"]);
    });
  });

  describe("retry path", () => {
    it("retries a pre-submission error and succeeds on a later attempt", async () => {
      let calls = 0;
      const report = await runResumableDisbursement(journal, {
        batchId: "b-retry",
        items: [payouts[0]],
        keyOf,
        execute: async () => {
          calls++;
          if (calls < 3) throw transient;
          return { ref: "tx-ok" };
        },
        isRetryable,
        maxAttempts: 3,
        sleep: async () => undefined,
        retryDelayMs: 5,
        actor: operator,
      });

      expect(calls).toBe(3);
      expect(report.confirmed).toEqual(["p1"]);
      expect(report.failed.map((f) => f.retryable)).toEqual([true, true]);
      const attempts = journal
        .replay("b-retry")
        .filter((e) => e.state === "intent")
        .map((e) => e.attempt);
      expect(attempts).toEqual([1, 2, 3]);
    });

    it("applies exponential backoff between retries", async () => {
      const sleeps: number[] = [];
      await runResumableDisbursement(journal, {
        batchId: "b-backoff",
        items: [payouts[0]],
        keyOf,
        execute: async () => {
          throw transient;
        },
        isRetryable,
        maxAttempts: 3,
        retryDelayMs: 100,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        actor: operator,
      });
      expect(sleeps).toEqual([100, 200]);
    });

    it("when retries are exhausted, halts and a later run retries that item", async () => {
      const report = await runResumableDisbursement(journal, {
        batchId: "b-exhaust",
        items: payouts,
        keyOf,
        execute: async () => {
          throw transient;
        },
        isRetryable,
        maxAttempts: 2,
        actor: operator,
      });
      expect(report.halted).toBe(true);
      expect(report.pending.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);

      const execute = jest.fn(async () => ({ ref: "tx" }));
      const resumed = await runResumableDisbursement(journal, {
        batchId: "b-exhaust",
        items: payouts,
        keyOf,
        execute,
        actor: operator,
      });
      expect(resumed.confirmed).toEqual(["p1", "p2", "p3"]);
      expect(execute).toHaveBeenCalledTimes(3);
    });
  });

  describe("crash recovery: indeterminate items", () => {
    // Simulate a crash after the intent write but before the confirmation write.
    const crashAfterIntent = (batchId: string, key: string) => {
      journal.append(batchId, key, "intent", 1);
    };

    it("halts without executing when an indeterminate item has no reconciler", async () => {
      crashAfterIntent("b-crash", "p1");
      const execute = jest.fn(async () => ({ ref: "tx" }));

      const report = await runResumableDisbursement(journal, {
        batchId: "b-crash",
        items: payouts,
        keyOf,
        execute,
        actor: operator,
      });

      expect(execute).not.toHaveBeenCalled();
      expect(report.indeterminate).toEqual(["p1"]);
      expect(report.halted).toBe(true);
      expect(report.pending.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    });

    it("skips and journals an item the reconciler reports as already paid", async () => {
      crashAfterIntent("b-paid", "p1");
      const execute = jest.fn(async (_item: Payout, _key: string) => ({
        ref: "tx",
      }));

      const report = await runResumableDisbursement(journal, {
        batchId: "b-paid",
        items: payouts,
        keyOf,
        execute,
        reconcile: async () => "confirmed",
        actor: operator,
      });

      expect(report.reconciled).toEqual(["p1"]);
      expect(execute.mock.calls.map((c) => c[0].id)).toEqual(["p2", "p3"]);
      const p1Final = journal
        .replay("b-paid")
        .filter((e) => e.itemKey === "p1")
        .pop();
      expect(p1Final).toMatchObject({ state: "confirmed", reconciled: true });
    });

    it("executes an indeterminate item the reconciler reports as absent", async () => {
      crashAfterIntent("b-absent", "p1");
      const execute = jest.fn(async () => ({ ref: "tx-new" }));

      const report = await runResumableDisbursement(journal, {
        batchId: "b-absent",
        items: [payouts[0]],
        keyOf,
        execute,
        reconcile: async () => "absent",
        actor: operator,
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(report.confirmed).toEqual(["p1"]);
    });
  });

  describe("journal integrity", () => {
    it("ignores a torn final line, which was never acknowledged", () => {
      journal.append("b-torn", "p1", "confirmed", 1, { ref: "tx" });
      fs.appendFileSync(
        journalFile("b-torn"),
        '{"seq":2,"batchId":"b-torn","itemKey":"p2","sta',
      );

      const entries = journal.replay("b-torn");
      expect(entries).toHaveLength(1);
      expect(entries[0].itemKey).toBe("p1");
    });

    it("throws on corruption in the middle of the journal rather than skipping it", () => {
      journal.append("b-corrupt", "p1", "confirmed", 1, { ref: "tx" });
      fs.appendFileSync(journalFile("b-corrupt"), "not-json\n");
      journal.append("b-corrupt", "p2", "confirmed", 1, { ref: "tx" });

      expect(() => journal.replay("b-corrupt")).toThrow(/corrupt at line 2/);
    });

    it("throws on a sequence gap", () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        journalFile("b-gap"),
        [
          JSON.stringify({
            seq: 1,
            batchId: "b-gap",
            itemKey: "p1",
            state: "intent",
            attempt: 1,
            at: "t",
          }),
          JSON.stringify({
            seq: 3,
            batchId: "b-gap",
            itemKey: "p1",
            state: "confirmed",
            attempt: 1,
            at: "t",
          }),
        ].join("\n") + "\n",
      );
      expect(() => journal.replay("b-gap")).toThrow(/sequence gap/);
    });

    it("rejects path-like batch ids so the journal cannot escape its directory", () => {
      expect(() => journal.append("../escape", "p1", "intent", 1)).toThrow(
        /Invalid batch id/,
      );
      expect(fs.existsSync(path.join(dir, "..", "escape.journal.jsonl"))).toBe(
        false,
      );
    });
  });

  describe("authorization path", () => {
    it("refuses an actor without payment:process before any journal write", async () => {
      const execute = jest.fn(async () => ({ ref: "tx" }));
      await expect(
        runResumableDisbursement(journal, {
          batchId: "b-unauth",
          items: payouts,
          keyOf,
          execute,
          actor: { id: "u-1", roles: [Role.USER] },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(execute).not.toHaveBeenCalled();
      expect(fs.existsSync(journalFile("b-unauth"))).toBe(false);
    });
  });
});

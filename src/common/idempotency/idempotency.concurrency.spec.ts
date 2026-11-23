import {
  duplicateSubmissions,
  expectSuccessCount,
  rejectionSummary,
  retryStorm,
  runConcurrently,
} from "src/testing/concurrency/concurrency-harness";
import { IdempotencyService, isUniqueViolation } from "./idempotency.service";
import {
  IdempotencyRecord,
  IdempotencyRecordStatus,
} from "./entities/idempotency-record.entity";

/*
 * Concurrency harness against the idempotency layer (#218): duplicate
 * submissions, in-flight retry storms, stale views and key-reuse races
 * around the `(scope, key)` claim that guards every idempotent write.
 *
 * The repository fake models the production contract the entity documents:
 * `(scope, idempotencyKey)` is unique (the second INSERT raises SQLSTATE
 * 23505), and every method crosses a real async boundary — the round trip
 * where concurrent flows interleave.
 */

const SCOPE = "POST:/payments:user-1";
const KEY = "payment-key-0001";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class RacingIdempotencyRepository {
  rows: IdempotencyRecord[] = [];

  create(partial: Partial<IdempotencyRecord>): IdempotencyRecord {
    return { ...partial } as IdempotencyRecord;
  }

  async save(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    await tick();
    const index = this.rows.findIndex(
      (row) =>
        row.scope === record.scope && row.idempotencyKey === record.idempotencyKey
    );
    if (index >= 0 && this.rows[index] !== record) {
      // A different row already owns the key: the unique index rejects the
      // INSERT, exactly as `UQ_idempotency_scope_key` does in production.
      const error = new Error(
        'duplicate key value violates unique constraint "UQ_idempotency_scope_key"'
      ) as Error & { code: string };
      error.code = "23505";
      throw error;
    }
    if (index >= 0) this.rows[index] = record;
    else this.rows.push(record);
    return record;
  }

  async findOne(options: {
    where: { scope: string; idempotencyKey: string };
  }): Promise<IdempotencyRecord | null> {
    await tick();
    const { scope, idempotencyKey } = options.where;
    return (
      this.rows.find(
        (row) => row.scope === scope && row.idempotencyKey === idempotencyKey
      ) ?? null
    );
  }

  async remove(
    record: IdempotencyRecord | IdempotencyRecord[]
  ): Promise<IdempotencyRecord | IdempotencyRecord[]> {
    await tick();
    const targets = Array.isArray(record) ? record : [record];
    this.rows = this.rows.filter((row) => !targets.includes(row));
    return record;
  }
}

function buildService() {
  const repo = new RacingIdempotencyRepository();
  const service = new IdempotencyService(repo as never);
  return { repo, service };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error("condition never became true");
}

const successfulHandler = () => ({
  statusCode: 201,
  body: { id: "payment-1" },
});

describe("IdempotencyService concurrency (harness)", () => {
  it("reclaims a failed key once when multiple clients retry together", async () => {
    const { service, repo } = buildService();
    const request = { key: KEY, scope: SCOPE, requestHash: "retry-body" };
    await expect(service.execute({
      ...request,
      handler: async () => { throw new Error("temporary failure"); },
    })).rejects.toThrow("temporary failure");

    const handler = jest.fn(async () => successfulHandler());
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.execute({ ...request, handler })),
    );
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(repo.rows).toHaveLength(1);
    const replay = await service.execute({ ...request, handler });
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(successfulHandler().body);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("executes the handler exactly once for concurrent duplicate submissions", async () => {
    const { repo, service } = buildService();
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls += 1;
      return successfulHandler();
    };

    const report = await duplicateSubmissions(5, () =>
      service.execute({ key: KEY, scope: SCOPE, requestHash: "hash-v1", handler })
    );

    expect(handlerCalls).toBe(1);
    expect(report.outcomes).toHaveLength(5);
    expect(repo.rows).toHaveLength(1);

    // Every loser sees the documented 409 — a raw unique-index 500 here is
    // the regression this suite exists to catch.
    for (const kind of rejectionSummary(report)) {
      expect(kind.status).toBe(409);
    }

    // Exactly one actor ran the handler; the rest are replays of its stored
    // response (or 409s, depending on when each loser re-read the row).
    const originals = report.successes.filter(
      (outcome) => outcome.value?.replayed === false
    );
    expect(originals).toHaveLength(1);
    for (const success of report.successes) {
      expect(success.value?.body).toEqual({ id: "payment-1" });
      expect(success.value?.statusCode).toBe(201);
    }
  });

  it("rejects a retry storm overlapping an in-flight request with 409s", async () => {
    const { repo, service } = buildService();
    let handlerCalls = 0;
    let releaseHandler: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const inFlight = service.execute({
      key: KEY,
      scope: SCOPE,
      requestHash: "hash-v1",
      handler: async () => {
        handlerCalls += 1;
        await gate;
        return successfulHandler();
      },
    });
    await waitFor(
      () => repo.rows[0]?.status === IdempotencyRecordStatus.IN_PROGRESS
    );

    const storm = await retryStorm(4, () =>
      service.execute({ key: KEY, scope: SCOPE, requestHash: "hash-v1", handler: async () => successfulHandler() })
    );

    expect(handlerCalls).toBe(1);
    expect(storm.successes).toHaveLength(0);
    expect(storm.rejections).toHaveLength(4);
    for (const kind of rejectionSummary(storm)) {
      expect(kind.status).toBe(409);
      expect(kind.message).toContain("already in progress");
    }

    releaseHandler();
    const first = await inFlight;
    expect(first.replayed).toBe(false);
    expect(first.body).toEqual({ id: "payment-1" });
    expect(handlerCalls).toBe(1);
  });

  it("corrects a stale in-progress view: the next retry replays instead of re-running", async () => {
    const { repo, service } = buildService();
    let handlerCalls = 0;
    let releaseHandler: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const inFlight = service.execute({
      key: KEY,
      scope: SCOPE,
      requestHash: "hash-v1",
      handler: async () => {
        handlerCalls += 1;
        await gate;
        return successfulHandler();
      },
    });
    await waitFor(
      () => repo.rows[0]?.status === IdempotencyRecordStatus.IN_PROGRESS
    );
    // The client's snapshot: taken while the request was still running.
    const staleSnapshot = { ...repo.rows[0] };

    releaseHandler();
    await inFlight;
    expect(staleSnapshot.status).toBe(IdempotencyRecordStatus.IN_PROGRESS);

    // Acting on the stale belief would double-charge; the service re-reads
    // current state and replays the stored response instead.
    const retry = await service.execute({
      key: KEY,
      scope: SCOPE,
      requestHash: "hash-v1",
      handler: async () => {
        handlerCalls += 1;
        return successfulHandler();
      },
    });

    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual({ id: "payment-1" });
    expect(handlerCalls).toBe(1);
  });

  it("rejects a concurrent key reuse with a different payload while the winner completes once", async () => {
    const { service } = buildService();
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls += 1;
      return successfulHandler();
    };

    const report = await runConcurrently(["payload-a", "payload-b"], (_actor, index) =>
      service.execute({
        key: KEY,
        scope: SCOPE,
        requestHash: index === 0 ? "hash-v1" : "hash-v2",
        handler,
      })
    );

    expect(handlerCalls).toBe(1);
    expectSuccessCount(report, 1);
    const kinds = rejectionSummary(report);
    expect(kinds).toHaveLength(1);
    expect(kinds[0]).toMatchObject({
      status: 409,
      message: "Idempotency-Key was already used for a different request payload",
    });
  });

  it("treats only SQLSTATE 23505-shaped failures as unique violations", () => {
    const codeError = Object.assign(new Error("insert failed"), {
      code: "23505",
    });
    expect(isUniqueViolation(codeError)).toBe(true);
    expect(isUniqueViolation({ driverError: { code: "23505" } })).toBe(true);
    expect(
      isUniqueViolation(
        new Error('duplicate key value violates unique constraint "uq"')
      )
    ).toBe(true);
    expect(isUniqueViolation(new Error("connection reset"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });

  describe("Authorization & Failure Paths", () => {
    it("strictly isolates identical idempotency keys across different actors (scope authorization)", async () => {
      const { service, repo } = buildService();
      let aliceCalls = 0;
      let bobCalls = 0;

      const report = await runConcurrently(["user-alice", "user-bob"], async (actor) => {
        if (actor === "user-alice") {
          return service.execute({
            key: "shared-key-123",
            scope: "POST:/transfers:user-alice",
            requestHash: "hash-alice",
            handler: async () => {
              aliceCalls += 1;
              return { statusCode: 200, body: { txId: "tx-alice" } };
            },
          });
        } else {
          return service.execute({
            key: "shared-key-123",
            scope: "POST:/transfers:user-bob",
            requestHash: "hash-bob",
            handler: async () => {
              bobCalls += 1;
              return { statusCode: 200, body: { txId: "tx-bob" } };
            },
          });
        }
      });

      expectSuccessCount(report, 2);
      expect(aliceCalls).toBe(1);
      expect(bobCalls).toBe(1);
      expect(repo.rows).toHaveLength(2);

      const aliceSuccess = report.successes.find((s) => s.actor === "user-alice");
      const bobSuccess = report.successes.find((s) => s.actor === "user-bob");
      expect(aliceSuccess?.value?.body).toEqual({ txId: "tx-alice" });
      expect(bobSuccess?.value?.body).toEqual({ txId: "tx-bob" });
    });

    it("marks the record failed so subsequent retries can reclaim it", async () => {
      const { service, repo } = buildService();
      let attempts = 0;

      const failingHandler = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Downstream gateway timeout");
        return { statusCode: 200, body: { recovered: true } };
      };

      // First execution fails
      await expect(
        service.execute({
          key: "fail-retry-key",
          scope: SCOPE,
          requestHash: "hash-fail",
          handler: failingHandler,
        }),
      ).rejects.toThrow("Downstream gateway timeout");

      expect(repo.rows).toHaveLength(1);
      expect(repo.rows[0].status).toBe(IdempotencyRecordStatus.FAILED);

      // Retry execution now succeeds
      const retryResult = await service.execute({
        key: "fail-retry-key",
        scope: SCOPE,
        requestHash: "hash-fail",
        handler: failingHandler,
      });

      expect(retryResult.body).toEqual({ recovered: true });
      expect(retryResult.replayed).toBe(false);
      expect(attempts).toBe(2);
    });
  });

  describe("response write fails after the handler succeeded (#563)", () => {
    // The COMPLETED update never reaches the database, so the stored row keeps
    // its IN_PROGRESS claim, as a dropped connection would leave it.
    class LostCompletionRepository extends RacingIdempotencyRepository {
      failCompletion = true;

      async save(record: IdempotencyRecord): Promise<IdempotencyRecord> {
        if (
          this.failCompletion &&
          record.status === IdempotencyRecordStatus.COMPLETED
        ) {
          await tick();
          record.status = IdempotencyRecordStatus.IN_PROGRESS;
          throw new Error("connection reset while storing the response");
        }
        return super.save(record);
      }
    }

    function buildLossyService() {
      const repo = new LostCompletionRepository();
      return { repo, service: new IdempotencyService(repo as never) };
    }

    const request = { key: KEY, scope: SCOPE, requestHash: "hash-v1" };

    it("failure path: serves the original caller and keeps the claim in progress", async () => {
      const { repo, service } = buildLossyService();
      const handler = jest.fn(async () => successfulHandler());

      const first = await service.execute({ ...request, handler });

      expect(first).toEqual({
        replayed: false,
        statusCode: 201,
        body: { id: "payment-1" },
        key: KEY,
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(repo.rows).toHaveLength(1);
      expect(repo.rows[0].status).toBe(IdempotencyRecordStatus.IN_PROGRESS);
    });

    it("retry path: duplicate submissions get 409 instead of re-running the side effect", async () => {
      const { service } = buildLossyService();
      const handler = jest.fn(async () => successfulHandler());
      await service.execute({ ...request, handler });

      const storm = await retryStorm(4, () =>
        service.execute({ ...request, handler }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(storm.successes).toHaveLength(0);
      expect(storm.rejections).toHaveLength(4);
      for (const kind of rejectionSummary(storm)) {
        expect(kind.status).toBe(409);
        expect(kind.message).toContain("already in progress");
      }
    });

    it("normal path after recovery: once the claim expires one duplicate reclaims it and the rest replay", async () => {
      const { repo, service } = buildLossyService();
      const handler = jest.fn(async () => successfulHandler());
      await service.execute({ ...request, handler });

      repo.failCompletion = false;
      repo.rows[0].expiresAt = new Date(Date.now() - 1000);

      const report = await duplicateSubmissions(3, () =>
        service.execute({ ...request, handler }),
      );

      expect(handler).toHaveBeenCalledTimes(2);
      expect(
        report.successes.filter((outcome) => outcome.value?.replayed === false),
      ).toHaveLength(1);
      for (const kind of rejectionSummary(report)) {
        expect(kind.status).toBe(409);
      }

      const replay = await service.execute({ ...request, handler });
      expect(replay.replayed).toBe(true);
      expect(replay.body).toEqual({ id: "payment-1" });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("authorization path: a stuck claim does not block or leak into another actor's scope", async () => {
      const { repo, service } = buildLossyService();
      await service.execute({
        ...request,
        handler: async () => successfulHandler(),
      });
      repo.failCompletion = false;

      const bobHandler = jest.fn(async () => ({
        statusCode: 201,
        body: { id: "payment-bob" },
      }));
      const bob = await service.execute({
        ...request,
        scope: "POST:/payments:user-2",
        handler: bobHandler,
      });

      expect(bob.replayed).toBe(false);
      expect(bob.body).toEqual({ id: "payment-bob" });
      expect(bobHandler).toHaveBeenCalledTimes(1);
      expect(repo.rows[0].status).toBe(IdempotencyRecordStatus.IN_PROGRESS);
    });
  });
});

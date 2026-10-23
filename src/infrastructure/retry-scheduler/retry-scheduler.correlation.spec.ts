import { Logger } from "@nestjs/common";
import { RetrySchedulerService } from "./retry-scheduler.service";
import { RetryOperationStatus } from "./entities/retry-operation.entity";
import { runWithCorrelation } from "../../common/correlation/correlation-context";

/**
 * Retry records keep the scheduling request's correlation ID across attempts
 * (#270), and the failure causes they expose are redacted (#271).
 */
describe("RetrySchedulerService correlation and redaction", () => {
  let store: Map<string, any>;
  let emitter: { emit: jest.Mock };
  let service: RetrySchedulerService;

  beforeEach(() => {
    store = new Map();
    const repo = {
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => {
        store.set(value.operationId, { ...value });
        return { ...value };
      }),
      findOne: jest.fn(async ({ where }) =>
        store.has(where.operationId) ? { ...store.get(where.operationId) } : null,
      ),
    };
    emitter = { emit: jest.fn() };
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    service = new RetrySchedulerService(repo as any, emitter as any);
  });

  afterEach(() => jest.restoreAllMocks());

  const schedule = (extra: Record<string, unknown> = {}) =>
    service.schedule({
      operationType: "payment.settle",
      operationId: "op-1",
      payload: {},
      maxAttempts: 2,
      ...extra,
    });

  it("normal path: inherits the scheduling request's ID", async () => {
    const op = await runWithCorrelation("settle-request", () => schedule());
    expect(op.correlationId).toBe("settle-request");
  });

  it("keeps a valid explicit ID and ignores a forged one", async () => {
    expect((await runWithCorrelation("ambient", () => schedule({ correlationId: "explicit" }))).correlationId).toBe("explicit");
    expect((await runWithCorrelation("ambient", () => schedule({ correlationId: "<script>" }))).correlationId).toBe("ambient");
    expect((await schedule({ correlationId: "<script>" })).correlationId).toBeNull();
  });

  it("retry path: attempts processed outside the request keep and report the original ID", async () => {
    await runWithCorrelation("settle-request", () => schedule());

    // The retry worker runs later, outside any request context.
    const failed = await service.markFailed("op-1", "Horizon 503", true);
    expect(failed.status).toBe(RetryOperationStatus.PENDING);
    expect(emitter.emit).toHaveBeenCalledWith(
      "retry.failed",
      expect.objectContaining({ correlationId: "settle-request" }),
    );

    const dead = await service.markFailed("op-1", "Horizon 503", true);
    expect(dead.status).toBe(RetryOperationStatus.DEAD_LETTER);
    expect(dead.correlationId).toBe("settle-request");
    expect(emitter.emit).toHaveBeenCalledWith(
      "retry.dead_letter",
      expect.objectContaining({ correlationId: "settle-request" }),
    );
  });

  it("failure path: lastError and emitted events never carry the raw secret", async () => {
    await schedule();
    const seed = "S" + "A".repeat(55);
    const raw = `signing failed for seed ${seed} at https://ops:pa55word@horizon.internal/tx`;
    const op = await service.markFailed("op-1", raw, true);

    expect(op.lastError).not.toContain(seed);
    expect(op.lastError).not.toContain("pa55word");
    expect(op.lastError).toContain("horizon.internal");
    const [, event] = emitter.emit.mock.calls.find(([name]) => name === "retry.failed");
    expect(JSON.stringify(event)).not.toContain(seed);
  });
});

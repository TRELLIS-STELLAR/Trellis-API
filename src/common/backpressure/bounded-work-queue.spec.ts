import { ForbiddenException, RateLimitException } from "../errors/app.exception";
import { Permission, Role } from "../guard/roles.enum";
import { BoundedWorkQueue, QueueActor } from "./bounded-work-queue";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const maintainer = (id: string): QueueActor => ({ id, roles: [Role.MAINTAINER] });
const user: QueueActor = { id: "user-1", roles: [Role.USER] };

function makeQueue(overrides: Partial<ConstructorParameters<typeof BoundedWorkQueue>[0]> = {}) {
  return new BoundedWorkQueue({
    name: "export",
    permission: Permission.SYSTEM_MAINTENANCE,
    maxConcurrent: 1,
    maxQueued: 2,
    sleep: async () => undefined,
    ...overrides,
  });
}

describe("BoundedWorkQueue (#263)", () => {
  it("runs work immediately when a slot is free", async () => {
    const queue = makeQueue();
    await expect(queue.submit(maintainer("a"), async () => "done")).resolves.toBe("done");
    expect(queue.stats()).toMatchObject({ running: 0, queued: 0, completed: 1, rejected: 0 });
  });

  it("never exceeds maxConcurrent and drains waiting work in FIFO order", async () => {
    const queue = makeQueue({ maxConcurrent: 2, maxQueued: 3 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    let active = 0;
    let peak = 0;

    const results = gates.map((gate, index) =>
      queue.submit(maintainer("a"), async () => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return index;
      }),
    );

    expect(started).toEqual([0, 1]);
    expect(queue.stats()).toMatchObject({ running: 2, queued: 2 });

    gates[0].resolve();
    await results[0];
    expect(started).toEqual([0, 1, 2]);
    gates[1].resolve();
    await results[1];
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2].resolve();
    gates[3].resolve();

    await expect(Promise.all(results)).resolves.toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    await queue.idle();
    expect(queue.stats()).toMatchObject({ running: 0, queued: 0, completed: 4 });
  });

  it("rejects with 429 and Retry-After once the waiting room is full", async () => {
    const queue = makeQueue({ maxQueued: 1, retryAfterSeconds: 7 });
    const gate = deferred();
    const running = queue.submit(maintainer("a"), () => gate.promise);
    const waiting = queue.submit(maintainer("b"), async () => "waited");

    const overflow = queue.submit(maintainer("c"), async () => "never");
    await expect(overflow).rejects.toBeInstanceOf(RateLimitException);
    await expect(overflow).rejects.toMatchObject({ retryAfterSeconds: 7 });
    expect(queue.stats()).toMatchObject({ running: 1, queued: 1, rejected: 1 });

    gate.resolve();
    await running;
    await expect(waiting).resolves.toBe("waited");
  });

  it("caps how many waiting slots one actor can hold", async () => {
    const queue = makeQueue({ maxQueued: 3, maxQueuedPerActor: 1 });
    const gate = deferred();
    const running = queue.submit(maintainer("a"), () => gate.promise);
    const first = queue.submit(maintainer("greedy"), async () => 1);

    await expect(queue.submit(maintainer("greedy"), async () => 2)).rejects.toBeInstanceOf(
      RateLimitException,
    );
    const other = queue.submit(maintainer("polite"), async () => 3);

    gate.resolve();
    await running;
    await expect(first).resolves.toBe(1);
    await expect(other).resolves.toBe(3);
  });

  it("rejects callers without the queue permission before touching capacity", async () => {
    const queue = makeQueue();
    const task = jest.fn();
    await expect(queue.submit(user, task)).rejects.toBeInstanceOf(ForbiddenException);
    expect(task).not.toHaveBeenCalled();
    expect(queue.stats()).toMatchObject({ running: 0, queued: 0, rejected: 0 });
  });

  it("retries retryable failures with exponential backoff and then succeeds", async () => {
    const delays: number[] = [];
    const queue = makeQueue({
      maxAttempts: 3,
      retryDelayMs: 10,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const attempts: number[] = [];

    const result = await queue.submit(maintainer("a"), async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error("transient");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempts).toEqual([1, 2, 3]);
    expect(delays).toEqual([10, 20]);
    expect(queue.stats()).toMatchObject({ completed: 1, failed: 0 });
  });

  it("surfaces the last error after exhausting attempts and still frees the slot", async () => {
    const queue = makeQueue({ maxAttempts: 2 });
    await expect(
      queue.submit(maintainer("a"), async () => {
        throw new Error("permanent");
      }),
    ).rejects.toThrow("permanent");
    expect(queue.stats()).toMatchObject({ running: 0, failed: 1 });
    await expect(queue.submit(maintainer("a"), async () => "next")).resolves.toBe("next");
  });

  it("does not retry errors the predicate marks non-retryable", async () => {
    const queue = makeQueue({ maxAttempts: 5, isRetryable: (e) => !(e instanceof TypeError) });
    const task = jest.fn().mockRejectedValue(new TypeError("bad input"));
    await expect(queue.submit(maintainer("a"), task)).rejects.toThrow("bad input");
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("a failing task does not block queued work", async () => {
    const queue = makeQueue();
    const gate = deferred();
    const failing = queue.submit(maintainer("a"), async () => {
      await gate.promise;
      throw new Error("boom");
    });
    const next = queue.submit(maintainer("a"), async () => "after");
    gate.resolve();
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("after");
  });

  it("validates its configuration", () => {
    expect(() => makeQueue({ maxConcurrent: 0 })).toThrow(RangeError);
    expect(() => makeQueue({ maxQueued: -1 })).toThrow(RangeError);
  });
});

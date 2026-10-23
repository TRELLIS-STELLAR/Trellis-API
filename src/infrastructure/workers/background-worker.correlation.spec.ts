import { Logger } from "@nestjs/common";
import { BackgroundWorkerService } from "./background-worker.service";
import { JobStatus } from "./worker.interface";
import {
  JOB_CORRELATION_FIELD,
  runWithCorrelation,
} from "../../common/correlation/correlation-context";

/**
 * Worker-side correlation (#270) and redaction of stored job errors (#271).
 */
describe("BackgroundWorkerService correlation and redaction", () => {
  let service: BackgroundWorkerService;
  let queue: any;
  let listeners: Record<string, (...args: any[]) => void>;

  beforeEach(() => {
    listeners = {};
    queue = {
      add: jest.fn().mockResolvedValue({ id: "bull-1" }),
      on: jest.fn((event: string, handler: (...args: any[]) => void) => {
        listeners[event] = handler;
      }),
    };
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    service = new BackgroundWorkerService(queue);
    service.onModuleInit();
  });

  afterEach(() => jest.restoreAllMocks());

  const queuedData = (call = 0) => queue.add.mock.calls[call][1];

  it("normal path: stamps the enqueuing request's ID on the record and the queued payload", async () => {
    const job = await runWithCorrelation("request-42", () =>
      service.enqueue({ type: "email.send", payload: { to: "user" } }),
    );
    expect(job.correlationId).toBe("request-42");
    expect(queuedData()[JOB_CORRELATION_FIELD]).toBe("request-42");
  });

  it("an explicit valid ID wins over the ambient one", async () => {
    const job = await runWithCorrelation("request-42", () =>
      service.enqueue({ type: "email.send", payload: {}, correlationId: "explicit-1" }),
    );
    expect(job.correlationId).toBe("explicit-1");
    expect(queuedData()[JOB_CORRELATION_FIELD]).toBe("explicit-1");
  });

  it("an invalid explicit ID is not trusted", async () => {
    const job = await runWithCorrelation("request-42", () =>
      service.enqueue({ type: "email.send", payload: {}, correlationId: "bad\r\nid" }),
    );
    expect(job.correlationId).toBe("request-42");
  });

  it("enqueues without a stamp outside any request (scheduled/cron work)", async () => {
    const job = await service.enqueue({ type: "email.send", payload: {} });
    expect(job.correlationId).toBeUndefined();
    expect(queuedData()).not.toHaveProperty(JOB_CORRELATION_FIELD);
  });

  it("retry path: a manual retry keeps the ORIGINAL ID, not the operator's request ID", async () => {
    const job = await runWithCorrelation("original-request", () =>
      service.enqueue({ type: "email.send", payload: {} }),
    );
    listeners.failed({ id: job.id, attemptsMade: 3 }, new Error("SMTP down"));
    expect((await service.getJob(job.id)).status).toBe(JobStatus.DEAD_LETTER);

    await runWithCorrelation("operator-request", () => service.retryJob(job.id));
    expect(queuedData(1)[JOB_CORRELATION_FIELD]).toBe("original-request");
    expect(queuedData(1)._retry).toBe(true);
  });

  it("failure path: the stored job error is redacted before inspection endpoints serve it", async () => {
    const job = await service.enqueue({ type: "email.send", payload: {} });
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXBhcnQ";
    listeners.failed(
      { id: job.id, attemptsMade: 1 },
      new Error(`SMTP auth failed for smtp://mailer:hunter2@mail.example.com with ${jwt}`),
    );
    const stored = await service.getJob(job.id);
    expect(stored.status).toBe(JobStatus.FAILED);
    expect(stored.error).not.toContain("hunter2");
    expect(stored.error).not.toContain(jwt);
    expect(stored.error).toContain("mail.example.com");
  });
});

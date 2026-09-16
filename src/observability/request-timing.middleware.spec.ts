import {
  httpRequestTotal,
  httpRequestDuration,
  httpRequestsInProgress,
  errorTotal,
  register,
} from "../config/metrics";
import { RequestTimingMiddleware } from "./request-timing.middleware";

jest.mock("../config/tracing", () => ({
  createSpan: (
    _name: string,
    fn: (span: {
      setAttribute: jest.Mock;
      setStatus: jest.Mock;
      addEvent: jest.Mock;
    }) => void,
  ) =>
    fn({
      setAttribute: jest.fn(),
      setStatus: jest.fn(),
      addEvent: jest.fn(),
    }),
}));

/** Resolve the registry text – `register.metrics()` returns a Promise in
 *  prom-client v15, so we centralise the await. */
async function metrics(): Promise<string> {
  return register.metrics();
}

/** Run every `finish`/`close` callback the middleware has registered on res. */
function flushRes(res: { on: jest.Mock }): void {
  for (const [event, cb] of res.on.mock.calls) {
    if (event === "finish" || event === "close") cb();
  }
}

function sampleCount(body: string): number {
  return body
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#")).length;
}

describe("RequestTimingMiddleware Prometheus integration (issue #25)", () => {
  let middleware: RequestTimingMiddleware;

  beforeEach(() => {
    middleware = new RequestTimingMiddleware();
    httpRequestTotal.reset();
    httpRequestDuration.reset();
    httpRequestsInProgress.reset();
    errorTotal.reset();
  });

  it("uses the matched Express route pattern as a metric label", async () => {
    const onMock = jest.fn();
    const req: any = {
      method: "GET",
      path: "/api/v1/portfolio/0xabc12345abc12345abc12345abc12345abc12345",
      baseUrl: "/api/v1",
      route: { path: "/portfolio/:address" },
      headers: {},
    };
    const res: any = { statusCode: 200, on: onMock };

    middleware.use(req, res, () => undefined);
    flushRes(res);

    const body = await metrics();
    // The route pattern should appear in the counter labels, NOT the raw
    // address – otherwise cardinality grows unboundedly.
    expect(body).toMatch(
      /trellis_http_requests_total\{[^}]*route="\/api\/v1\/portfolio\/:address"[^}]*\}/,
    );
    expect(body).not.toContain("0xabc12345");
  });

  it("increments http_request_total once per finished request", async () => {
    const onMock = jest.fn();
    const req: any = {
      method: "POST",
      path: "/api/v1/auth/login",
      baseUrl: "/api/v1",
      route: { path: "/auth/login" },
      headers: {},
    };
    const res: any = { statusCode: 201, on: onMock };

    const before = sampleCount(await metrics());
    middleware.use(req, res, () => undefined);
    flushRes(res);
    const after = sampleCount(await metrics());

    expect(after).toBeGreaterThan(before);
  });

  it("records http errors via errorTotal (severity = high for 5xx, low for 4xx)", async () => {
    for (const status of [404, 500]) {
      const onMock = jest.fn();
      const req: any = {
        method: "GET",
        path: "/api/v1/foo",
        baseUrl: "",
        route: undefined, // simulate unmatched route
        headers: {},
      };
      const res: any = { statusCode: status, on: onMock };
      middleware.use(req, res, () => undefined);
      flushRes(res);
    }

    const body = await metrics();
    expect(body).toMatch(
      /trellis_errors_total\{[^}]*severity="low"[^}]*\}/,
    );
    expect(body).toMatch(
      /trellis_errors_total\{[^}]*severity="high"[^}]*\}/,
    );
  });

  it("emits a histogram TYPE line for http_request_duration_seconds", async () => {
    const onMock = jest.fn();
    const req: any = {
      method: "GET",
      path: "/" + "a".repeat(8) + "/" + "b".repeat(8),
      baseUrl: "",
      route: undefined,
      headers: {},
    };
    const res: any = { statusCode: 200, on: onMock };

    middleware.use(req, res, () => undefined);
    flushRes(res);

    const body = await metrics();
    expect(body).toContain(
      "# TYPE trellis_http_request_duration_seconds histogram",
    );
  });

  it("collapses 404 paths with no matched route into a single 'unmatched' bucket", async () => {
    const bucketsSeen = new Set<string>();
    for (const path of ["/api/v1/a", "/api/v1/b/c", "/api/v1/d/e/f"]) {
      const onMock = jest.fn();
      const req: any = {
        method: "GET",
        path,
        baseUrl: "",
        route: undefined,
        headers: {},
      };
      const res: any = { statusCode: 404, on: onMock };
      middleware.use(req, res, () => undefined);
      flushRes(res);

      const body = await metrics();
      // Accept either label ordering from prom-client output.
      const match = body.match(
        /http_requests_total\{[^}]*?(?:route="(\S+)"[^}]*?status_code="404"|status_code="404"[^}]*?route="(\S+)")[^}]*?\}/,
      );
      const bucket = match?.[1] ?? match?.[2];
      if (bucket) bucketsSeen.add(bucket);
    }

    expect(bucketsSeen).toEqual(new Set(["unmatched"]));
  });

  it("does not leak the in-progress gauge when the response is closed without finishing", async () => {
    const onMock = jest.fn();
    const req: any = {
      method: "GET",
      path: "/api/v1/x",
      baseUrl: "",
      route: undefined,
      headers: {},
    };
    const res: any = { statusCode: 200, on: onMock };

    middleware.use(req, res, () => undefined);
    // Only `close` fires (client disconnect); `finish` never runs.
    for (const [event, cb] of onMock.mock.calls) {
      if (event === "close") cb();
    }

    // After a single close-only event, the in-progress gauge should be at
    // zero (or absent) for our method+route labels. We assert by reading the
    // gauge value directly instead of regex-matching the exposition body
    // because prom-client emits labels alphabetically, not in insertion order.
    const labelsSeen = (await httpRequestsInProgress.get()).values;
    const remaining = labelsSeen
      .filter((v) => v.labels?.method === "GET")
      .reduce((acc: number, v: any) => acc + (v.value ?? 0), 0);
    expect(remaining).toBe(0);
  });
});

import { Writable } from "stream";
import * as winston from "winston";
import { ArgumentsHost, HttpStatus, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as Sentry from "@sentry/node";
import { LoggerService } from "./logger.service";
import {
  REDACTED,
  formatError,
  redactSecretValues,
  sanitizeErrorMessage,
  sanitizeQuery,
  sanitizeUrl,
} from "./sanitize.util";
import { GlobalExceptionFilter } from "../common/filters/global-exception.filter";
import { PrivacyExportAuthorizer } from "../infrastructure/export/privacy-export-authorizer";
import { ExportService } from "../infrastructure/export/export.service";
import { ExportStatus } from "../infrastructure/export/entities/data-export.entity";
import { runWithCorrelation } from "../common/correlation/correlation-context";

/**
 * Redaction across the three places a secret can escape (#271): log sinks,
 * data exports and error responses. Every surface is checked against the same
 * corpus, so a new secret shape is added once and tested everywhere.
 */

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const STELLAR_SECRET = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";
const SECRETS = {
  jwt: JWT,
  bearer: "opaque-bearer-token-123",
  basic: "dXNlcjpodW50ZXIy",
  stellarSecret: STELLAR_SECRET,
  urlPassword: "db-pa55word",
  inlinePassword: "inline-hunter2",
  pem: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
};
const SECRET_TEXT = [
  `token ${SECRETS.jwt}`,
  `Authorization: Bearer ${SECRETS.bearer}`,
  `Authorization: Basic ${SECRETS.basic}`,
  `seed ${SECRETS.stellarSecret}`,
  `postgres://trellis:${SECRETS.urlPassword}@db.internal:5432/app`,
  `password=${SECRETS.inlinePassword}`,
  `-----BEGIN PRIVATE KEY-----\n${SECRETS.pem}\n-----END PRIVATE KEY-----`,
].join(" | ");

/** Values that must stay visible: redaction must not destroy debuggability. */
const PUBLIC_VALUES = {
  account: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
  contract: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
  host: "db.internal",
};

function expectNoSecrets(output: unknown) {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  for (const [name, secret] of Object.entries(SECRETS))
    expect({ name, leaked: text.includes(secret) }).toEqual({ name, leaked: false });
}

describe("redaction across logs, exports and error responses (#271)", () => {
  describe("shared redactor", () => {
    it("removes every secret shape in the corpus", () => {
      const out = redactSecretValues(SECRET_TEXT);
      expectNoSecrets(out);
      expect(out).toContain(REDACTED);
      expect(out).toContain(PUBLIC_VALUES.host);
    });

    it("keeps public Stellar identifiers, transaction hashes and ordinary prose", () => {
      const txHash = "a".repeat(64);
      const text = `account ${PUBLIC_VALUES.account} contract ${PUBLIC_VALUES.contract} tx ${txHash} on the Basic plan`;
      expect(redactSecretValues(text)).toBe(text);
    });

    it("error messages additionally drop long hex blobs (possible raw keys)", () => {
      expect(sanitizeErrorMessage(`key 0x${"b".repeat(64)}`)).not.toContain("b".repeat(64));
    });
  });

  describe("logs", () => {
    function capture() {
      const records: any[] = [];
      const service = new LoggerService({ level: "verbose" });
      service.winstonLogger.clear();
      service.winstonLogger.silent = false;
      service.winstonLogger.format = winston.format.json();
      service.winstonLogger.add(
        new winston.transports.Stream({
          stream: new Writable({
            write(chunk, _enc, cb) {
              records.push(JSON.parse(chunk.toString()));
              cb();
            },
          }),
        }),
      );
      return { service, records };
    }

    it("normal path: message text and metadata are both redacted", () => {
      const { service, records } = capture();
      service.info({ message: `login ${SECRET_TEXT}`, context: "Auth", detail: SECRET_TEXT, password: "x" });
      expect(records).toHaveLength(1);
      expectNoSecrets(records[0]);
      expect(records[0].password).toBe(REDACTED);
    });

    it("failure path: logError redacts the message, the formatted error and its stack", () => {
      const { service, records } = capture();
      const error = new Error(`upstream rejected ${SECRET_TEXT}`);
      service.logError(error, "Payments");
      expectNoSecrets(records[0]);
      expectNoSecrets(formatError(error, true));
    });

    it("lines written inside a request carry its correlation ID", () => {
      const { service, records } = capture();
      runWithCorrelation("log-request-1", () => service.warn("slow dependency"));
      expect(records[0].correlationId).toBe("log-request-1");
    });

    it("request URLs and query strings are redacted before logging", () => {
      const url = `/api/v1/auth/callback?code=oauth-code-1&token=${SECRETS.bearer}&page=2&next=https://u:${SECRETS.urlPassword}@x.io`;
      const out = sanitizeUrl(url);
      expectNoSecrets(out);
      expect(out).not.toContain("oauth-code-1");
      expect(out).toContain("page=2");
      expect(sanitizeQuery({ api_key: "k1", "access-token": "t1", page: "2" })).toEqual({
        api_key: REDACTED,
        "access-token": REDACTED,
        page: "2",
      });
    });
  });

  describe("exports", () => {
    const authorizer = new PrivacyExportAuthorizer();
    const record = {
      id: "row-1",
      apiKey: "sk_live_123",
      email: "alice@example.com",
      balance: 1200,
      account: PUBLIC_VALUES.account,
      note: `rotate soon: ${SECRET_TEXT}`,
      nested: [{ memo: `seed ${STELLAR_SECRET}`, txHash: "c".repeat(64) }],
    };

    it("normal path: owner export keeps business data but no secret values", () => {
      const out = authorizer.filterRecord(record, { role: "user", isOwner: true });
      expectNoSecrets(out);
      expect(out).not.toHaveProperty("apiKey");
      expect(out.balance).toBe(1200);
      expect(out.account).toBe(PUBLIC_VALUES.account);
    });

    it("authorization path: a non-owner gets masked PII and confidential financials", () => {
      const out = authorizer.filterRecord(record, { role: "user", isOwner: false });
      expectNoSecrets(out);
      expect(out.email).toBe("a***e@example.com");
      expect(out.balance).toBe("[CONFIDENTIAL]");
    });

    it("authorization path: even admins never receive secrets", () => {
      expectNoSecrets(authorizer.filterRecord(record, { role: "admin", isOwner: false }));
    });

    it("failure/retry path: a failed export stores and logs only a redacted reason", async () => {
      const stored: any = { id: "exp-1", scope: "user_data", format: "json", schemaVersion: "1.0.0" };
      const repo = {
        findOne: jest.fn(async () => stored),
        save: jest.fn(async (value) => Object.assign(stored, value)),
      };
      const errors = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const service = new ExportService(repo as any, authorizer);
      jest
        .spyOn(service as any, "extractData")
        .mockRejectedValue(new Error(`object store denied ${SECRET_TEXT}`));

      // A retry of the same export must not leak on the second failure either.
      await service.processExport("exp-1");
      await service.processExport("exp-1");

      expect(stored.status).toBe(ExportStatus.FAILED);
      expectNoSecrets(stored.error);
      errors.mock.calls.forEach((call) => expectNoSecrets(call));
      errors.mockRestore();
    });
  });

  describe("error responses", () => {
    function run(exception: unknown, url: string, nodeEnv: string) {
      const response: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
      };
      const request = {
        url,
        path: url.split("?")[0],
        method: "POST",
        headers: { authorization: `Bearer ${SECRETS.bearer}` },
        query: { token: SECRETS.bearer, page: "1" },
        params: {},
        ip: "127.0.0.1",
      };
      const host = {
        switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
      } as unknown as ArgumentsHost;
      const logged = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      new GlobalExceptionFilter({
        get: (key: string) => (key === "NODE_ENV" ? nodeEnv : undefined),
      } as unknown as ConfigService).catch(exception, host);
      const result = { body: response.json.mock.calls[0][0], logs: logged.mock.calls };
      logged.mockRestore();
      return result;
    }

    const url = `/api/v1/payments?token=${SECRETS.bearer}&page=1`;

    it.each(["production", "development"])(
      "failure path (%s): a 500 body and its server log carry no secret",
      (env) => {
        const { body, logs } = run(new Error(`driver failed ${SECRET_TEXT}`), url, env);
        expect(body.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expectNoSecrets(body);
        expectNoSecrets(logs);
      },
    );

    it.each(["production", "development"])(
      "authorization path (%s): a 401 that echoes the credential is redacted",
      (env) => {
        const { body, logs } = run(
          new UnauthorizedException(`invalid token ${SECRETS.jwt}`),
          url,
          env,
        );
        expect(body.statusCode).toBe(HttpStatus.UNAUTHORIZED);
        expectNoSecrets(body);
        expectNoSecrets(logs);
        expect(body.path).toBe(`/api/v1/payments?token=${REDACTED}&page=1`);
      },
    );

    it("retry path: the same failure redacts identically on every attempt", () => {
      const first = run(new Error(`timeout ${SECRET_TEXT}`), url, "development").body;
      const second = run(new Error(`timeout ${SECRET_TEXT}`), url, "development").body;
      expect(second.message).toBe(first.message);
      expectNoSecrets(second);
    });

    it("Sentry extras are redacted when error reporting is enabled", () => {
      const scope = { setTag: jest.fn(), setExtra: jest.fn(), setUser: jest.fn(), setLevel: jest.fn() };
      jest.spyOn(Sentry, "getCurrentHub").mockReturnValue({ getClient: () => ({}) } as any);
      jest.spyOn(Sentry, "withScope").mockImplementation((cb: any) => cb(scope));
      jest.spyOn(Sentry, "captureException").mockImplementation(() => "id");
      run(new Error("boom"), url, "production");
      expect(scope.setExtra).toHaveBeenCalledWith("query", expect.anything());
      expectNoSecrets(scope.setExtra.mock.calls);
      jest.restoreAllMocks();
    });
  });
});

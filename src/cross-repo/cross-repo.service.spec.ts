/**
 * Behavioural tests for cross-repo API request validation (issue #353).
 *
 * Covers the four required paths: normal, failure, retry and authorization.
 */

import { ConfigService } from "@nestjs/config";
import { CrossRepoRequestValidationService } from "./cross-repo.service";
import { CrossRepoContractSchema } from "./cross-repo.types";
import {
  ContractSchemaUnavailableError,
  CrossRepoContractSchemaRegistry,
  CrossRepoSchemaProvider,
} from "./cross-repo.schema-registry";
import {
  buildCrossRepoSigningPayload,
  signCrossRepoPayload,
} from "./cross-repo.signing";

const FRONTEND_SECRET = "cross-repo-frontend-dev-secret";

function validEnvelope(
  overrides: Record<string, unknown> = {},
): any {
  const { signature, ...rest } = overrides;
  const envelope: any = {
    clientId: "trellis-frontend",
    contractVersion: "1.0",
    requestType: "oracle.submission",
    payload: {
      payloadHash: "a".repeat(64),
      signer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      fee: "0.00001",
    },
    signedAt: "2026-10-20T00:00:00.000Z",
    signature: "",
    ...rest,
  };
  envelope.signature =
    signature === undefined
      ? signCrossRepoPayload(FRONTEND_SECRET, buildCrossRepoSigningPayload(envelope))
      : signature;
  return envelope;
}

function buildService(provider: CrossRepoSchemaProvider = new CrossRepoContractSchemaRegistry()) {
  const config = new ConfigService({
    CROSS_REPO_SCHEMA_RETRY_DELAY_MS: 0,
    CROSS_REPO_SCHEMA_MAX_ATTEMPTS: 3,
  });
  return new CrossRepoRequestValidationService(config, provider);
}

describe("CrossRepoRequestValidationService", () => {
  describe("normal path", () => {
    it("accepts a signed request whose payload matches the contract", async () => {
      const service = buildService();
      const result = await service.validate(validEnvelope());

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.retryable).toBe(false);
      expect(result.clientId).toBe("trellis-frontend");
    });

    it("records lastUsedAt on the client after a successful validation", async () => {
      const service = buildService();
      await service.validate(validEnvelope());
      const summary = service.listClients().find((c) => c.clientId === "trellis-frontend");
      expect(summary?.lastUsedAt).toBeTruthy();
    });
  });

  describe("failure path", () => {
    it("reports a missing required field", async () => {
      const service = buildService();
      const result = await service.validate(
        validEnvelope({ payload: { signer: "GABC", fee: "0.1" } }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "payloadHash", code: "REQUIRED_FIELD_MISSING" }),
      );
    });

    it("reports a type mismatch", async () => {
      const service = buildService();
      const result = await service.validate(
        validEnvelope({ payload: { payloadHash: 123, signer: "GABC", fee: "0.1" } }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "payloadHash", code: "INVALID_TYPE" }),
      );
    });

    it("reports a pattern mismatch", async () => {
      const service = buildService();
      const result = await service.validate(
        validEnvelope({ payload: { payloadHash: "not-hex", signer: "GABC", fee: "0.1" } }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "payloadHash", code: "PATTERN_MISMATCH" }),
      );
    });

    it("reports a value outside the allowed enum", async () => {
      const service = buildService();
      const envelope = validEnvelope({
        requestType: "portfolio.import",
        payload: { source: "xml", rows: [] },
      });
      const result = await service.validate(envelope);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "source", code: "VALUE_NOT_ALLOWED" }),
      );
    });

    it("reports an unregistered contract", async () => {
      const service = buildService();
      const result = await service.validate(validEnvelope({ requestType: "does.not.exist" }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("UNKNOWN_CONTRACT");
    });
  });

  describe("authorization path", () => {
    it("rejects an unknown client", async () => {
      const service = buildService();
      const result = await service.validate(validEnvelope({ clientId: "ghost" }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("UNKNOWN_CLIENT");
    });

    it("rejects a suspended client", async () => {
      const service = buildService();
      service.updateClientStatus("trellis-frontend", "suspended");
      const result = await service.validate(validEnvelope());
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CLIENT_NOT_ACTIVE");
    });

    it("rejects a revoked client", async () => {
      const service = buildService();
      service.updateClientStatus("trellis-frontend", "revoked");
      const result = await service.validate(validEnvelope());
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CLIENT_NOT_ACTIVE");
    });

    it("rejects a client using a contract version it is not allowed to use", async () => {
      const service = buildService();
      const result = await service.validate(validEnvelope({ contractVersion: "9.9" }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CONTRACT_VERSION_NOT_ALLOWED");
    });

    it("rejects a bad signature", async () => {
      const service = buildService();
      const result = await service.validate(validEnvelope({ signature: "deadbeef" }));
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("INVALID_SIGNATURE");
    });

    it("never exposes the client secret in summaries", async () => {
      const service = buildService();
      const serialized = JSON.stringify(service.listClients());
      expect(serialized).not.toContain(FRONTEND_SECRET);
    });
  });

  describe("retry path", () => {
    it("returns a retryable verdict when the schema provider is unavailable", async () => {
      const provider: CrossRepoSchemaProvider = {
        resolve: jest.fn().mockRejectedValue(new ContractSchemaUnavailableError()),
        list: jest.fn().mockReturnValue([]),
      };
      const service = buildService(provider);
      const result = await service.validate(validEnvelope());

      expect(result.valid).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("SCHEMA_UNAVAILABLE");
      expect(provider.resolve).toHaveBeenCalledTimes(3);
    });

    it("recovers when the schema provider succeeds on a later attempt", async () => {
      const schema: CrossRepoContractSchema = {
        requestType: "oracle.submission",
        contractVersion: "1.0",
        fields: [{ name: "payloadHash", type: "string", required: true }],
      };
      const provider: CrossRepoSchemaProvider = {
        resolve: jest
          .fn()
          .mockRejectedValueOnce(new ContractSchemaUnavailableError())
          .mockResolvedValueOnce(schema),
        list: jest.fn().mockReturnValue([schema]),
      };
      const service = buildService(provider);
      const result = await service.validate(validEnvelope());

      expect(result.valid).toBe(true);
      expect(provider.resolve).toHaveBeenCalledTimes(2);
    });
  });

  describe("client administration", () => {
    it("registers, lists, suspends and reactivates clients", () => {
      const service = buildService();
      const created = service.registerClient({
        clientId: "trellis-mobile",
        clientName: "Trellis Mobile",
        secret: "mobile-secret",
        contractVersions: ["1.0"],
      });
      expect(created.status).toBe("active");
      expect((created as any).secret).toBeUndefined();

      expect(service.listClients().map((c) => c.clientId)).toContain("trellis-mobile");

      expect(service.updateClientStatus("trellis-mobile", "suspended").status).toBe("suspended");
      expect(service.updateClientStatus("trellis-mobile", "active").status).toBe("active");
    });

    it("rejects duplicate client registration", () => {
      const service = buildService();
      expect(() =>
        service.registerClient({ clientId: "trellis-frontend", clientName: "Dup", secret: "x" }),
      ).toThrow();
    });
  });
});

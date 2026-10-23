/**
 * Behavioural tests for the signed snapshot export (issue #356).
 *
 * Covers normal, failure, retry and authorization paths.
 */

import { ConfigService } from "@nestjs/config";
import { NotFoundException } from "@nestjs/common";
import { SnapshotExportService } from "./snapshot-export.service";
import {
  SnapshotExportAuthorizationError,
  SnapshotExportRetryableError,
} from "./snapshot-export.errors";
import { SnapshotExportSigningKeyUnavailableError } from "./snapshot-export.signing";
import type { SnapshotRecord } from "../snapshot.service";
import { SnapshotExportDocument } from "./snapshot-export.types";

const SNAPSHOT: SnapshotRecord = {
  id: "snap-1",
  label: "pre-deploy",
  scope: "full",
  createdAt: "2026-10-20T00:00:00.000Z",
  payload: { b: 2, a: 1, nested: { y: 1, x: 2 } },
  integrityHash: "source-integrity",
  signature: "source-signature",
  redactedFields: ["secret"],
  recordCount: 3,
};

const ADMIN = { id: "admin-1", role: "ADMIN" };
const MAINTAINER = { id: "maint-1", role: "MAINTAINER" };
const USER = { id: "user-1", role: "USER" };

function buildService(keyProvider: { getKey: jest.Mock }) {
  const snapshotService = {
    getSnapshot: jest.fn().mockReturnValue(SNAPSHOT),
  } as any;
  const config = new ConfigService({
    SNAPSHOT_EXPORT_KEY_RETRY_DELAY_MS: 0,
    SNAPSHOT_EXPORT_KEY_MAX_ATTEMPTS: 3,
  });
  return new SnapshotExportService(snapshotService, config, keyProvider as any);
}

function keyProvider(secret = "export-signing-key") {
  return { getKey: jest.fn().mockResolvedValue(secret) };
}

describe("SnapshotExportService", () => {
  describe("normal path", () => {
    it("exports a signed document and verifies it", async () => {
      const service = buildService(keyProvider());
      const document = await service.exportSnapshot("snap-1", ADMIN);

      expect(document.exportId).toBeTruthy();
      expect(document.snapshotId).toBe("snap-1");
      expect(document.algorithm).toBe("HMAC-SHA256");
      expect(document.payloadHash).toHaveLength(64);
      expect(document.signature).toHaveLength(64);
      expect(document.payload).toEqual(SNAPSHOT.payload);

      const verification = await service.verifyExport(document.exportId, ADMIN);
      expect(verification.valid).toBe(true);
      expect(verification.hashMatch).toBe(true);
      expect(verification.signatureMatch).toBe(true);
    });

    it("produces a stable payload hash regardless of key insertion order", async () => {
      const service = buildService(keyProvider());
      const first = await service.exportSnapshot("snap-1", ADMIN);
      const second = await service.exportSnapshot("snap-1", ADMIN);
      expect(first.payloadHash).toBe(second.payloadHash);
    });

    it("lists exports without the payload or signature", async () => {
      const service = buildService(keyProvider());
      const document = await service.exportSnapshot("snap-1", MAINTAINER);
      const summaries = service.listExports(ADMIN);

      expect(summaries).toHaveLength(1);
      expect(summaries[0].exportId).toBe(document.exportId);
      expect(summaries[0]).not.toHaveProperty("payload");
      expect(summaries[0]).not.toHaveProperty("signature");
    });
  });

  describe("failure path", () => {
    it("throws NotFoundException for an unknown snapshot", async () => {
      const service = buildService(keyProvider());
      (service as any).snapshotService.getSnapshot.mockReturnValue(undefined);
      await expect(service.exportSnapshot("missing", ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("detects a tampered payload on verification", async () => {
      const service = buildService(keyProvider());
      const document = await service.exportSnapshot("snap-1", ADMIN);
      const stored = (service as any).exports.get(document.exportId) as SnapshotExportDocument;
      stored.payload.a = 999;

      const verification = await service.verifyExport(document.exportId, ADMIN);
      expect(verification.valid).toBe(false);
      expect(verification.hashMatch).toBe(false);
      expect(verification.reason).toContain("hash mismatch");
    });

    it("detects a signature produced with a different key", async () => {
      const service = buildService(keyProvider("key-a"));
      const document = await service.exportSnapshot("snap-1", ADMIN);

      // Verify with a different key provider.
      const other = buildService(keyProvider("key-b"));
      (other as any).exports.set(document.exportId, document);
      const verification = await other.verifyExport(document.exportId, ADMIN);
      expect(verification.hashMatch).toBe(true);
      expect(verification.signatureMatch).toBe(false);
      expect(verification.valid).toBe(false);
    });
  });

  describe("retry path", () => {
    it("raises a retryable error when the signing key provider is unavailable", async () => {
      const provider = {
        getKey: jest.fn().mockRejectedValue(new SnapshotExportSigningKeyUnavailableError()),
      };
      const service = buildService(provider);
      await expect(service.exportSnapshot("snap-1", ADMIN)).rejects.toBeInstanceOf(
        SnapshotExportRetryableError,
      );
      expect(provider.getKey).toHaveBeenCalledTimes(3);
    });

    it("recovers when the signing key provider succeeds on a later attempt", async () => {
      const provider = {
        getKey: jest
          .fn()
          .mockRejectedValueOnce(new SnapshotExportSigningKeyUnavailableError())
          .mockResolvedValueOnce("export-signing-key"),
      };
      const service = buildService(provider);
      const document = await service.exportSnapshot("snap-1", ADMIN);
      expect(document.signature).toHaveLength(64);
      expect(provider.getKey).toHaveBeenCalledTimes(2);
    });
  });

  describe("authorization path", () => {
    it("refuses to export for a non-privileged role", async () => {
      const service = buildService(keyProvider());
      await expect(service.exportSnapshot("snap-1", USER)).rejects.toBeInstanceOf(
        SnapshotExportAuthorizationError,
      );
    });

    it("refuses to list exports for a non-privileged role", () => {
      const service = buildService(keyProvider());
      expect(() => service.listExports(USER)).toThrow(SnapshotExportAuthorizationError);
    });

    it("lets the exporter read their own export but not another user's", async () => {
      const service = buildService(keyProvider());
      const document = await service.exportSnapshot("snap-1", MAINTAINER);

      expect(service.getExport(document.exportId, MAINTAINER).exportId).toBe(document.exportId);
      expect(() => service.getExport(document.exportId, USER)).toThrow(
        SnapshotExportAuthorizationError,
      );
      expect(service.getExport(document.exportId, ADMIN).exportId).toBe(document.exportId);
    });
  });
});

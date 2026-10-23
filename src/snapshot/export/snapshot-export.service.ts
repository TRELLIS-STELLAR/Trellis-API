import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { SnapshotService } from "../snapshot.service";
import {
  SnapshotExportDocument,
  SnapshotExportRequester,
  SnapshotExportSummary,
  SnapshotExportVerification,
} from "./snapshot-export.types";
import {
  SnapshotExportAuthorizationError,
  SnapshotExportRetryableError,
} from "./snapshot-export.errors";
import {
  SNAPSHOT_EXPORT_SIGNING_KEY,
  SnapshotExportSigningKeyProvider,
  SnapshotExportSigningKeyUnavailableError,
  canonicalJson,
  hashPayload,
  signPayload,
  verifySignature,
} from "./snapshot-export.signing";

const PRIVILEGED_ROLES = new Set(["ADMIN", "MAINTAINER"]);

/**
 * Turns a stored snapshot into a signed, portable export document for audit
 * and debugging (issue #356).
 *
 * Paths:
 * - **Normal** — an authorised maintainer exports a snapshot. The payload is
 *   canonicalised, hashed and HMAC-signed, and stored as a document that can
 *   be re-verified without the original service.
 * - **Failure** — the snapshot does not exist (404) or the payload/signature
 *   no longer match on verification (tamper detection).
 * - **Retry** — the signing-key provider is temporarily unavailable. The
 *   service retries and then raises a retryable error the caller can honour.
 * - **Authorization** — only ADMIN/MAINTAINER may export or list; only the
 *   exporter or a privileged role may read or verify a given document.
 */
@Injectable()
export class SnapshotExportService {
  private readonly logger = new Logger(SnapshotExportService.name);
  private readonly exports = new Map<string, SnapshotExportDocument>();
  private readonly keyRetryDelayMs: number;
  private readonly keyMaxAttempts: number;

  constructor(
    private readonly snapshotService: SnapshotService,
    private readonly configService: ConfigService,
    @Inject(SNAPSHOT_EXPORT_SIGNING_KEY)
    private readonly signingKeyProvider: SnapshotExportSigningKeyProvider,
  ) {
    this.keyRetryDelayMs =
      Number(this.configService.get("SNAPSHOT_EXPORT_KEY_RETRY_DELAY_MS")) || 25;
    this.keyMaxAttempts =
      Number(this.configService.get("SNAPSHOT_EXPORT_KEY_MAX_ATTEMPTS")) || 3;
  }

  async exportSnapshot(
    snapshotId: string,
    requester: SnapshotExportRequester,
  ): Promise<SnapshotExportDocument> {
    this.assertCanExport(requester);

    const snapshot = this.snapshotService.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new NotFoundException(`Snapshot ${snapshotId} not found`);
    }

    const payload = snapshot.payload ?? {};
    const payloadHash = hashPayload(canonicalJson(payload));
    const key = await this.resolveKeyWithRetry();
    const signature = signPayload(key, payloadHash);

    const document: SnapshotExportDocument = {
      exportId: randomUUID(),
      snapshotId: snapshot.id,
      exportedAt: new Date().toISOString(),
      exportedBy: requester.id,
      algorithm: "HMAC-SHA256",
      hashAlgorithm: "sha256",
      payloadHash,
      signature,
      payload,
      metadata: {
        scope: snapshot.scope,
        label: snapshot.label,
        recordCount: snapshot.recordCount,
        redactedFields: [...snapshot.redactedFields],
        sourceIntegrityHash: snapshot.integrityHash,
      },
    };

    this.exports.set(document.exportId, document);
    this.logger.log(
      `Snapshot export ${document.exportId} created by ${requester.id} for snapshot ${snapshotId}`,
    );
    return this.clone(document);
  }

  async verifyExport(
    exportId: string,
    requester: SnapshotExportRequester,
  ): Promise<SnapshotExportVerification> {
    const document = this.getAuthorized(exportId, requester);
    const payloadHash = hashPayload(canonicalJson(document.payload));
    const hashMatch = payloadHash === document.payloadHash;

    let signatureMatch = false;
    if (hashMatch) {
      try {
        const key = await this.resolveKeyWithRetry();
        signatureMatch = verifySignature(key, document.payloadHash, document.signature);
      } catch (error) {
        if (error instanceof SnapshotExportRetryableError) throw error;
        signatureMatch = false;
      }
    }

    return {
      exportId,
      valid: hashMatch && signatureMatch,
      hashMatch,
      signatureMatch,
      reason: !hashMatch
        ? "Payload hash mismatch — the exported payload was modified after export"
        : !signatureMatch
          ? "Signature mismatch — the export was signed with a different key or tampered with"
          : undefined,
      verifiedAt: new Date().toISOString(),
    };
  }

  getExport(
    exportId: string,
    requester: SnapshotExportRequester,
  ): SnapshotExportDocument {
    return this.clone(this.getAuthorized(exportId, requester));
  }

  listExports(requester: SnapshotExportRequester): SnapshotExportSummary[] {
    this.assertCanExport(requester);
    return [...this.exports.values()]
      .sort((a, b) => b.exportedAt.localeCompare(a.exportedAt))
      .map((document) => ({
        exportId: document.exportId,
        snapshotId: document.snapshotId,
        exportedAt: document.exportedAt,
        exportedBy: document.exportedBy,
        algorithm: document.algorithm,
        payloadHash: document.payloadHash,
        scope: document.metadata.scope,
        recordCount: document.metadata.recordCount,
      }));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private getAuthorized(
    exportId: string,
    requester: SnapshotExportRequester,
  ): SnapshotExportDocument {
    const document = this.exports.get(exportId);
    if (!document) throw new NotFoundException(`Snapshot export ${exportId} not found`);
    const privileged = this.isPrivileged(requester);
    if (document.exportedBy !== requester.id && !privileged) {
      throw new SnapshotExportAuthorizationError();
    }
    return document;
  }

  private assertCanExport(requester: SnapshotExportRequester): void {
    if (!this.isPrivileged(requester)) {
      throw new SnapshotExportAuthorizationError(
        "Only ADMIN or MAINTAINER may create or list snapshot exports",
      );
    }
  }

  private isPrivileged(requester: SnapshotExportRequester): boolean {
    return PRIVILEGED_ROLES.has(String(requester.role ?? "").toUpperCase());
  }

  private async resolveKeyWithRetry(): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.keyMaxAttempts; attempt++) {
      try {
        return await this.signingKeyProvider.getKey();
      } catch (error) {
        lastError = error;
        if (!(error instanceof SnapshotExportSigningKeyUnavailableError)) throw error;
        if (attempt < this.keyMaxAttempts) {
          await this.delay(this.keyRetryDelayMs * attempt);
        }
      }
    }
    this.logger.warn("snapshot export signing key provider unavailable after retries");
    throw new SnapshotExportRetryableError(
      undefined,
      Math.max(1, Math.ceil(this.keyRetryDelayMs / 1000)),
    );
  }

  private clone(document: SnapshotExportDocument): SnapshotExportDocument {
    return {
      ...document,
      payload: JSON.parse(JSON.stringify(document.payload)) as Record<string, unknown>,
      metadata: {
        ...document.metadata,
        redactedFields: [...document.metadata.redactedFields],
      },
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

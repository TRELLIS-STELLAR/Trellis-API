// src/blockchain/oracle/submission-verifier.controller.ts

import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { SubmissionVerifierService } from "./submission-verifier.service";
import { AuditLogService } from "src/infrastructure/audit/audit-log.service";
import { CanonicalSerializationService } from "./canonical-serialization.service";
import { ReplayProtectionService } from "./replay-protection.service";

export interface SignedSubmissionDto {
  payload: unknown;
  signature: string;
  signer: string;
  nonce?: string;
  issuedAt?: string | number;
}

@Controller("verifier")
export class SubmissionVerifierController {
  constructor(
    private verifier: SubmissionVerifierService,
    private audit: AuditLogService,
    private canonical: CanonicalSerializationService,
    private replay: ReplayProtectionService,
  ) {}

  @Get("status")
  getStatus() {
    return this.verifier.getStatus();
  }

  @Get("logs")
  getLogs() {
    return this.audit.getLogs();
  }

  /**
   * Returns the canonical bytes and digest for a payload without verifying.
   * Useful for clients to reproduce the exact signing input.
   */
  @Post("canonicalize")
  canonicalize(@Body() body: unknown) {
    const canonical = this.canonical.canonicalize(body);
    return {
      canonical,
      digest: this.canonical.digest(canonical),
    };
  }

  /**
   * Verifies a signed submission using the canonical serialization layer.
   * Replay protection is applied when a nonce is present.
   */
  @Post("verify")
  @HttpCode(200)
  async verify(@Body() body: SignedSubmissionDto) {
    const canonical = this.canonical.canonicalize(body.payload);
    const digest = this.canonical.digest(canonical);

    if (body.nonce) {
      const fresh = await this.replay.checkAndRecord({
        nonce: body.nonce,
        signer: body.signer,
        digest,
        issuedAt: body.issuedAt,
      });
      if (!fresh) {
        this.audit.record("verifier.replay", {
          signer: body.signer,
          nonce: body.nonce,
          digest,
        });
        return { ok: false, reason: "replay" as const, digest };
      }
    }

    const result = await this.verifier.verifyCanonical({
      canonical,
      digest,
      signature: body.signature,
      signer: body.signer,
    });

    this.audit.record("verifier.verify", {
      signer: body.signer,
      digest,
      ok: result.ok,
    });

    return { ...result, digest };
  }
}

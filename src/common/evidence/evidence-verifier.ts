import { createHash, createPublicKey, timingSafeEqual, verify } from "crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "../errors/app.exception";
import { Permission, Role, hasPermission } from "../guard/roles.enum";
import { canonicalJson } from "../serialization/canonical-json";

/**
 * Cryptographic verification for imported external evidence (#265).
 *
 * Evidence arrives as an envelope signed by an external issuer with Ed25519:
 *
 *   payloadDigest = sha256(canonicalJson(payload))              (hex)
 *   signature     = Ed25519(canonicalJson(envelope fields))     (base64)
 *
 * where the signed envelope fields are `id, type, issuer, keyId, issuedAt,
 * payloadDigest`. Signing the digest binds the payload; signing `type`,
 * `issuer` and `keyId` stops an attacker re-labelling genuine evidence.
 * A key is only trusted for its own issuer and allowed evidence types, inside
 * its validity window, and never for evidence issued after revocation.
 */
export interface ExternalEvidence {
  id: string;
  type: string;
  issuer: string;
  keyId: string;
  /** ISO-8601 timestamp of issuance. */
  issuedAt: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  signature: string;
}

export interface TrustedEvidenceKey {
  keyId: string;
  issuer: string;
  /** SPKI PEM Ed25519 public key. */
  publicKeyPem: string;
  allowedTypes: string[];
  notBefore?: string;
  notAfter?: string;
  /** Evidence issued at or after this instant is rejected. */
  revokedAt?: string;
}

export type EvidenceRejection =
  | "MALFORMED"
  | "UNKNOWN_KEY"
  | "ISSUER_MISMATCH"
  | "TYPE_NOT_ALLOWED"
  | "KEY_NOT_YET_VALID"
  | "KEY_EXPIRED"
  | "KEY_REVOKED"
  | "FUTURE_DATED"
  | "STALE"
  | "DIGEST_MISMATCH"
  | "BAD_SIGNATURE";

export type EvidenceVerification =
  | { valid: true }
  | { valid: false; reason: EvidenceRejection };

export interface EvidenceVerifierOptions {
  /** Reject evidence older than this. Unset means no age limit. */
  maxAgeMs?: number;
  /** Tolerated clock skew for future-dated evidence. Defaults to 5 minutes. */
  clockSkewMs?: number;
  now?: () => Date;
}

export interface EvidenceActor {
  id: string;
  roles: Role[];
}

export interface AcceptedEvidence {
  evidence: ExternalEvidence;
  /** True when this exact evidence was already accepted (safe client retry). */
  duplicate: boolean;
}

const SIGNED_FIELDS = ["id", "type", "issuer", "keyId", "issuedAt", "payloadDigest"] as const;

export function computePayloadDigest(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** The exact bytes an issuer signs. Exposed so issuers and tests sign identically. */
export function evidenceSigningInput(
  evidence: Pick<ExternalEvidence, (typeof SIGNED_FIELDS)[number]>,
): Buffer {
  const envelope: Record<string, string> = {};
  for (const field of SIGNED_FIELDS) envelope[field] = evidence[field];
  return Buffer.from(canonicalJson(envelope), "utf8");
}

export class EvidenceVerifier {
  private readonly keys = new Map<string, TrustedEvidenceKey>();
  private readonly accepted = new Map<string, string>();
  private readonly clockSkewMs: number;
  private readonly now: () => Date;

  constructor(
    keys: TrustedEvidenceKey[],
    private readonly options: EvidenceVerifierOptions = {},
  ) {
    for (const key of keys) this.keys.set(key.keyId, key);
    this.clockSkewMs = options.clockSkewMs ?? 5 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  /** Pure check: never mutates state and never throws on bad evidence. */
  verify(evidence: ExternalEvidence): EvidenceVerification {
    const reject = (reason: EvidenceRejection): EvidenceVerification => ({
      valid: false,
      reason,
    });

    if (!isWellFormed(evidence)) return reject("MALFORMED");
    const issuedAt = Date.parse(evidence.issuedAt);
    if (Number.isNaN(issuedAt)) return reject("MALFORMED");

    const key = this.keys.get(evidence.keyId);
    if (!key) return reject("UNKNOWN_KEY");
    if (key.issuer !== evidence.issuer) return reject("ISSUER_MISMATCH");
    if (!key.allowedTypes.includes(evidence.type)) return reject("TYPE_NOT_ALLOWED");
    if (key.notBefore && issuedAt < Date.parse(key.notBefore)) return reject("KEY_NOT_YET_VALID");
    if (key.notAfter && issuedAt > Date.parse(key.notAfter)) return reject("KEY_EXPIRED");
    if (key.revokedAt && issuedAt >= Date.parse(key.revokedAt)) return reject("KEY_REVOKED");

    const nowMs = this.now().getTime();
    if (issuedAt > nowMs + this.clockSkewMs) return reject("FUTURE_DATED");
    if (this.options.maxAgeMs !== undefined && nowMs - issuedAt > this.options.maxAgeMs) {
      return reject("STALE");
    }

    let expectedDigest: string;
    try {
      expectedDigest = computePayloadDigest(evidence.payload);
    } catch {
      return reject("MALFORMED");
    }
    if (!safeEqualHex(expectedDigest, evidence.payloadDigest)) return reject("DIGEST_MISMATCH");

    try {
      const ok = verify(
        null,
        evidenceSigningInput(evidence),
        createPublicKey(key.publicKeyPem),
        Buffer.from(evidence.signature, "base64"),
      );
      return ok ? { valid: true } : reject("BAD_SIGNATURE");
    } catch {
      return reject("BAD_SIGNATURE");
    }
  }

  /**
   * Authorizes the caller, verifies the evidence and records it as accepted.
   * Re-submitting identical evidence (a client retry) returns
   * `duplicate: true`; reusing an id with different content is a 409.
   */
  accept(actor: EvidenceActor, evidence: ExternalEvidence): AcceptedEvidence {
    if (!hasPermission(actor.roles, Permission.IMPORT_EXECUTE)) {
      throw new ForbiddenException("Not allowed to import external evidence");
    }

    const result = this.verify(evidence);
    if (result.valid === false) {
      throw new BadRequestException(`Evidence rejected: ${result.reason}`);
    }

    const known = this.accepted.get(evidence.id);
    if (known !== undefined) {
      if (known !== evidence.payloadDigest) {
        throw new ConflictException(
          `Evidence id ${evidence.id} was already imported with different content`,
        );
      }
      return { evidence, duplicate: true };
    }
    this.accepted.set(evidence.id, evidence.payloadDigest);
    return { evidence, duplicate: false };
  }
}

function isWellFormed(evidence: ExternalEvidence): boolean {
  if (!evidence || typeof evidence !== "object") return false;
  const strings = [
    evidence.id,
    evidence.type,
    evidence.issuer,
    evidence.keyId,
    evidence.issuedAt,
    evidence.payloadDigest,
    evidence.signature,
  ];
  return (
    strings.every((value) => typeof value === "string" && value.length > 0) &&
    !!evidence.payload &&
    typeof evidence.payload === "object" &&
    !Array.isArray(evidence.payload)
  );
}

function safeEqualHex(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

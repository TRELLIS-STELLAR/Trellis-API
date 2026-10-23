import { KeyObject, generateKeyPairSync, sign } from "crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "../errors/app.exception";
import { Role } from "../guard/roles.enum";
import {
  EvidenceVerifier,
  ExternalEvidence,
  TrustedEvidenceKey,
  computePayloadDigest,
  evidenceSigningInput,
} from "./evidence-verifier";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const importer = { id: "op-1", roles: [Role.ADMIN] };

function newKey(overrides: Partial<TrustedEvidenceKey> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trusted: TrustedEvidenceKey = {
    keyId: "key-1",
    issuer: "oracle.example",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedTypes: ["price-attestation"],
    ...overrides,
  };
  return { trusted, privateKey };
}

function signed(
  privateKey: KeyObject,
  overrides: Partial<ExternalEvidence> = {},
): ExternalEvidence {
  const payload = overrides.payload ?? { asset: "XLM", price: "0.12" };
  const base = {
    id: "ev-1",
    type: "price-attestation",
    issuer: "oracle.example",
    keyId: "key-1",
    issuedAt: "2026-06-01T11:00:00.000Z",
    payloadDigest: computePayloadDigest(payload),
    ...overrides,
  };
  const signature = sign(null, evidenceSigningInput(base), privateKey).toString("base64");
  return { ...base, payload, signature, ...overrides } as ExternalEvidence;
}

function setup(keyOverrides: Partial<TrustedEvidenceKey> = {}, maxAgeMs?: number) {
  const { trusted, privateKey } = newKey(keyOverrides);
  const verifier = new EvidenceVerifier([trusted], { now: () => NOW, maxAgeMs });
  return { verifier, privateKey };
}

describe("EvidenceVerifier (#265)", () => {
  it("accepts correctly signed evidence from a trusted issuer", () => {
    const { verifier, privateKey } = setup();
    expect(verifier.verify(signed(privateKey))).toEqual({ valid: true });
  });

  it("is insensitive to payload key order (canonical digest)", () => {
    const { verifier, privateKey } = setup();
    const evidence = signed(privateKey, { payload: { b: 2, a: 1 } });
    evidence.payload = { a: 1, b: 2 };
    expect(verifier.verify(evidence)).toEqual({ valid: true });
  });

  it("rejects a tampered payload", () => {
    const { verifier, privateKey } = setup();
    const evidence = signed(privateKey);
    evidence.payload = { asset: "XLM", price: "9.99" };
    expect(verifier.verify(evidence)).toEqual({ valid: false, reason: "DIGEST_MISMATCH" });
  });

  it("rejects a payload swapped together with a recomputed digest", () => {
    const { verifier, privateKey } = setup();
    const evidence = signed(privateKey);
    evidence.payload = { asset: "XLM", price: "9.99" };
    evidence.payloadDigest = computePayloadDigest(evidence.payload);
    expect(verifier.verify(evidence)).toEqual({ valid: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects relabelled envelope fields and foreign signatures", () => {
    const { verifier, privateKey } = setup();
    const relabelled = signed(privateKey);
    relabelled.issuedAt = "2026-06-01T11:30:00.000Z";
    expect(verifier.verify(relabelled)).toEqual({ valid: false, reason: "BAD_SIGNATURE" });

    const attacker = newKey().privateKey;
    expect(verifier.verify(signed(attacker))).toEqual({ valid: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects malformed signatures and envelopes without throwing", () => {
    const { verifier, privateKey } = setup();
    const evidence = signed(privateKey);
    expect(verifier.verify({ ...evidence, signature: "!!not-base64!!" }).valid).toBe(false);
    expect(verifier.verify({ ...evidence, id: "" })).toEqual({ valid: false, reason: "MALFORMED" });
    expect(verifier.verify({ ...evidence, issuedAt: "yesterday" })).toEqual({
      valid: false,
      reason: "MALFORMED",
    });
    expect(verifier.verify(null as unknown as ExternalEvidence)).toEqual({
      valid: false,
      reason: "MALFORMED",
    });
  });

  it("enforces key trust: unknown key, issuer binding and evidence type", () => {
    const { verifier, privateKey } = setup();
    expect(verifier.verify(signed(privateKey, { keyId: "other" }))).toEqual({
      valid: false,
      reason: "UNKNOWN_KEY",
    });
    expect(verifier.verify(signed(privateKey, { issuer: "evil.example" }))).toEqual({
      valid: false,
      reason: "ISSUER_MISMATCH",
    });
    expect(verifier.verify(signed(privateKey, { type: "kyc-attestation" }))).toEqual({
      valid: false,
      reason: "TYPE_NOT_ALLOWED",
    });
  });

  it("enforces key validity windows and revocation by issuance time", () => {
    const window = setup({
      notBefore: "2026-06-01T10:00:00.000Z",
      notAfter: "2026-06-01T11:30:00.000Z",
      revokedAt: "2026-06-01T11:15:00.000Z",
    });
    const at = (issuedAt: string) => window.verifier.verify(signed(window.privateKey, { issuedAt }));

    expect(at("2026-06-01T09:00:00.000Z")).toEqual({ valid: false, reason: "KEY_NOT_YET_VALID" });
    expect(at("2026-06-01T10:30:00.000Z")).toEqual({ valid: true });
    expect(at("2026-06-01T11:20:00.000Z")).toEqual({ valid: false, reason: "KEY_REVOKED" });
    expect(at("2026-06-01T11:45:00.000Z")).toEqual({ valid: false, reason: "KEY_EXPIRED" });
  });

  it("rejects future-dated and stale evidence", () => {
    const { verifier, privateKey } = setup({}, 60 * 60 * 1000);
    expect(verifier.verify(signed(privateKey, { issuedAt: "2026-06-01T13:00:00.000Z" }))).toEqual({
      valid: false,
      reason: "FUTURE_DATED",
    });
    expect(verifier.verify(signed(privateKey, { issuedAt: "2026-06-01T09:00:00.000Z" }))).toEqual({
      valid: false,
      reason: "STALE",
    });
  });

  describe("accept()", () => {
    it("refuses callers without import permission, before verifying", () => {
      const { verifier, privateKey } = setup();
      const spy = jest.spyOn(verifier, "verify");
      expect(() =>
        verifier.accept({ id: "u", roles: [Role.USER] }, signed(privateKey)),
      ).toThrow(ForbiddenException);
      expect(spy).not.toHaveBeenCalled();
    });

    it("turns verification failures into 400 and records nothing", () => {
      const { verifier, privateKey } = setup();
      const tampered = signed(privateKey);
      tampered.payload = { asset: "XLM", price: "9.99" };
      expect(() => verifier.accept(importer, tampered)).toThrow(BadRequestException);
      expect(() => verifier.accept(importer, tampered)).toThrow(/DIGEST_MISMATCH/);
      // The genuine evidence with the same id is still importable afterwards.
      expect(verifier.accept(importer, signed(privateKey)).duplicate).toBe(false);
    });

    it("treats an identical resubmission as a safe retry", () => {
      const { verifier, privateKey } = setup();
      const evidence = signed(privateKey);
      expect(verifier.accept(importer, evidence).duplicate).toBe(false);
      expect(verifier.accept(importer, evidence).duplicate).toBe(true);
    });

    it("rejects an id reused with different (validly signed) content", () => {
      const { verifier, privateKey } = setup();
      verifier.accept(importer, signed(privateKey));
      const changed = signed(privateKey, { payload: { asset: "XLM", price: "0.13" } });
      expect(() => verifier.accept(importer, changed)).toThrow(ConflictException);
    });
  });
});

# Cryptographic verification for imported external evidence (#265)

`EvidenceVerifier` (`src/common/evidence/evidence-verifier.ts`) checks that
evidence imported from an external issuer is authentic, untampered and from a
key allowed to speak for it. It is opt-in and storage-agnostic; existing
import flows are unchanged until they call it.

## Envelope

```
payloadDigest = sha256_hex(canonicalJson(payload))
signature     = base64(Ed25519(canonicalJson({id, type, issuer, keyId, issuedAt, payloadDigest})))
```

`canonicalJson` is the shared deterministic serializer, so key order does not
affect the digest. Signing the digest binds the payload; signing the envelope
fields stops genuine evidence being relabelled (different type, issuer, key or
timestamp). Issuers sign `evidenceSigningInput(evidence)`.

## Trust model (`TrustedEvidenceKey`)

A key is trusted only for its own `issuer` and listed `allowedTypes`, and only
for evidence whose `issuedAt` is inside `[notBefore, notAfter]` and before
`revokedAt`. Revocation is by issuance time, so evidence signed before a key
was compromised stays valid while anything issued after is rejected.

`verify()` is pure and returns `{ valid: true }` or `{ valid: false, reason }`
with one of `MALFORMED, UNKNOWN_KEY, ISSUER_MISMATCH, TYPE_NOT_ALLOWED,
KEY_NOT_YET_VALID, KEY_EXPIRED, KEY_REVOKED, FUTURE_DATED, STALE,
DIGEST_MISMATCH, BAD_SIGNATURE`. It never throws on bad input.

`accept(actor, evidence)` is the import entry point:

| Path | Outcome |
| --- | --- |
| Caller lacks `IMPORT_EXECUTE` | `ForbiddenException` (403), nothing verified |
| Verification fails | `BadRequestException` (400) naming the reason; nothing recorded |
| Valid, first time | accepted, `duplicate: false` |
| Same id, same content again (client retry) | accepted, `duplicate: true` |
| Same id, different validly signed content | `ConflictException` (409) |

## Operational edge cases

- **Key rotation:** add the new key alongside the old one; keep the old key
  (with `notAfter`) until evidence it signed is no longer needed.
- **Compromise:** set `revokedAt` to the compromise time and redeploy the key
  list. Re-verify previously imported evidence from that issuer after that
  instant out of band; this slice does not re-scan history.
- **Clock skew:** future-dated evidence beyond `clockSkewMs` (default 5 min)
  is rejected; `maxAgeMs` optionally rejects stale evidence.
- **Replay memory is in-process.** Accepted ids are held in memory, so replay
  protection resets on restart and is not shared across replicas. Persist
  `(id, payloadDigest)` in the import store and enforce a unique id to make it
  durable; the verifier's checks are unaffected.
- Keys are expected to be Ed25519 SPKI PEM public keys; register no other
  key types.

## Rollback

No schema or API change. Stop calling `accept()` to revert to the previous
import behavior; accepted evidence is not mutated.

## Verification

`evidence-verifier.spec.ts` generates real Ed25519 key pairs and covers valid
evidence, payload/envelope tampering, foreign signatures, malformed input,
key trust and validity windows, revocation, freshness, authorization,
retries, and id-reuse conflicts.

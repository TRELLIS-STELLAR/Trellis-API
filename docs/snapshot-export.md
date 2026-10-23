# Signed state snapshot export (#356)

## What this is

The snapshot module (issue #119) creates signed snapshots in process memory.
This slice turns a stored snapshot into a **portable, signed export document**
that can be written to audit storage and independently verified later — the
document carries its own canonical payload, SHA-256 hash, HMAC signature and
metadata, so a verifier does not need the originating service.

The module is additive (`src/snapshot/export/`) and reuses the existing
`SnapshotService`; it does not change the snapshot contract.

## Export document

```json
{
  "exportId": "<uuid>",
  "snapshotId": "<snapshot id>",
  "exportedAt": "2026-10-20T00:00:00.000Z",
  "exportedBy": "<user id>",
  "algorithm": "HMAC-SHA256",
  "hashAlgorithm": "sha256",
  "payloadHash": "<sha256 hex of canonical payload>",
  "signature": "<hmac-sha256 hex over payloadHash>",
  "payload": { "...": "redacted snapshot payload" },
  "metadata": {
    "scope": "full",
    "label": "pre-deploy",
    "recordCount": 3,
    "redactedFields": ["secret"],
    "sourceIntegrityHash": "<snapshot integrity hash>"
  }
}
```

The payload is canonicalised with sorted object keys (array order preserved)
before hashing, so the hash is stable regardless of key insertion order. The
signature is `HMAC-SHA256(signingKey, payloadHash)` and is compared in constant
time.

## Paths covered

| Path | Behaviour |
| --- | --- |
| **Normal** | An `ADMIN`/`MAINTAINER` exports a snapshot. The document is stored and can be re-verified (`valid: true`). |
| **Failure** | Unknown snapshot → 404. On verification, a modified payload yields `hashMatch: false`; a signature from a different key yields `signatureMatch: false`. |
| **Retry** | The signing-key provider is temporarily unavailable. The service retries (`SNAPSHOT_EXPORT_KEY_MAX_ATTEMPTS`, default 3, backoff `SNAPSHOT_EXPORT_KEY_RETRY_DELAY_MS`, default 25ms) and then raises `SnapshotExportRetryableError`, which the controller returns as HTTP 503 with `Retry-After`. |
| **Authorization** | Only `ADMIN`/`MAINTAINER` may export or list. A document may be read or verified by its exporter or by a privileged role; anyone else gets `SnapshotExportAuthorizationError` → HTTP 403. |

## Endpoints

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/snapshots/:snapshotId/export` | JWT + `ADMIN`/`MAINTAINER` | Create a signed export document. |
| `GET` | `/api/v1/snapshots/exports` | JWT + `ADMIN`/`MAINTAINER` | List exports (metadata only). |
| `GET` | `/api/v1/snapshots/exports/:exportId` | JWT (exporter or privileged) | Retrieve a full export document. |
| `POST` | `/api/v1/snapshots/exports/verify` | JWT (exporter or privileged) | Verify hash + signature. |

## Operational edge cases

- **Key rotation.** `SNAPSHOT_EXPORT_SIGNING_KEY` falls back to
  `SNAPSHOT_SIGNING_KEY`, then to a development default. After a rotation,
  previously exported documents will fail signature verification until the old
  key is configured again — keep the old key available for the retention
  window.
- **Tamper detection is hash-first.** If the payload hash does not match, the
  signature is not even checked, so the reason is unambiguous.
- **Exports are process-local.** A restart loses exports. For audit retention,
  persist the document (e.g. object storage) at creation time.
- **Redaction is inherited.** The export payload is the already-redacted
  snapshot payload; the export does not re-redact, so it never introduces new
  secret exposure.

## Recovery / rollback

- The module is additive; removing it does not affect snapshot creation or
  verification.
- A failed export leaves no partial document: the document is only stored after
  the key resolves and the signature is computed.
- To roll back a bad signing key, re-register the previous key; verification
  is stateless and recomputes from the document.

## Contract preservation / migration

- No existing snapshot type, route or service method changed.
- The export document is a new additive shape; the shared snapshot contract in
  `trellis-contract.types.ts` is untouched.
- The signing-key provider is behind the `SNAPSHOT_EXPORT_SIGNING_KEY` token,
  so a KMS-backed implementation can be introduced without a breaking change.

## Verification

```bash
node node_modules/jest/bin/jest.js src/snapshot/export/snapshot-export.service.spec.ts
```

Covers normal, failure (missing snapshot, tampered payload, wrong key), retry
and authorization paths.

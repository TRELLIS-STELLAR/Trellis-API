# Cross-repo API request validation (#353)

## What this is

The Trellis platform spans several repositories (API, frontend, contracts).
A request that originates in another repository is a **cross-repo client**
request. This module validates those requests before they reach the domain
layer, so a malformed or unauthorised payload from a sibling repository fails
fast with a structured verdict instead of producing an opaque 500 deep inside a
service.

The validation is a focused vertical slice: it adds a self-contained module
(`src/cross-repo/`) without modifying the shared contract types in
`src/common/contract/types/trellis-contract.types.ts`.

## Paths covered

| Path | Behaviour |
| --- | --- |
| **Normal** | A registered, `active` client sends a correctly signed request whose payload matches the contract. Returns `{ valid: true, errors: [] }`. |
| **Failure** | The payload breaks the contract (missing/ mistyped field, failed pattern, out-of-range value, disallowed enum) or the request targets an unregistered contract. Returns `{ valid: false }` with per-field `code`/`message`. |
| **Retry** | The contract schema provider is temporarily unavailable. The service retries (`CROSS_REPO_SCHEMA_MAX_ATTEMPTS`, default 3, with backoff `CROSS_REPO_SCHEMA_RETRY_DELAY_MS`, default 25ms) and, if still unavailable, returns `{ valid: false, retryable: true, retryAfterSeconds }`. The client should retry, not treat the payload as invalid. |
| **Authorization** | Unknown client (`UNKNOWN_CLIENT`), non-active client (`CLIENT_NOT_ACTIVE`), a contract version the client is not allowed to use (`CONTRACT_VERSION_NOT_ALLOWED`), or a bad HMAC signature (`INVALID_SIGNATURE`). |

### Request envelope

```json
{
  "clientId": "trellis-frontend",
  "contractVersion": "1.0",
  "requestType": "oracle.submission",
  "payload": { "payloadHash": "<64 hex>", "signer": "G...", "fee": "0.00001" },
  "signedAt": "2026-10-20T00:00:00.000Z",
  "signature": "<hmac-sha256 hex>"
}
```

The signature is HMAC-SHA256 over the canonical signing payload, which is the
newline-joined tuple:

```
clientId\ncontractVersion\nrequestType\nsignedAt\ncanonicalJson(payload)
```

`canonicalJson` sorts object keys recursively and preserves array order, so the
signature is deterministic. `verifyCrossRepoSignature` compares in constant
time and never throws.

## Endpoints

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/cross-repo/validate` | none (`@Public()`, rate limited) | Validate a cross-repo request. Authorization is the client signature. |
| `GET` | `/api/v1/cross-repo/clients` | JWT + `ADMIN` | List registered clients (secret-free). |
| `POST` | `/api/v1/cross-repo/clients` | JWT + `ADMIN` | Register a client. |
| `POST` | `/api/v1/cross-repo/clients/:clientId/status` | JWT + `ADMIN` | Suspend / revoke / reactivate a client. |
| `POST` | `/api/v1/cross-repo/schemas` | JWT + `ADMIN` | Register an additional contract schema. |

The `validate` route is `@Public()` because it is machine-to-machine and its
authorization is the signature check, not a user JWT. It is rate limited to
60 req/min to avoid being used as an amplifier.

## Operational edge cases

- **Schema provider outage.** Validation does not hard-fail; it returns
  `retryable: true` after exhausting retries. Clients must distinguish this
  from a contract failure and retry after `retryAfterSeconds`.
- **Clock skew.** `signedAt` is part of the signed payload but is not currently
  compared against server time. If replay protection is required, add a skew
  window here (see migration note).
- **Client secret rotation.** The secret is held in memory. Rotating a client
  means re-registering it (or restarting). There is no persistence layer in
  this slice.
- **Unknown contract.** Reported as `UNKNOWN_CONTRACT`, not an exception, so a
  new request type from a sibling repo degrades to a clear 200 verdict instead
  of a 500.
- **Idempotency key.** Accepted and echoed by the envelope but not yet
  enforced; deduplication belongs to the domain operation, not the validator.

## Recovery / rollback

- The module is additive. Removing it does not affect existing routes or the
  shared contract.
- Client and schema registrations are process-local. A restart resets them to
  the two seeded defaults (`trellis-frontend`, `trellis-contracts`). For
  durability, back the `CROSS_REPO_SCHEMA_PROVIDER` and the client store with
  database repositories behind the existing interfaces.
- To roll back a bad schema registration, re-register the previous schema
  object; the registry is a last-write-wins map.

## Contract preservation / migration

- No existing contract, route or type was changed.
- The new `CrossRepoRequestEnvelope` is additive and mirrors the shapes in
  `trellis-contract.types.ts`.
- The schema registry is behind the `CROSS_REPO_SCHEMA_PROVIDER` token, so a
  persisted implementation can be introduced without a breaking change.

## Verification

```bash
node node_modules/jest/bin/jest.js src/cross-repo/cross-repo.service.spec.ts
```

The suite covers the normal, failure, retry and authorization paths, plus
client administration and the "secret is never serialised" guarantee.

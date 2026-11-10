# Expiring Capability Tokens for Sensitive Actions (Issue #273)

## Overview

Sensitive mutations in `Trellis-API` (such as treasury withdrawals, role assignments, contract upgrades, and compliance exports) require short-lived, action- and resource-scoped authorization in addition to standard session authentication.

The `CapabilityTokenService` and `CapabilityTokenGuard` (`src/core/auth/capability-tokens/`) provide HMAC-SHA256 signed capability tokens with:

- **Explicit Scope Binding:** Every token binds `sub` (subject/actor ID), `scope.action` (exact `SensitiveAction` or `<domain>.*` wildcard), optional `scope.resourceType` and `scope.resourceId`, and parameter constraints (`maxAmount`, `minAmount`, or exact scalar constraints).
- **Bounded Expiration (`exp`) & Not-Before (`nbf`):** Tokens enforce strict TTL bounds (`MIN_CAPABILITY_TTL_SECONDS = 5`, `MAX_CAPABILITY_TTL_SECONDS = 900`, default `300` seconds) with optional clock-skew tolerance.
- **Single-Use / Bounded-Use Consumption:** Tokens default to `singleUse: true` (`maxUses: 1`) so a captured capability token cannot be replayed against subsequent mutations.
- **Key Rotation (`kid`):** Tokens embed a key identifier (`kid`) in the signed header (`cap_v1.<header>.<claims>.<signature>`) and verify against the active keyring so secret rotation never breaks in-flight tokens.

## Token Format

```text
cap_v1.<base64url(header)>.<base64url(claims)>.<base64url(hmacSha256Signature)>
```

- **Header:** `{"alg":"HS256","typ":"CAP+JWT","kid":"cap-key-v1"}`
- **Claims:**
  - `version`: `"v1"`
  - `jti`: Unique capability nonce (`cap_<32-hex-chars>`)
  - `sub`: Authenticated actor ID
  - `iss`: `"trellis-capability-authority"`
  - `iat`, `nbf`, `exp`: Epoch seconds
  - `singleUse`: `boolean`
  - `maxUses`: `number`
  - `scope`: `{ action, resourceType?, resourceId?, constraints? }`

## Operational Edge Cases, Retry, and Recovery / Rollback Behavior

### 1. Safe Client Retries via `Idempotency-Key`
When a client retries a request after a network timeout using the same `X-Idempotency-Key` header (or `idempotencyKey` context parameter), `CapabilityTokenService.verify()` recognizes that the token's `jti` was consumed by that exact idempotency key and returns `{ valid: true, consumed: false, idempotentReplay: true }` instead of failing with `TOKEN_ALREADY_CONSUMED`. Presenting the consumed token with a *different* idempotency key (or no idempotency key) is rejected with `409 Conflict` (`TOKEN_ALREADY_CONSUMED`).

### 2. Downstream Failure Rollback (`executeWithCapability` / `releaseConsumption`)
If a downstream service fails *before* committing external side effects (for example, a transient RPC error or database rollback), `executeWithCapability(token, context, fn)` automatically calls `releaseConsumption(jti, idempotencyKey)` to decrement the usage counter. The caller can retry the operation using the same capability token until `exp` is reached.

### 3. Emergency Revocation & Subject Cutoffs
- **Single Token Revocation:** `revokeToken(jti, expiresAtMs, reason)` immediately invalidates a specific capability token and propagates the `jti` to `TokenBlacklistService` when distributed Redis revocation is enabled.
- **Subject-Wide Cutoff:** `revokeSubjectCapabilities(subject, cutoffSeconds)` invalidates all capability tokens issued to `subject` at or before `cutoffSeconds` (e.g., on password change, MFA reset, or compromised session detection).

### 4. Backward Compatibility & Migration
- Existing JWT/API-key guards (`StrategyAuthGuard`, `JwtAuthGuard`, `RolesGuard`) remain unchanged.
- Routes opt into step-up capability enforcement incrementally by applying `@UseGuards(CapabilityTokenGuard)` and `@RequireCapability({ action, resourceType, resourceIdParam })`.

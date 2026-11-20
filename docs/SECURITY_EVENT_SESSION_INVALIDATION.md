# Security-Event Session Invalidation

`src/core/auth/security-session-invalidation/security-event-session-invalidation.ts` provides a focused vertical slice (`invalidateSessionsForSecurityEvent`) that revokes active user sessions in response to security events such as `PASSWORD_CHANGED`, `MFA_DISABLED`, `CREDENTIAL_COMPROMISED`, `PRIVILEGE_ESCALATION`, `ACCOUNT_LOCKED`, `SUSPICIOUS_LOGIN`, and `MANUAL_REVOKE_ALL`.

## Covered Paths

- **Normal path**: Lists active sessions for `event.userId`, revokes each target session with audit metadata (`eventId`, `eventType`, `revokedAt`, `reason`), marks `eventId` as processed for idempotency, and returns `status: "INVALIDATED"`.
- **Retry path**: Transient errors from `listActiveSessions` or `revokeSession` are retried up to `maxAttempts` (default `3`) with exponential backoff (`100 * 2^(attempt - 1)` ms unless `backoffMs` is set). Non-retryable errors (`retryable: false`) stop immediately.
- **Failure path**:
  - If one or more sessions fail revocation after retry exhaustion, the report returns `status: "PARTIAL_FAILURE"` with `failedSessionIds` populated and intentionally does **not** mark `eventId` as processed so a subsequent retry can revoke remaining sessions.
  - Malformed events (missing `eventId`/`userId`, unknown `eventType`, or invalid `occurredAt`) throw `InvalidSecurityEventError` before touching the store.
- **Authorization path**:
  - Privileged actors (`ADMIN`, `SECURITY_OFFICER`, `SYSTEM` by default) may invalidate sessions for any user.
  - Self-service actors (`actor.id === event.userId`) are permitted only when `allowSelfServiceForUser: true` and only for `PASSWORD_CHANGED` or `MANUAL_REVOKE_ALL`.
  - Missing actors, cross-user self-service attempts, or unauthorized roles throw `UnauthorizedSessionInvalidationError` fail-closed.

## Edge Cases

- **High-risk events ignore `excludeSessionId`**: For `CREDENTIAL_COMPROMISED` and `ACCOUNT_LOCKED`, all active sessions are force-revoked even if `excludeSessionId` is supplied.
- **Idempotent replay**: Re-processing an already-completed `eventId` returns `status: "ALREADY_PROCESSED"` with zero store writes.
- **No active sessions**: Returns `status: "NO_ACTIVE_SESSIONS"` and marks `eventId` as processed.

## Recovery and Rollback Behavior

- **Recovery from `PARTIAL_FAILURE`**: Re-invoke `invalidateSessionsForSecurityEvent` with the same `eventId`. Already-revoked sessions are no longer active, so only remaining active sessions are revoked; once all succeed, `eventId` is marked processed.
- **Rollback**: Session revocations are intentional security actions and are not automatically rolled back; affected users re-authenticate to obtain fresh sessions. Reverting the feature itself requires only removing this additive module with no schema migration.

## Contract Preservation

Existing auth services (`AuthService`, `TokenBlacklistService`, `SessionRecoveryService`) and endpoints remain unchanged.

## Automated Tests and Executable Verification

```bash
npx jest src/core/auth/security-session-invalidation/security-event-session-invalidation.spec.ts
node scripts/verify-security-session-invalidation.js
```

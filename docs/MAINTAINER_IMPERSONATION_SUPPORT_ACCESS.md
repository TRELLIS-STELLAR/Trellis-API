# Maintainer Impersonation & Scoped Support Access Architecture

## Overview

Trellis API provides time-bounded, scoped maintainer impersonation and support access governed by an append-only, tamper-evident immutable audit trail. This capability allows authorized operators to diagnose and remediate customer accounts without exposing credentials, executing unauthorized mutations, or bypassing audit controls.

---

## Acceptance Criteria Verification

| Requirement | Implementation Details | Status |
| :--- | :--- | :--- |
| **Scoped Access** | Granular support access scopes (`support:read-only`, `support:portfolio-read`, `support:defi-read`, `support:diagnostics`, `support:full`). Mutations (`POST`, `PUT`, `PATCH`, `DELETE`) are blocked by default by `ImpersonationGuard`. Endpoints can declare `@RequireSupportScope(...)`. | Verified |
| **Automatic Expiration** | Session tokens are bounded (min 5 min, max 240 min, default 60 min). Bounded claims (`expiresAt`, `exp`) are evaluated on every request by `ImpersonationGuard` and `JwtStrategy`. Early termination via `stopImpersonation` revokes the token `jti` in distributed Redis blacklist. | Verified |
| **User-Safe Notices** | Initiating and terminating support access dispatches security notifications to the target user via `NotificationService`. An authenticated user-safe query endpoint (`GET /auth/impersonate/active-notice`) exposes session state without leaking maintainer identities, internal IPs, or secrets. Response header `X-Support-Session` informs client applications. | Verified |
| **Cannot Bypass Audit Logging** | Impersonation start and stop operations execute through `SensitiveActionAuditService.recordSensitiveAction` using `SensitiveAction.IMPERSONATION_STARTED` and `SensitiveAction.IMPERSONATION_STOPPED`. Fails closed if audit recording encounters an error. | Verified |
| **Backwards Compatibility** | Existing `start` and `stop` endpoint contracts and payloads remain backwards compatible. Target user context and token structure remain transparent to existing consumers. | Verified |

---

## Architectural Components

### 1. Scopes (`SupportAccessScope`)

- `support:read-only`: Default least-privilege scope. Permits read-only inspection (`GET`, `HEAD`, `OPTIONS`).
- `support:portfolio-read`: Restricted to reading balances, asset allocations, and holding records.
- `support:defi-read`: Restricted to reading active protocol positions, yield metrics, and liquidity data.
- `support:diagnostics`: Restricted to reading sync status, node latency, and reconciliation logs.
- `support:full`: Unrestricted read access across all support-enabled surfaces.

### 2. Guard Enforcement (`ImpersonationGuard`)

- **Expiration Check**: Validates `user.expiresAt`. If the timestamp is in the past, rejects with `403 Forbidden ("Support access session has expired.")`.
- **Notice Header Injection**: Sets `X-Support-Session: active; scopes=...; expires=...` on the response so client interfaces can render an active support banner.
- **Scope Verification**: Evaluates route metadata declared by `@RequireSupportScope(...)`. If the impersonation token lacks the necessary scope (and does not hold `support:full`), rejects with `403 Forbidden`.
- **Mutation Prevention**: Blocks dangerous HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`) unless exempted by `@AllowImpersonation()`.

### 3. Immutable Hash-Chained Audit Trail

- Impersonation events are committed directly to `sensitive_action_events` via `SensitiveActionAuditService`.
- Each event calculates a deterministic SHA-256 hash chaining to the preceding event's `eventHash` and monotonic sequence.
- Monitored actions:
  - `access.impersonation.started` (`SensitiveAction.IMPERSONATION_STARTED`): Captures maintainer actor ID, target user ID, required operational reason, duration, scopes, ticket ID, and unique `jti`.
  - `access.impersonation.stopped` (`SensitiveAction.IMPERSONATION_STOPPED`): Captures termination event, maintainer ID, and token revocation status.
- Integrity is verifiable at any time via `GET /audit/sensitive-actions/verify-chain`.

### 4. User-Safe Privacy Notices

- **In-App Alerts**: Upon session creation or termination, high-priority `SECURITY` notifications are enqueued for the user.
- **Notice Cleansing**: Internal maintainer emails, operator IPs, and sensitive credentials are stripped from all user-facing notices.
- **Notice Query**: `GET /auth/impersonate/active-notice` returns:
  ```json
  {
    "hasActiveSupportAccess": true,
    "notice": "An authorized support session is active on your account with scopes: support:read-only. Access expires at 2026-10-18T05:30:00.000Z.",
    "session": {
      "scopes": ["support:read-only"],
      "startedAt": "2026-10-18T04:30:00.000Z",
      "expiresAt": "2026-10-18T05:30:00.000Z",
      "ticketId": "SUP-1042"
    }
  }
  ```

---

## Operational Edge Cases & Failure Modes

### 1. Audit Store Unavailability (Fail-Closed)
- **Failure Mode**: The primary database or `SensitiveActionAuditService` experiences an outage, deadlock, or sequence mismatch during `startImpersonation`.
- **Behavior**: Execution immediately throws an exception and aborts. Under no circumstances is a JWT token minted or returned without a confirmed immutable audit event.

### 2. Distributed Token Blacklist Outage
- **Failure Mode**: Redis is temporarily unreachable during `stopImpersonation`.
- **Behavior**: `TokenBlacklistService` logs an error, records the `jti` in its local fallback map, and marks the session terminated in memory. Additionally, the JWT expiration strictly limits maximum residual token lifetime.

### 3. Clock Skew Between Nodes
- **Failure Mode**: API replica system times drift by several seconds or minutes.
- **Mitigation**: Expiration is checked both through standard JWT `exp` validation (with standard clock tolerance) and explicit ISO comparison in `ImpersonationGuard`. Servers must sync with NTP.

### 4. Attempted Impersonation of Administrative Accounts
- **Failure Mode**: An operator attempts to impersonate another admin user.
- **Behavior**: Rejected with `403 Forbidden ("Cannot impersonate another admin")`. Impersonation is strictly restricted to customer/user accounts.

---

## Rollback & Emergency Recovery Procedures

### Emergency Revocation of All Impersonation Sessions
1. Identify suspicious sessions by querying the immutable audit trail:
   ```sql
   SELECT "sequence", "actorId", "resourceId", "metadata", "occurredAt"
   FROM "sensitive_action_events"
   WHERE "action" = 'access.impersonation.started'
     AND "occurredAt" >= NOW() - INTERVAL '4 hours'
   ORDER BY "sequence" DESC;
   ```
2. Invalidate active impersonation tokens across all instances via Redis blacklist:
   ```sh
   redis-cli SET "token-blacklist:<jti>" "1" EX 86400
   ```
3. If widespread key compromise is suspected, rotate `JWT_SECRET` in environment configuration and trigger an application rollout. This terminates all active sessions globally.

### Verifying Chain Integrity Post-Incident
Maintainers can execute chain verification to confirm that no historical impersonation logs were altered or deleted:
```sh
curl -X GET https://api.trellis.internal/audit/sensitive-actions/verify-chain \
  -H "Authorization: Bearer <COMPLIANCE_TOKEN>"
```
Expected response:
```json
{
  "valid": true,
  "verified": 420,
  "brokenAt": null,
  "reason": "Verified 420 events ending at sequence 420"
}
```

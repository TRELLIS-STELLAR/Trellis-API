# Operational Resilience, Permission Auditing & Remediation Architecture

This document specifies the operational guardrails, permission change auditing, error remediation hints, fuzz testing guarantees, and synthetic end-to-end journey monitoring implemented across Trellis-API.

---

## 1. Permission-Diff Report Before Role and Policy Changes (Issue #290)

### Purpose
To prevent accidental privilege escalation, breaking access revocations, or unintended access to sensitive operations, administrators and CI pipelines must generate a `PermissionDiffReport` prior to committing role permission updates or matrix policy changes.

### Capabilities & Risk Levels
- **Role Diff (`generateRoleDiff`)**: Compares current permissions of a role against proposed permissions.
- **User Role Diff (`generateUserRoleDiff`)**: Evaluates the delta when promoting, demoting, or re-assigning roles to a user.
- **Policy Diff (`generatePolicyDiff`)**: Compares matrix policy specifications for global action mappings.
- **Risk Assessment Tiers**:
  - `LOW`: Permissions added/removed within regular standard read operations without sensitive exposure.
  - `MEDIUM`: Policy modifications or revocation of existing active actions.
  - `HIGH`: Privilege escalation detected — granting critical or sensitive actions (e.g. `trade.execute`, `portfolio.optimize`, `kyc.review`).
  - `CRITICAL`: Administrative or security governance access granted (e.g. `user.manage`, `role.assign`, `dr.execute`).
- **Breaking Change Detection**: Identifies whether any currently authorized actions or permissions will be revoked, warning upstream clients before deployment.

### API Endpoint
```http
POST /permissions/diff
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "targetType": "role",
  "targetId": "OPERATOR",
  "proposedPermissions": ["portfolio:read", "portfolio:write", "trade:execute", "user:manage"]
}
```

---

## 2. Stable Error Codes with Documented Remediation Hints (Issue #291)

### Purpose
To provide deterministic, machine-readable contracts and actionable self-service recovery guidance for developers, SDK clients, and operators when API requests fail.

### Response Payload Structure
All HTTP error responses include RFC 9457 Problem Details and a structured `remediationHint` object:
```json
{
  "type": "https://trellis-stellar.github.io/Trellis-API/problems/SETTLEMENT_TIMEOUT",
  "title": "Stellar settlement execution timed out",
  "status": 504,
  "detail": "Stellar Horizon confirmation timed out",
  "instance": "/api/v1/stellar/settlement",
  "remediation": "Horizon confirmation timed out. Verify tx status before retrying.",
  "remediationHint": {
    "action": "Verify transaction confirmation status on Stellar Horizon before retrying",
    "steps": [
      "Do not immediately re-submit transaction to prevent double spending.",
      "Check transaction status on Stellar Horizon using transaction hash.",
      "If unsubmitted, retry with fresh sequence number after 30 seconds."
    ],
    "docUrl": "https://trellis-stellar.github.io/Trellis-API/problems/SETTLEMENT_TIMEOUT",
    "retryable": true,
    "retryAfterSeconds": 30,
    "supportReference": "3f98c4b2-a4f1-4f3b-b26a-9a1d1e43c5b7"
  },
  "statusCode": 504,
  "errorCode": "SETTLEMENT_TIMEOUT",
  "domain": "settlement",
  "message": "Stellar Horizon confirmation timed out",
  "recoveryGuidance": "Horizon confirmation timed out. Verify tx status before retrying.",
  "retryable": true,
  "retryAfterSeconds": 30,
  "correlationId": "3f98c4b2-a4f1-4f3b-b26a-9a1d1e43c5b7",
  "timestamp": "2026-10-18T10:00:00.000Z",
  "path": "/api/v1/stellar/settlement"
}
```

### Public Catalog Endpoint
API consumers and SDK generators can inspect the live catalog at any time:
- `GET /errors/catalog`: Returns all stable error codes, retryability flags, and recovery steps.
- `GET /errors/catalog/:code`: Returns details for a specific error code.

---

## 3. Fuzz Testing Guarantees & Numeric Boundary Values (Issue #292)

### Covered Boundary & Malformed Vectors
1. **Numeric Boundaries**:
   - `0`, `-0`, `+0`: Canonical JSON normalizes `-0` to `0`.
   - `NaN`, `Infinity`, `-Infinity`: Strict rejection with `TypeError` or HTTP 400.
   - `Number.MAX_SAFE_INTEGER` (`9007199254740991`): Safe boundary limit; larger values must be encoded as decimal strings.
   - `0.0000001 XLM`: Minimum valid Stellar stroop unit; smaller fractions are rejected.
2. **Malformed Payloads & Security Defense**:
   - **Prototype Pollution**: `__proto__`, `constructor`, `prototype` injections are rejected without polluting the base `Object.prototype`.
   - **Deep Nesting**: Deeply nested JSON structures (100+ levels) are safely processed without stack overflow crashes.
   - **Null Bytes**: Null bytes (`\0`, `\u0000`) and control characters in text fields are stripped by `SanitizePipe`.
   - **XSS & Script Injection**: Strips `<script>` tags from strings.

---

## 4. Synthetic Journey Monitoring for Critical Happy Paths (Issue #293)

### Overview
The **Synthetic Journey Monitor** (`SyntheticJourneyMonitorService`) runs automated, proactive probe journeys across Trellis API's core pipeline:
1. `step_auth_verify` (Auth & session creation) — Budget: 300ms
2. `step_portfolio_rebalance` (Portfolio target allocation check) — Budget: 500ms
3. `step_defi_yield` (DeFi protocol yield discovery) — Budget: 700ms
4. `step_settlement_reconcile` (Stellar ledger settlement matching) — Budget: 600ms
5. `step_notification_dispatch` (Notification alert emission) — Budget: 400ms

### Root-Cause Dependency Blame
Failures and SLA violations are attributed to specific upstream subsystems:
- `POSTGRES_DB`: Connection pool exhaustion or query lock timeouts.
- `REDIS_CACHE`: Cache miss spikes or connection drop.
- `STELLAR_HORIZON`: Rate limiting (429) or gateway timeout (504).
- `DEFI_PROTOCOL_RPC`: Node provider rate limits or timeouts.
- `NOTIFICATION_GATEWAY`: WebSocket ingress drop or broker backlog.
- `AUTH_SERVICE`: JWT verification failures.

### Endpoints
- `GET /monitoring/synthetic/status`: Fetches latest execution report and blame diagnostics.
- `POST /monitoring/synthetic/run`: Triggers on-demand execution (returns 200 on healthy/degraded, 503 on critical dependency failure).

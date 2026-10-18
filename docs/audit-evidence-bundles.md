# Privacy-Preserving Audit Evidence Bundles for Support Investigations

## 1. Overview & Objective

When customer support, platform operators, or compliance officers investigate user disputes, transactional anomalies, DeFi rebalance failures, or security incidents, they require forensic evidence that proves system behavior without violating user privacy or leaking critical secrets.

The **Privacy-Preserving Audit Evidence Bundle** subsystem generates an exportable, tamper-evident manifest compiling multi-domain telemetry across:
- **Authentication & Authorization** (logins, sessions, token issuance, permission changes)
- **Portfolio Operations** (allocation updates, rebalance events, deposits, withdrawals)
- **DeFi Protocol Adapters** (Soroban/Aave/Compound interactions, contract invocations, transaction hashes)
- **Notification Deliveries** (delivery logs, channels, delivery statuses, deep links, deduplication keys)
- **Observability & Request Tracing** (correlation IDs, status categories, latency quantiles, error taxonomy)
- **Audit Trails & Sensitive Actions** (tamper-evident hash chain verification, before/after states)

Every evidence bundle is cryptographically sealed with a canonical SHA-256 hash and signed via HMAC-SHA256 using the platform's `AUDIT_EXPORT_SIGNING_KEY`.

---

## 2. Privacy Preservation Boundaries

To comply with GDPR, CCPA, and Trellis financial data protection policies, evidence bundles enforce strict data redaction and pseudonymisation boundaries.

### 2.1 Classification Matrix

| Data Category | Field / Pattern | Handling in Evidence Bundle | Rationale |
| :--- | :--- | :--- | :--- |
| **Secrets & Keys** | Stellar secret seeds (`S[A-Z2-7]{55}`) | Replaced with `[REDACTED_STELLAR_SECRET]` | Never exported; eliminates risk of key compromise. |
| **Authentication Tokens** | Bearer JWTs, session tokens, passwords, API keys | Replaced with `[REDACTED_JWT]` or `[REDACTED_TOKEN]` | Prevents credential theft through support tickets. |
| **Personal Identifiable Info (PII)** | Email addresses (`user@domain.com`) | Replaced with `[email]` or pseudonymized HMAC hash | Prevents identity leakage across external ticketing tools. |
| **Network & Location** | IPv4 / IPv6 addresses | Subnet-masked (e.g. `192.168.xxx.xxx`) + keyed `ipHash` | Prevents geolocation tracking while allowing event correlation. |
| **Device Fingerprints** | User-Agent strings | Categorized into coarse client types (`web`, `mobile`, `bot`) | Eliminates device and hardware tracking fingerprints. |
| **Forensic Identifiers** | Stellar public keys (`G...`), Tx Hashes (`[a-f0-9]{64}`) | **Preserved intact** | Necessary to verify on-chain ledger confirmation. |
| **Financial State** | Asset codes (`XLM`, `USDC`), decimal amounts | **Preserved intact** (e.g. `100.0000000`) | Necessary to verify balance movements and trade execution. |
| **Timestamps & Latency** | ISO-8601 timestamps, latency metrics in ms | **Preserved to millisecond precision** | Verifies chronological ordering and temporal monotonicity. |
| **Contract Invariants** | Error categories, HTTP status, route templates | **Preserved normalized** (e.g. `/:uuid/assets`) | Bounds route cardinality and confirms error taxonomy. |

---

## 3. Evidence Bundle Schema & Structure

Evidence bundles conform to the `trellis.audit.evidence-bundle.v1` schema:

```json
{
  "manifest": {
    "schemaVersion": "trellis.audit.evidence-bundle.v1",
    "bundleId": "c3f28b7e-9a01-4c5d-6e7f-8a9b0c1d2e3f",
    "caseId": "CASE-2026-9042",
    "generatedAt": "2026-10-17T20:20:00.000Z",
    "generatedBy": {
      "actorId": "usr_compliance_001",
      "actorType": "maintainer",
      "actorRole": "compliance_officer",
      "actorHash": "actor_9cc3bcab9450390c"
    },
    "scope": {
      "caseId": "CASE-2026-9042",
      "subjectUserId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "fromDate": "2026-10-10T00:00:00.000Z",
      "toDate": "2026-10-17T00:00:00.000Z",
      "categories": ["auth", "portfolio", "defi", "notifications", "observability", "audit_trail"]
    },
    "totalRecords": 42,
    "recordsByDomain": {
      "auth": 5,
      "portfolio": 12,
      "defi": 8,
      "notifications": 4,
      "observability": 6,
      "audit_trail": 7
    },
    "retentionHoldApplied": true,
    "chainVerification": {
      "valid": true,
      "verifiedCount": 7,
      "brokenAt": null
    },
    "redactionSummary": {
      "redactedFieldsCount": 18,
      "scrubbedPatternsCount": 4,
      "pseudonymizedActorsCount": 6,
      "appliedRules": [
        "stellar_secret_scrubbing",
        "jwt_token_redaction",
        "ip_subnet_masking",
        "user_agent_normalization",
        "keyed_actor_pseudonymisation"
      ]
    }
  },
  "evidence": {
    "authEvidence": [],
    "portfolioEvidence": [],
    "defiEvidence": [],
    "notificationEvidence": [],
    "observabilityEvidence": [],
    "auditTrailEvidence": []
  },
  "integrity": {
    "bundleHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "signature": "3b29ef58a012c8e3b4a2f1c8d7e9b0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
    "signingAlgorithm": "HMAC-SHA256",
    "verified": true
  }
}
```

---

## 4. API Endpoints

### 4.1 Generate Evidence Bundle
- **Endpoint:** `POST /api/v1/audit-trail/evidence-bundles/generate`
- **Auth:** Bearer JWT (`ADMIN`, `KYC_OPERATOR`)
- **Request Body:**
  ```json
  {
    "caseId": "CASE-2026-9042",
    "subjectUserId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "fromDate": "2026-10-10T00:00:00.000Z",
    "toDate": "2026-10-17T00:00:00.000Z",
    "categories": ["auth", "portfolio", "defi", "notifications", "observability", "audit_trail"],
    "placeRetentionHold": true,
    "reason": "Customer dispute regarding automated portfolio rebalance slippage"
  }
  ```
- **Responses:**
  - `201 Created`: Returns signed `EvidenceBundle`.
  - `400 Bad Request`: Missing `caseId` or invalid date range.
  - `403 Forbidden`: Caller lacks compliance officer / admin privileges.

### 4.2 Verify Evidence Bundle
- **Endpoint:** `POST /api/v1/audit-trail/evidence-bundles/verify`
- **Auth:** Bearer JWT (`ADMIN`, `KYC_OPERATOR`)
- **Request Body:**
  ```json
  {
    "bundle": { ... }
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "valid": true,
    "bundleId": "c3f28b7e-9a01-4c5d-6e7f-8a9b0c1d2e3f",
    "caseId": "CASE-2026-9042",
    "recomputedBundleHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "signatureValid": true,
    "hashChainValid": true,
    "temporalMonotonicityValid": true,
    "errors": [],
    "verifiedAt": "2026-10-17T20:25:00.000Z"
  }
  ```

---

## 5. Operational Edge Cases

1. **Clock Skew & Temporal Monotonicity:**
   - Distributed systems can suffer from NTP clock drift. The verification engine accommodates up to a 60-second forward threshold for server timestamp differences. Any event with a timestamp further in the future is flagged as a temporal consistency violation.
2. **High-Volume Telemetry Truncation:**
   - Deep log searches cap domain collections at 200 items per category to protect API memory and prevent denial-of-service. Total record counts and truncation markers are explicitly recorded in `manifest.recordsByDomain`.
3. **Rotating Daily Salts:**
   - Actor pseudonymisation salts rotate at 00:00 UTC daily (`AUDIT_EVIDENCE_SALT_SEED` + date). This prevents longitudinal tracking of actors while guaranteeing deterministic pseudonymization within the same investigation day.
4. **Retention Hold Interaction:**
   - When `placeRetentionHold: true` is set, matching audit log records receive `auditCaseId: caseId` and `retentionHold: true` metadata. The scheduled retention job (`AuditLogService.enforceRetention`) automatically skips records tagged with active dispute or case IDs.

---

## 6. Failure Modes & Mitigations

| Failure Mode | Symptoms | Root Cause | Operator Mitigation |
| :--- | :--- | :--- | :--- |
| **Missing Signing Key** | `500 Internal Server Error` on generate / verify | `AUDIT_EXPORT_SIGNING_KEY` not configured in environment | Supply key via secret manager or `.env.secrets`. |
| **Tampered Bundle Content** | `verifyBundle()` reports `valid: false` with hash mismatch | Evidence file edited in transit or storage | Reject bundle as untrusted; re-export bundle from primary audit store. |
| **Broken Hash Chain** | `verifyBundle()` reports `hashChainValid: false` | Out-of-band edit or deletion of a sensitive action event | Run `GET /audit-trail/sensitive-actions/integrity` to locate sequence gap. |
| **Database Unavailable** | Empty evidence slices with warning logs | Network partition or DB connection exhaustion | Retry bundle generation once database connectivity is restored. |

---

## 7. Rollback & Recovery Procedures

### 7.1 Revoking Compromised Evidence Bundles
If an exported evidence bundle or the signing key is suspected of being compromised:
1. Rotate `AUDIT_EXPORT_SIGNING_KEY` in environment secrets.
2. Invalidate all previously issued bundles using the rotated key.
3. Record a sensitive action `AUDIT_LOG_EXPORTED` with reason `bundle_revoked` specifying the compromised `bundleId`.

### 7.2 Releasing Retention Holds
Once a support case or dispute is resolved:
1. Update audit log metadata removing the `auditCaseId` tag.
2. The records will automatically become eligible for normal 7-year retention cleanup during the next scheduled run.

### 7.3 Disaster Recovery Verification
Run the automated evidence bundle verification suite:
```bash
npm run verify:evidence-bundles
```
Confirm that all 10 invariant checks pass without errors.

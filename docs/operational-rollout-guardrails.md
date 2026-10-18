# Operational Rollout Guardrails & Resilience Architecture

This document outlines the operational specifications, safety guardrails, and rollback procedures implemented in Trellis-API across caching, concurrency, data export, and feature rollouts.

---

## 1. Bounded Cache with Explicit Invalidation and Stale Detection (Issue #294)

### Overview
`BoundedCache<T>` provides in-memory LRU caching with strict capacity bounds, dual-TTL freshness/stale detection, and explicit invalidation mechanics.

### Key Capabilities
- **Capacity Bounds & LRU Eviction**: Caps maximum entries (`maxEntries`), evicting the least-recently used key when capacity is exceeded.
- **Stale Detection & SWR Refresh (`getOrRevalidate`)**:
  - `ttlMs`: Period during which data is strictly fresh.
  - `staleTtlMs`: Extended grace period where stale data can be returned immediately while an asynchronous background revalidation occurs.
  - Prevents cache stampede / thundering herd via in-flight singleflight promise deduplication.
- **Explicit Invalidation**:
  - `invalidate(key)`: Invalidate a specific key.
  - `invalidateTag(tag)`: Invalidate all cache entries associated with a domain tag (e.g., `oracle:price`, `user:profile`).
  - `invalidatePrefix(prefix)`: Invalidate hierarchical namespaces.
  - `invalidateStaleVersion(minVersion)`: Flush entries below a specific monotonic version counter.

### Metrics & Observability
- Exposes `getStats()`: `hits`, `misses`, `staleHits`, `evictions`, and current `size`.

---

## 2. Concurrency Control: Duplicate Submissions & Stale Versions (Issue #295)

### Overview
`ConcurrencyExecutor` prevents race conditions, duplicate submissions, and version conflicts under high contention.

### Key Capabilities
- **Duplicate Submission Deduplication (`executeIdempotent`)**:
  - Synchronous in-flight deduplication: Simultaneous duplicate requests with the same idempotency key join the first execution promise.
  - Result retention with TTL: Cached response returned for replay requests within the idempotency window.
- **Optimistic Locking Retry Loop (`executeWithRetry`)**:
  - Catches `VersionConflictError` / optimistic lock collisions.
  - Retries with configurable exponential backoff and jitter (`maxRetries`, `baseDelayMs`, `maxDelayMs`).
  - Detects exhausted retries and surfaces actionable error diagnostics.

---

## 3. Privacy-Safe Export with Field-Level Authorization (Issue #296)

### Overview
`PrivacyExportAuthorizer` guarantees zero-leakage data exports by enforcing field-level sensitivity classifications and role-based masking.

### Sensitivity Classifications
1. `PUBLIC`: Accessible to all roles without masking.
2. `RESTRICTED_PII`: Masked for general roles (`USER`), unmasked for `COMPLIANCE_OFFICER` and `ADMIN`.
   - Email: `a***@domain.com`
   - Phone: `+1 ***-***-1234`
   - IP Address: `192.168.***.***`
3. `CONFIDENTIAL_FINANCIAL`: Masked for standard roles, visible to `AUDITOR` and `ADMIN`.
   - Account numbers / Stellar Secret Keys / Balances.
4. `FORBIDDEN_SECRET`: **Unconditionally stripped** across all export profiles (e.g., password hashes, private keys, API secrets, session tokens).

### Matrix
| Role | Public Fields | Restricted PII | Confidential Financial | Forbidden Secrets |
|---|---|---|---|---|
| `USER` | Plaintext | Masked | Masked / Redacted | Stripped |
| `AUDITOR` | Plaintext | Masked | Plaintext | Stripped |
| `COMPLIANCE_OFFICER` | Plaintext | Plaintext | Masked / Redacted | Stripped |
| `ADMIN` | Plaintext | Plaintext | Plaintext | Stripped |

---

## 4. Feature Rollout Guardrails with Emergency Disablement (Issue #297)

### Overview
`FeatureRolloutService` and `FeatureRolloutGuard` govern canary releases, progressive rollouts, allowlists, and immediate emergency mitigation.

### Rollout Mechanics
- **Deterministic Canary Hashing**: Uses SHA-256 hash of `featureKey:userId` modulo 100 to deterministically evaluate percentages (0–100%). Ensures consistent user experience across sessions.
- **User & Role Allowlists**: VIP users and internal roles (e.g., `ADMIN`, `BETA_TESTER`) can access features ahead of general rollout.
- **Automated Circuit Breaking**:
  - Automatically counts consecutive errors per feature via `recordError(key, error)`.
  - Trips kill switch when `consecutiveErrors >= maxErrorThreshold` (default: 5).
  - Resets on successful executions via `recordSuccess(key)`.

### Emergency Operations & Runbook

#### 1. Triggering Emergency Kill Switch
To immediately kill an active feature across all users and allowlists:
```typescript
featureRolloutService.emergencyDisable(
  "instant-settlement-v2",
  "High error rate detected in Horizon transaction submission",
  "SecOps / OnCall",
);
```
- Sets `emergencyDisabled = true` and `enabled = false`.
- Any endpoint guarded with `@RequireFeature("instant-settlement-v2")` immediately throws `503 Service Unavailable`.

#### 2. Recovery & Canary Restoration
Once a fix is deployed, safely resume via low-percentage canary:
```typescript
featureRolloutService.liftEmergencyDisable(
  "instant-settlement-v2",
  "IncidentCommander",
  5, // resume at 5% canary
);
```
- Clears the emergency disabled flag.
- Resets consecutive error counters to 0.
- Re-enables allowlisted users for verification before increasing percentage.

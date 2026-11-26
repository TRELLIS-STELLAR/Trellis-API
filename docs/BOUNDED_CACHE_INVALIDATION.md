# Bounded Cache Invalidation and Stale Detection (#562, #486)

## Overview

The Bounded Cache subsystem (`src/common/cache`) provides an in-memory, memory-bounded LRU cache with explicit invalidation rules, stale-while-revalidate (SWR) stale detection, graceful degraded-mode serving, and atomic rollback snapshots.

High-frequency API reads (such as Stellar asset metadata, oracle rates, and exchange rates) require aggressive caching without risking memory leaks or serving dangerously expired state. The bounded cache provides strict capacity constraints, deterministic age-based stale detection, and instantaneous emergency rollback capabilities.

---

## Key Capabilities

### 1. Bounded Invalidation (`invalidateBounded`)
- Supports invalidation by single key, prefix, tag, and minVersion.
- Enforces safety caps (`maxKeysToInvalidate`, default 5,000) to protect the application against accidental mass cache eviction.
- Generates an atomic `InvalidationSnapshot` containing the evicted entries, their tags, and TTL metadata.

### 2. Rollback & Recovery (`rollbackInvalidation`)
- Allows operators to restore invalidated entries from a previous snapshot.
- Restores original tags, TTL windows, and versions with zero data corruption.

### 3. Stale Detection & Inspection (`detectStaleEntries`)
- Audits active cache entries and categorizes each as `fresh`, `stale`, or `expired`.
- Calculates entry age, remaining fresh TTL, and remaining stale TTL.
- Generates actionable maintenance recommendations (e.g., background pre-warming, immediate eviction).

### 4. Resilient Revalidation & Degraded Serving (`getOrRevalidateWithRetry`)
- Employs exponential backoff retries when fetching fresh data from downstream sources.
- **Degraded Stale Fallback**: If all retries fail but a stale cached entry exists within its `staleUntil` window, the cache serves the stale value with `degraded: true` rather than surfacing a hard outage to clients.

---

## Operational Execution Paths

- **Normal Path**: Bounded key/prefix/tag invalidation, structured receipt with snapshot, stale detection audit, and atomic restoration.
- **Failure Path**: Fails fast on empty criteria, blank prefixes/tags, or when matching keys exceed `maxKeysToInvalidate`.
- **Retry Path**: Recovers from transient upstream failures via exponential backoff; gracefully falls back to serving stale content if downstream is completely unavailable.
- **Authorization Path**: Restricts invalidation and rollback operations strictly to callers with `ADMIN` or `MAINTAINER` roles (`ForbiddenException` / 403).

---

## Edge Cases, Recovery, and Rollback Behavior

- **Downstream Outage**: When third-party oracles or Stellar RPC nodes experience outages, the cache continues to serve stale records within `staleUntil` windows, annotating responses with `degraded: true`.
- **Accidental Mass Eviction**: If an operator mistakenly invalidates an active prefix, `rollbackInvalidation` re-inserts the atomic snapshot without needing a database rebuild.
- **Memory Boundary**: When cache reaches `maxEntries`, LRU eviction safely purges the oldest unaccessed entries.

---

## Compatibility & Migration Plan

- **Preservation of Existing Cache Layer**: Fully compatible with existing Redis and in-memory caches.
- **Zero Breaking Changes**: Opt-in features for endpoints requiring strict bounded guarantees.

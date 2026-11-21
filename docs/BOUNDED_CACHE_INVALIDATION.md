# Bounded Cache Invalidation and Stale Detection (#486)

## Overview

The Bounded Cache subsystem provides an in-memory, memory-bounded LRU cache with explicit invalidation rules, stale-while-revalidate (SWR) stale detection, graceful degraded-mode serving, and atomic rollback snapshots.

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

## Paths Covered

- **Normal Path**: Bounded key/prefix/tag invalidation, structured receipt with snapshot, stale detection audit, and atomic restoration.
- **Failure Path**: Fails fast on empty criteria, blank prefixes/tags, or when matching keys exceed `maxKeysToInvalidate`.
- **Retry Path**: Recovers from transient upstream failures via exponential backoff; gracefully falls back to serving stale content if downstream is completely unavailable.
- **Authorization Path**: Restricts invalidation and rollback operations strictly to callers with `ADMIN` or `MAINTAINER` roles (`ForbiddenException` / 403).

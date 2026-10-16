# Stale-Cache and Stale-Index Detection with Automated Repair Recommendations (#244)

## Overview
Distributed search indexes (e.g. Elasticsearch) and caching layers can desynchronize from the primary transactional database (PostgreSQL) due to transient network failures, unhandled exceptions during mutations, or out-of-order event delivery.

`StaleIndexDetectorService` provides automated detection, drift calculation, and multi-tier repair recommendations for Trellis-API:

1. **Discrepancy Categorization**:
   - `MISSING_IN_INDEX`: Entity is active in the database but absent in the search index or cache.
   - `ZOMBIE_IN_INDEX`: Entity was soft-deleted or revoked in PostgreSQL but persists in Elasticsearch or cache, risking data leakage or stale search hits.
   - `CONTENT_MISMATCH`: Divergence in core searchable fields (e.g., `title`, `content`, `visibility`).
   - `ORPHANED_CACHE_ENTRY`: Key exists in cache with no valid underlying DB record.

2. **Automated Drift Metrics**:
   - Calculates total checked DB records, index hits, discrepancy count, and drift ratio (`discrepancyCount / totalDbRecords`).
   - Classifies risk severity from `LOW` to `CRITICAL`.

3. **Graduated Repair Recommendations**:
   - **Critical / Severe Drift (> 25% drift or > 100 entries)**: Recommends `FULL_REINDEX` via atomic rebuild (`searchService.repairIndex()`).
   - **Moderate Drift (8% - 25% drift)**: Recommends `BATCH_REINDEX` scoped to affected partitions.
   - **Targeted / Isolated Drift (< 8%)**: Recommends `INLINE_PURGE` for zombies and `INLINE_SYNC` for missing/divergent documents to minimize database and Elasticsearch load.

4. **Safe Execution**:
   - Supports `--dry-run` to audit and preview impact before applying mutations.
   - Live execution with error boundaries and detailed audit report tracking.

## Architecture
- `src/search/stale-detection.types.ts`: Core models for discrepancy items, severity levels, repair actions, and audit reports.
- `src/search/stale-index-detector.service.ts`: Detection scanner, recommendation engine, and repair runner.
- `src/search/stale-index-detector.service.spec.ts`: Unit test suite verifying discrepancy identification, recommendation thresholds, dry-runs, and live executions.

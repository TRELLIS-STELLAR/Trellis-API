# Resource budget regression checks

The blocking `Build and TypeScript Check` workflow runs
`src/search/asset-search.resource-budget.spec.ts`. It models an authenticated
user with 10,000 searchable assets, and an extension-unavailable typo search
with 5,000 possible candidates. The explicit deterministic budgets are:

| Resource | Ceiling | Reason |
| --- | ---: | --- |
| Asset search response page | 50 rows | `MAX_ASSET_SEARCH_LIMIT`; the database query uses the same page bound. |
| In-process typo-ranking candidates | 250 rows | `ASSET_SEARCH_CANDIDATE_WINDOW`; bounds per-request JS ranking and memory when PostgreSQL fuzzy extensions are unavailable. |
| SQL statements in a full structured page | 1 search query | A filled exact/prefix page skips the tolerant query and its extension probe. |

To run the same budget check locally after dependencies are installed:

```sh
npm test -- --runInBand src/search/asset-search.resource-budget.spec.ts
```

These checks enforce row-count/query-count ceilings, not wall-clock latency,
heap bytes, PostgreSQL plan quality, or Elasticsearch cost. The repository does
not currently provide a stable database fixture for those measurements. The
fixtures model the database applying the query's requested `take` limit; a
real deployment should also monitor query latency and inspect `EXPLAIN
(ANALYZE, BUFFERS)` with representative data.

## Edge cases and recovery

- When `pg_trgm` or `fuzzystrmatch` cannot be used, search falls back to the
  bounded 250-row candidate window. This keeps local work bounded but can omit
  a better typo match beyond that window. An operator can restore the SQL path
  by applying the existing fuzzy-search extension migration with a role that
  has the required database privileges.
- Raising either ceiling can increase response size, database work, and/or
  per-request memory. Lowering them can reduce recall or page size. Change the
  service constants and this budget spec together, then observe database and
  API metrics before deploying the new limit.
- To roll back this contribution, revert the targeted workflow step, spec,
  documentation, and exported candidate-window constant. The change does not
  alter public API schemas, persisted data, or runtime defaults.

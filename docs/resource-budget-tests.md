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

The spec had stopped loading: an import cycle (`portfolio-asset.entity` ->
`portfolio.entity` -> `transaction.entity` -> `portfolio-asset.entity`) left
the `Chain` enum undefined when `transaction.entity` ran its decorators. `Chain`
now lives in `entities/chain.enum.ts` and is re-exported from
`portfolio-asset.entity`, so existing imports are unchanged.

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

## Worst-case input budgets (#345)

`src/testing/worst-case-inputs.resource-budget.spec.ts` adds deterministic
budgets for code that sits on every request, log line or ledger verification
and receives caller- or chain-controlled input. Each budget counts work, using
property-read counters and proxies, and bounds output size. None of them
measures wall-clock time, so they do not flake on slow CI runners.

| Path | Worst-case input | Ceiling | Constant |
| --- | --- | ---: | --- |
| Log/body sanitisation | 50,000-key object | 100 values visited; the rest is summarised as `[TRUNCATED_KEYS]: n` | `MAX_OBJECT_KEYS` |
| Log/body sanitisation | 1,000,000-element array | 50 elements read | `MAX_ARRAY_LENGTH` |
| Log/body sanitisation | 10,000 levels of nesting | depth 8, no stack overflow | `MAX_DEPTH` |
| Log/body sanitisation | 5 MB string | 4,096 chars + marker | `MAX_STRING_LENGTH` |
| Error messages | 5 MB pathological text (credential pairs, hex run, JWT and seed near-misses) | 8,192 chars + marker; regexes scan at most 8,192 chars | `MAX_ERROR_MESSAGE_LENGTH` |
| Request URLs | 1 MB query string | cut on a parameter boundary | `MAX_STRING_LENGTH` |
| Telemetry redaction | 100,000 levels of nesting | depth 32, no stack overflow (previously threw `RangeError`) | `MAX_REDACTION_DEPTH` |
| Correlation header | 16 MB `x-correlation-id` | O(1) length check before the pattern; replaced by a UUID | `MAX_CORRELATION_ID_LENGTH` |
| Correlation header | 10,000 repeated values | the first value only | - |
| Oracle event scan | 10,000 events in one transaction | refused with `EVENT_SCAN_LIMIT` before any event is read | `MAX_CONTRACT_EVENTS_PER_TRANSACTION` (100) |
| Oracle event decode | 10,000-field data tuple | refused with `EVENT_DATA_TOO_LARGE` before any element is read | `MAX_ORACLE_EVENT_DATA_FIELDS` (16) |

The spec found one real defect while it was being written: truncating
*before* redacting let redaction grow the output past the cap, and a secret cut
at the boundary could leave its visible half behind, no longer matching the
pattern. `redactBounded` now drops the token that straddles the cut, redacts
what remains, then caps the output. A dedicated case places a JWT at several
offsets around the cap.

Run locally:

```sh
npm test -- --runInBand resource-budget
```

### Edge cases and recovery

- Truncated log values end in `...[TRUNCATED n chars]`, and wide objects carry
  a `[TRUNCATED_KEYS]` count. Log queries that need the full payload should use
  the source record, not the log line.
- An unbroken token longer than the cap (no whitespace) is replaced entirely
  by `[REDACTED]`, because it cannot be shown safely in part.
- `EVENT_SCAN_LIMIT` and `EVENT_DATA_TOO_LARGE` are retryable, so the
  submission is deferred, not rejected. If a legitimate contract release ever
  exceeds them, raise the constant together with this table and the spec.
- Rollback: revert the constants and spec. No data or API schema depends on
  them.

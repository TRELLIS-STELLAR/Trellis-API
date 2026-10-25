# Database isolation for E2E specs

Use `withDatabaseTransaction(dataSource, body)` for one-off database-backed
flows, or `installTransactionIsolation(dataSource, { beforeEach, afterEach })`
for a suite. The harness creates a dedicated TypeORM query runner, starts a
`READ COMMITTED` transaction before the spec, passes its manager to the test,
and always rolls it back and releases the runner afterward.

Tests must obtain repositories from the provided manager (or pass that manager
through the service under test). This keeps inserted rows invisible to later
specs, permits parallel workers to use separate connections, and removes the
need for destructive table truncation. Rollback also runs when the spec throws,
so a failed test cannot pollute the next run.

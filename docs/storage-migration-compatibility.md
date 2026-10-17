# Storage migration compatibility check

The API exposes a read-only operator endpoint for checking whether the database's TypeORM migration history is compatible with the migration chain shipped by the running application build.

## Endpoint

`GET /ops/storage/migration-compatibility`

Authentication is required. The minimum role is `OPERATOR`; the normal role hierarchy also permits `MAINTAINER` and `ADMIN`.

This is an internal operations endpoint and is intentionally excluded from the public Swagger/OpenAPI document and generated client SDKs. The endpoint never runs, reverts, or edits a migration. It only reads TypeORM's migration history and compares it with timestamp-prefixed migration files discovered from the same locations used by `src/config/typeorm.config.ts` (`src/migrations/*` and nested `**/migration/*`).

## Statuses

- `up-to-date`: the applied migration history exactly matches the migration chain in this build.
- `upgrade-ready`: the applied history is an exact prefix of the migration chain. `nextVersion` identifies the next migration and `pendingVersions` lists the remaining ordered path.
- `incompatible`: compatibility cannot be proven. This includes unknown, skipped, reordered or duplicate migration timestamps, a database that is ahead of the running build, and an empty application migration manifest.

An empty *readable* migration history is `upgrade-ready` from the first known migration. If the migration history table itself is missing or unreadable, the check fails instead of assuming an empty database.

## Failure and retry behavior

Transient PostgreSQL/connection failures (for example serialization failures, deadlocks, lock contention and reset/timed-out connections) are retried up to three total attempts with a small bounded backoff. Permanent failures are not retried. If history still cannot be read safely, the API returns HTTP `503` rather than reporting a compatible schema.

This check deliberately fails closed and does not inspect or mutate application tables. Operators should still execute migrations through the existing TypeORM CLI/deployment workflow after reviewing the pending chain.

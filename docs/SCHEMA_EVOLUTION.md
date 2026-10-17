# Schema evolution guardrails

Trellis API uses the global Nest validation pipe to reject unknown request
fields with `400 Bad Request`; it does not silently discard them. Persisted
records that use `applyReadTransforms` must carry a valid semantic
`schemaVersion`. The transform registry applies only a registered `fromVersion`
range, stamps each transformed step with its `toVersion`, and refuses missing,
malformed, or future versions with `UnsupportedRecordSchemaVersionError`.

## Adding a schema version

1. Add a compatibility test for the old shape and the new canonical shape.
2. Register a read transform with the exact source range and target version.
   Keep each transform idempotent where possible and avoid mutating its input.
3. Keep writing the current version. Deploy readers that understand both the
   current version and the prior version before changing any writer.
4. Add the migration note and recovery plan to this document and the relevant
   feature runbook. Do not reuse a version number for a different shape.
5. When the old version is no longer supported, remove its transform only after
   stored rows have been migrated and the migration has been verified.

## Failure and rollback behavior

- Missing, invalid, or unsupported stored versions fail closed instead of being
  passed through as current data. Treat this as a migration/compatibility error;
  do not overwrite the stored record automatically.
- Unknown request fields fail validation. For a renamed or removed field, add a
  documented deprecation window and an explicit DTO compatibility path before
  removing it from a public API version.
- If a migration fails, stop the writer rollout, retain the original data, and
  restore from the verified database backup. Roll back application code only
  after confirming the previous release can read the migrated records or after
  restoring the pre-migration snapshot.
- API URI versions remain independently versioned (`/api/v1/...`, `/api/v2/...`).
  A persisted-record transform does not change the public response contract.

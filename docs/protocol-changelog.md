# Machine-readable protocol changelog

> Tracks every change to an HTTP route, WebSocket/GraphQL surface, configuration key, or
> operator command so callers can discover what an upgrade does to them without reading prose.

Issue: [#352](https://github.com/TRELLIS-STELLAR/Trellis-API/issues/352) /
[#126](https://github.com/TRELLIS-STELLAR/Trellis-API/issues/126)

---

## Quick reference

| Concern | Where |
|---|---|
| Changelog file | `changelog/protocol-changes.json` |
| JSON Schema | `changelog/schema/protocol-changes.schema.json` |
| Validator script | `npm run changelog:validate` |
| Runtime endpoint | `GET /changelog/protocol` |
| Service | `src/changelog/protocol-changelog.service.ts` |
| Controller | `src/changelog/changelog.controller.ts` |
| Types | `src/changelog/protocol-changelog.types.ts` |

---

## Endpoint

### `GET /changelog/protocol`

No authentication required (`@Public()`). The `StrategyAuthGuard` reads
`IS_PUBLIC_KEY` from the controller class and returns `true` without checking
a token.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `since` | semver string | Return only entries with `version > since`. Callers pin the version they run and learn what an upgrade would do. |
| `impact` | enum[] | One or more of `breaking`, `deprecation`, `compatible`, `fix`, `security`. |
| `status` | `released` \| `unreleased` | Filter by release state. |

**Response shape**

```jsonc
{
  "schemaVersion": "1.0.0",
  "project": "trellis-api",
  "generatedAt": "2026-09-27T12:00:00.000Z",
  "latestVersion": "0.2.0",
  "highestImpact": "compatible",  // worst impact in the returned set
  "migrationRequired": false,      // true when any entry forces caller action
  "affectedPaths": ["/changelog/protocol", "/health/dependencies"],
  "entries": [ /* ProtocolChangeEntry[] newest first */ ]
}
```

---

## Normal path

1. `ProtocolChangelogService.onModuleInit()` reads and validates
   `changelog/protocol-changes.json` on first start.
2. The document is cached in memory for the life of the process.
3. `GET /changelog/protocol` returns a filtered view with no database or network I/O.

---

## Failure path

| Failure | Behaviour |
|---|---|
| File missing | `loadProtocolChangelog` throws `Unable to read … at <path>`. The module logs the error but does not crash. Subsequent `getDocument()` calls re-throw until the file is restored and `reload()` is called. |
| File not valid JSON | Same as above; error message contains `is not valid JSON`. |
| File invalid (schema or semantic) | `validateProtocolChangelog` returns a violations array; `loadProtocolChangelog` throws listing every rule that was broken. |
| Schema version mismatch | Rejected with `unsupported-schema-version`. Upgrade the schema and re-run `npm run changelog:validate` before deploying. |

The endpoint never returns a partial or unchecked document. Either it serves the
last fully validated snapshot or the process logs an error at start-up.

---

## Retry / reload path

`ProtocolChangelogService.reload()` lets an operator hot-swap the changelog
file without restarting the process, e.g. after a hotfix deploy:

```bash
# 1. Edit / regenerate the changelog.
npm run changelog:validate

# 2. Send a reload signal to the running process.
#    (Exact mechanism depends on your runtime: SIGHUP handler, admin endpoint, etc.)
```

**Rollback guarantee**: if the new file fails validation, `reload()` throws and
the previous in-memory document is preserved. Callers continue to get the last
known-good responses until the file is corrected.

```
reload() called
  ├── loadProtocolChangelog() succeeds → cache replaced, new doc returned
  └── loadProtocolChangelog() throws  → previous doc retained, error re-thrown
```

---

## Authorization path

The `GET /changelog/protocol` endpoint is intentionally unauthenticated:

- `ChangelogController` carries `@Public()` at the class level.
- `StrategyAuthGuard.canActivate()` reads `IS_PUBLIC_KEY` and returns `true`
  without inspecting any `Authorization` header.
- No `@Roles()`, `@Permissions()`, or `KycGuard` annotations are present on
  the controller or its handler.

This means **any client, including callers with no account**, can discover what
protocol changes exist before deciding whether to upgrade. Sensitive operational
data (e.g. migration steps) is designed to be public; do not add secrets to
changelog entries.

---

## Validator

```bash
# Validate the committed changelog (used by CI):
npm run changelog:validate

# Validate a different file:
npm run changelog:validate -- --file changelog/__fixtures__/breaking-entry.json

# Machine-readable output for pipeline scripts:
npm run changelog:validate -- --json

# Pin the clock (deterministic CI):
npm run changelog:validate -- --now 2026-09-27T12:00:00Z
```

Exit codes: `0` = valid, `1` = semantic violations, `2` = unreadable or
non-JSON file.

The script and the runtime API share `validateProtocolChangelog()`, so a
file that passes the script cannot fail at runtime.

---

## Semantic rules

| Rule | When triggered |
|---|---|
| `breaking-without-description` | `impact: "breaking"` with no `breakingChanges` |
| `breaking-without-migration` | `impact: "breaking"` with `migration.required: false` |
| `migration-without-steps` | `migration.required: true` but `steps` is empty |
| `migration-step-not-actionable` | A step does not end with `.` |
| `deprecation-removal-not-after-version` | `removalVersion ≤ entry.version` |
| `deprecation-without-impact` | `deprecations` present but `impact` is not `deprecation` or `breaking` |
| `http-surface-without-method` | `kind: "http"` surface with no `method` |
| `surface-without-path` | HTTP/WebSocket/GraphQL surface with no `path` |
| `surface-without-key` | `kind: "config"` surface with no `key` |
| `duplicate-surface` | Same `kind + method + path` appears twice in one entry |
| `untraceable-entry` | No `relatedIssues` and no `relatedPullRequests` |
| `duplicate-entry` | Same `version + title` appears more than once |
| `entries-out-of-order` | Entries are not sorted newest first |
| `date-not-a-calendar-date` | `date` is not a real calendar day (e.g. `2026-02-30`) |
| `date-in-the-future` | `date` is more than one day ahead of the current UTC date |
| `unsupported-schema-version` | `schemaVersion` is not the version this build understands |

---

## Edge cases and recovery

### Deployment with a broken changelog

If `changelog/protocol-changes.json` is accidentally committed in an invalid
state, `onModuleInit` logs the error but **does not crash** the process. The
endpoint will throw until the service is hot-reloaded or restarted with a
corrected file. The `changelog:validate` CI step catches this before it reaches
production.

### Clock skew

The validator allows one day of tolerance for future-dated entries
(`FUTURE_DATE_TOLERANCE_DAYS = 1`). Entries marked `status: "unreleased"` are
expected to carry the date they are expected to ship; the rule is only enforced
once they are more than 24 hours into the future.

### CHANGELOG_PATH override

Set `CHANGELOG_PATH` to an absolute path or a path relative to the repository
root to point the service at a non-default file. Both the validator script and
the runtime read the same variable.

```bash
CHANGELOG_PATH=/var/trellis/protocol-changes.json npm run start:prod
```

### Rollback

If a release introduces a changelog entry that must be reverted:

1. Remove or revert the entry in `changelog/protocol-changes.json`.
2. Run `npm run changelog:validate` to confirm the file is still valid.
3. Deploy the reverted file. If the process is already running, trigger
   `reload()` (or restart the process).

The file is append-only by convention. Do not change the `status` of an
existing `released` entry; add a new entry with `impact: "fix"` or
`impact: "breaking"` and a migration block instead.

### Contract preservation

The response shape is versioned with `schemaVersion`. Consumers must check
`schemaVersion` before deserializing. Additive fields (new optional properties)
do not increment the schema version. Field removal or type changes require a
`schemaVersion` bump and a changelog entry with `impact: "breaking"`.

---

## Testing

```bash
# Unit + integration specs (validator + service + controller):
npx jest src/changelog --runInBand

# Executable validation (no Jest, exits non-zero on any violation):
npm run changelog:validate

# Full test suite:
npm test
```

Tests cover:

- Normal query path (unfiltered, `since`, `impact`, `status` filters)
- Failure path (missing file, non-JSON, invalid file)
- Retry / reload path (successful reload, rollback on failure, recovery after bad start)
- Authorization path (`@Public()` metadata present, guard bypasses auth, unauthenticated controller call succeeds)
- Structural schema rules (missing fields, unknown fields, bad enums, bad semver)
- Semantic rules (breaking changes, migrations, deprecations, surfaces, ordering, traceability)

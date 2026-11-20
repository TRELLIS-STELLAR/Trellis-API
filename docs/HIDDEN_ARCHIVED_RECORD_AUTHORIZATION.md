# Hidden and Archived Record Authorization

`src/common/authorization/record-visibility/record-visibility-auth.ts` provides a focused vertical slice (`evaluateRecordAccess`, `filterVisibleRecords`, `fetchAuthorizedRecord`) and test suite for enforcing fail-closed authorization on `ACTIVE`, `HIDDEN`, and `ARCHIVED` records.

## Access Matrix

| Visibility | Action | Allowed Actors | Denied Status |
| --- | --- | --- | --- |
| `ACTIVE` | `READ`, `LIST` | Same-tenant authenticated users, `ADMIN` | `401` (unauth), `404` (cross-tenant) |
| `ACTIVE` | `UPDATE` | Owner, `ADMIN` | `403` |
| `HIDDEN` | `READ`, `LIST` | `ADMIN`, `AUDITOR`, `MODERATOR` (owner only if `allowOwnerReadHidden: true`) | `404` (masked) / `403` |
| `HIDDEN` | `UPDATE`, `RESTORE` | `ADMIN`, `MODERATOR` | `404` (masked) / `403` |
| `ARCHIVED` | `READ`, `LIST` | `ADMIN`, `AUDITOR`, Owner (unless `allowOwnerReadArchived: false`) | `404` (masked) / `403` |
| `ARCHIVED` | `UPDATE` | None (immutable while archived) | `403` |
| `ARCHIVED` | `RESTORE` | `ADMIN` | `404` (masked) / `403` |

## Covered Paths

- **Normal path**: Authorized reads, list filtering, and admin restore actions succeed with `200`.
- **Authorization path**: Unauthenticated callers receive `401` before any store fetch; unauthorized or cross-tenant callers receive `404` by default (`maskUnauthorizedAsNotFound: true`) to prevent existence leakage of hidden/archived records.
- **Retry path**: `fetchAuthorizedRecord` retries transient store errors up to `maxAttempts` (default `3`) with exponential backoff before evaluating visibility policy.
- **Failure path**: Missing records return `404`, non-retryable fetch errors fail fast, and retry exhaustion surfaces the underlying error.

## Edge Cases

- **Existence masking**: Returning `404` instead of `403` prevents unauthorized callers from probing whether a hidden or archived record ID exists.
- **Archived immutability**: `UPDATE` is rejected with `403` even for `ADMIN`; the record must be restored first.
- **Cross-tenant isolation**: Non-admin actors cannot read or list records belonging to another tenant regardless of visibility state.

## Recovery and Rollback Behavior

- Authorization evaluation is pure and stateless; transient read failures can be safely retried.
- To restore an accidentally hidden or archived record, an authorized `ADMIN` (or `MODERATOR` for `HIDDEN`) invokes `RESTORE`.
- Reverting this feature requires only removing this additive module with no schema or contract changes.

## Contract Preservation

Existing guards, controllers, and entity schemas remain untouched.

## Automated Tests and Executable Verification

```bash
npx jest src/common/authorization/record-visibility/record-visibility-auth.spec.ts
node scripts/verify-hidden-archived-authorization.js
```

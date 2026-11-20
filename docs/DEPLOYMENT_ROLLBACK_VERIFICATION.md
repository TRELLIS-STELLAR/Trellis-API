# Deployment Rollback Verification Checks

`runDeploymentRollbackVerification` provides a focused post-rollback verification gate in `src/monitoring/deployment-rollback/deployment-rollback.ts`. After a deployment is rolled back from `fromVersion` to `toVersion`, the verifier probes version, health, schema, dependency, and authorization checks before allowing traffic to resume (`canResumeTraffic`).

## Covered Paths

- **Normal path**: Every required check succeeds and `version` checks report `observedVersion === toVersion` (or `check.expectedVersion`). Returns `allPassed: true` and `canResumeTraffic: true`.
- **Retry path**: Transient probe failures (e.g., HTTP `503` during pod warm-up) and thrown probe errors are retried up to `maxAttempts` (default `3`) with exponential backoff (`100 * 2^(attempt - 1)` ms unless `backoffMs` is overridden).
- **Failure path**:
  - Exhausting retries on any required check sets `allPassed: false`, `canResumeTraffic: false`, and populates `remediation`.
  - Non-retryable failures (`retryable: false`) and version mismatches fail fast without wasting retry attempts.
  - Optional checks (`required: false`) increment `warnings` and add remediation notes without blocking `canResumeTraffic`.
- **Authorization paths**:
  - **Operator RBAC**: When `requireAuthorizedActor: true` or `actor` is supplied, the runner verifies the actor has an allowed role (`ADMIN` or `RELEASE_MANAGER` by default) before executing any probes, throwing `UnauthorizedRollbackVerificationError` on failure.
  - **Endpoint fail-closed probing**: For checks with `kind: "authorization"`, `requireAuthFailClosed: true`, or when `probeAuthorization: true` is set, the runner issues an unauthenticated probe (`authorizationProbe: true`) and requires `ok: false` with HTTP `401` or `403`.

## Edge Cases

- **No-op rollback**: Rejected upfront if `fromVersion === toVersion`.
- **Rollback did not take effect**: If a `version` check returns HTTP `200` with `observedVersion === fromVersion`, the check fails immediately and emits remediation instructing operators to re-apply `toVersion`.
- **Missing observed version**: A `version` check that omits `observedVersion` fails fast instead of passing blindly.
- **Invalid inventory**: Empty `deploymentId`, `environment`, `checks`, or duplicate check names are rejected before any probe runs.

## Recovery and Rollback Behavior

- Keep traffic drained whenever `canResumeTraffic` is `false`.
- Follow the generated `remediation` entries (e.g., re-apply the `toVersion` artifact, repair schema state, or restore auth guards) and re-run `runDeploymentRollbackVerification`.
- The verifier is stateless and read-only; re-running it does not mutate deployment or database state and requires no data rollback of its own.

## Contract Preservation

This vertical slice is additive and introduces no breaking changes to existing APIs, `runDeploymentSmokeTests`, or `RollbackVerificationService`.

## Automated Tests and Executable Verification

Run the Jest unit suite:

```bash
npx jest src/monitoring/deployment-rollback/deployment-rollback.spec.ts
```

Run the standalone executable verification script:

```bash
node scripts/verify-deployment-rollback.js
```

# Deployment smoke tests

`runDeploymentSmokeTests` provides the deployment gate for every initialized account or contract address. The caller supplies the address inventory and a probe that performs a read-only health check. Every entry is checked, transient failures are retried with exponential backoff, and required entries fail the report when attempts are exhausted.

Set `probeAuthorization: true` to verify that the same address endpoint rejects an unauthenticated request with HTTP 401 or 403. This keeps the normal, retry, failure, and authorization paths in one executable report without writing chain state.

A deployment should stop when `allPassed` is false. Retry the deployment after restoring the failed dependency. If a release must be rolled back, use the previous deployment artifact; the smoke runner has no persistent state and requires no data rollback.

The unit suite covers all initialized entries, transient recovery, exhausted failures, authorization fail-closed behavior, and duplicate inventory detection:

```bash
npx jest src/monitoring/deployment-smoke/deployment-smoke.spec.ts
```

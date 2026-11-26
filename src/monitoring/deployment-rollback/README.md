# Deployment Rollback Verification

## Quick Start

```typescript
import { DeploymentRollbackIntegrationService } from './deployment-rollback-integration';

// 1. Build rollback target
const target = service.buildStandardProductionTarget(
  'deploy-2024-01-15-01',
  '2.1.0', // from version (failed)
  '2.0.5'  // to version (rollback target)
);

// 2. Define actor (requires RELEASE_MANAGER or ADMIN role)
const actor = {
  id: 'ops-user-1',
  roles: ['RELEASE_MANAGER'],
};

// 3. Run verification
const report = await service.verifyRollback(target, envConfig, actor);

// 4. Check results
if (report.canResumeTraffic) {
  console.log('✅ Rollback verified. Safe to resume traffic.');
  await resumeTraffic();
} else {
  console.error('❌ Rollback verification FAILED. Do NOT resume traffic.');
  report.remediation.forEach(r => console.error(`  ${r}`));
}
```

## Check Types

### 1. Version Check
Verifies deployed version matches rollback target.

```typescript
{
  name: 'api-version',
  kind: 'version',
  expectedVersion: '2.0.5', // Optional: defaults to target.toVersion
}
```

### 2. Health Check
Ensures service is healthy and ready to serve traffic.

```typescript
{
  name: 'health-check',
  kind: 'health',
}
```

### 3. Schema Check
Validates database schema compatibility.

```typescript
{
  name: 'db-schema-version',
  kind: 'schema',
}
```

### 4. Dependency Check
Verifies external service connectivity.

```typescript
{
  name: 'stellar-horizon-connectivity',
  kind: 'dependency',
  required: true, // Default: true
}

{
  name: 'cache-warmup',
  kind: 'dependency',
  required: false, // Warning only, doesn't block traffic
}
```

### 5. Authorization Check
Verifies auth guards fail closed (reject unauthenticated requests).

```typescript
{
  name: 'admin-authorization',
  kind: 'authorization',
  requireAuthFailClosed: true, // Expects 401/403 without auth
}
```

## Rollback Targets

### Standard Production (7 checks)

```typescript
const target = service.buildStandardProductionTarget(
  deploymentId,
  fromVersion,
  toVersion
);

// Includes:
// - api-version
// - health-check
// - db-schema-version
// - stellar-horizon-connectivity
// - redis-connectivity
// - admin-authorization (fail-closed)
// - cache-warmup (optional)
```

### Staging (3 checks)

```typescript
const target = service.buildStagingRollbackTarget(
  deploymentId,
  fromVersion,
  toVersion
);

// Includes:
// - api-version
// - health-check
// - db-schema-version
```

### Custom Target

```typescript
const customTarget: RollbackTarget = {
  deploymentId: 'deploy-2024-01-15-01',
  fromVersion: '2.1.0',
  toVersion: '2.0.5',
  environment: 'production',
  checks: [
    { name: 'api-version', kind: 'version' },
    { name: 'custom-health', kind: 'health' },
    { name: 'feature-flag-rollback', kind: 'dependency' },
  ],
};
```

## Verification Report

```typescript
interface RollbackVerificationReport {
  deploymentId: string;
  fromVersion: string;
  toVersion: string;
  environment: string;
  
  // Summary
  allPassed: boolean;           // All required checks passed
  canResumeTraffic: boolean;    // Safe to resume traffic
  passed: number;               // Count of passed checks
  failed: number;               // Count of failed checks
  warnings: number;             // Count of optional check failures
  
  // Detailed results
  results: RollbackCheckResult[];
  
  // Remediation steps for failures
  remediation: string[];
  
  // Timestamp
  verifiedAt: string;
}
```

## Example Report

### ✅ Successful Verification

```json
{
  "deploymentId": "deploy-2024-01-15-01",
  "fromVersion": "2.1.0",
  "toVersion": "2.0.5",
  "environment": "production",
  "allPassed": true,
  "canResumeTraffic": true,
  "passed": 6,
  "failed": 0,
  "warnings": 1,
  "results": [
    {
      "name": "api-version",
      "kind": "version",
      "required": true,
      "ok": true,
      "attempts": 1,
      "status": 200,
      "observedVersion": "2.0.5"
    },
    {
      "name": "cache-warmup",
      "kind": "dependency",
      "required": false,
      "ok": false,
      "attempts": 3,
      "status": 503,
      "error": "Cache cold"
    }
  ],
  "remediation": [
    "[cache-warmup] Check failed after 3 attempt(s): Cache cold."
  ],
  "verifiedAt": "2024-01-15T12:00:00.000Z"
}
```

### ❌ Failed Verification

```json
{
  "deploymentId": "deploy-2024-01-15-01",
  "fromVersion": "2.1.0",
  "toVersion": "2.0.5",
  "environment": "production",
  "allPassed": false,
  "canResumeTraffic": false,
  "passed": 5,
  "failed": 2,
  "warnings": 0,
  "results": [
    {
      "name": "api-version",
      "kind": "version",
      "required": true,
      "ok": false,
      "attempts": 1,
      "status": 200,
      "observedVersion": "2.1.0",
      "error": "Version mismatch for 'api-version': expected '2.0.5', observed '2.1.0'"
    },
    {
      "name": "admin-authorization",
      "kind": "authorization",
      "required": true,
      "ok": false,
      "attempts": 1,
      "status": 200,
      "authorizationVerified": false,
      "error": "Authorization probe did not fail closed (expected 401 or 403)"
    }
  ],
  "remediation": [
    "[api-version] Deployment is still running failed version '2.1.0'. Re-apply rollback artifact '2.0.5' before resuming traffic.",
    "[admin-authorization] Endpoint failed to reject unauthenticated request. Verify auth guards/middleware before resuming traffic."
  ],
  "verifiedAt": "2024-01-15T12:00:00.000Z"
}
```

## Edge Cases

### 1. Version Mismatch (Rollback Not Applied)

```
❌ Deployment is still running failed version '2.1.0'
→ Re-apply rollback artifact before resuming traffic
```

### 2. Authorization Bypass

```
❌ Admin endpoint did not reject unauthenticated request
→ Verify auth guards are active before resuming traffic
```

### 3. Transient Failures

Automatic retry with exponential backoff:
- Attempt 1: 0ms delay
- Attempt 2: 100ms delay
- Attempt 3: 200ms delay

### 4. Optional Check Failures

Optional checks (required: false) generate warnings but don't block traffic.

## CI/CD Integration

### GitHub Actions

```yaml
name: Rollback and Verify

on:
  workflow_dispatch:
    inputs:
      deployment_id:
        required: true
      from_version:
        required: true
      to_version:
        required: true

jobs:
  rollback:
    runs-on: ubuntu-latest
    steps:
      - name: Apply Rollback
        run: |
          kubectl set image deployment/api \
            api=trellis/api:${{ inputs.to_version }}
          kubectl rollout status deployment/api

      - name: Verify Rollback
        run: |
          npm run rollback:verify -- \
            --deployment-id ${{ inputs.deployment_id }} \
            --from-version ${{ inputs.from_version }} \
            --to-version ${{ inputs.to_version }} \
            --environment production \
            --actor ${{ github.actor }}

      - name: Resume Traffic
        if: success()
        run: |
          # Update load balancer weights
          # Remove maintenance page
          # Enable auto-scaling
```

### GitLab CI

```yaml
rollback_verify:
  stage: verify
  script:
    - npm run rollback:verify -- 
        --deployment-id $CI_PIPELINE_ID
        --from-version $FAILED_VERSION
        --to-version $ROLLBACK_VERSION
        --environment production
        --actor $GITLAB_USER_LOGIN
  only:
    - rollback

resume_traffic:
  stage: deploy
  script:
    - ./scripts/resume-traffic.sh
  needs:
    - rollback_verify
  when: on_success
```

## Monitoring

```typescript
import { Counter, Histogram } from 'prom-client';

const verificationCounter = new Counter({
  name: 'rollback_verifications_total',
  help: 'Total rollback verifications',
  labelNames: ['environment', 'passed', 'deployment_id'],
});

const checkDuration = new Histogram({
  name: 'rollback_check_duration_ms',
  help: 'Duration of individual rollback checks',
  labelNames: ['check_name', 'check_kind', 'ok'],
  buckets: [100, 500, 1000, 5000, 10000],
});
```

## Alerting

```typescript
async function alertOnRollbackFailure(report: RollbackVerificationReport) {
  if (!report.canResumeTraffic) {
    await sendAlert({
      severity: 'critical',
      title: `Rollback verification FAILED: ${report.deploymentId}`,
      description: `${report.failed} check(s) failed. Traffic NOT resumed.`,
      environment: report.environment,
      fromVersion: report.fromVersion,
      toVersion: report.toVersion,
      remediation: report.remediation,
      correlationId: report.deploymentId,
    });
  }
}
```

## Authorization

Only users with these roles can execute rollback verification:
- `ADMIN`
- `RELEASE_MANAGER`

```typescript
const actor = {
  id: 'dev-user-1',
  roles: ['DEVELOPER'],
};

// Throws UnauthorizedRollbackVerificationError
await service.verifyRollback(target, envConfig, actor);
```

## Troubleshooting

### Version check fails despite correct version

**Cause**: Load balancer caching stale responses  
**Solution**: Add cache-busting query params or wait for cache TTL

### Authorization check passes incorrectly

**Cause**: Auth middleware not enforcing fail-closed  
**Solution**: Fix auth guards before resuming traffic (security issue)

### Transient failures exhaust retries

**Cause**: Service warming up  
**Solution**: Increase retry attempts or add warm-up period

### All checks timeout

**Cause**: Service not reachable  
**Solution**: Verify network connectivity and service deployment

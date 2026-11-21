# Permission-Diff Preview Before Policy Changes (#482)

## Overview

The permission-diff preview engine provides read-only simulation and security impact analysis before committing role, user, or matrix-level policy changes across the Trellis API. It prevents accidental privilege escalations, detects breaking access revocations, and supplies an atomic rollback snapshot and instructions before changes are applied.

## Architecture & Core Endpoints

### 1. `POST /permissions/diff`
- Evaluates diffs for `targetType`: `"role" | "user" | "policy"`.
- Backward compatible with existing role and user diff contracts.
- Generates categorized action sets: `addedActions`, `removedActions`, and `modifiedActions`.

### 2. `POST /permissions/policy/preview`
- Restricted to `ADMIN` and `MAINTAINER` roles.
- Returns `PolicyChangePreviewResult` containing:
  - `dryRun: true`: Guarantees zero mutation to active system matrix during preview.
  - `unlockedActionsPerRole` & `revokedActionsPerRole`: Per-role impact assessment.
  - `riskAssessment`: `riskLevel` ("LOW" | "MEDIUM" | "HIGH" | "CRITICAL"), privilege escalation detection, and sensitive action tracking.
  - `rollbackPlan`: Deterministic SHA-256 snapshot digest and recovery matrix.
  - `previewToken`: SHA-256 hash coupling current state and proposed changes to assert freshness before commit.

## Paths Covered

- **Normal Path**: Evaluates proposed permission matrices, detecting additions, removals, per-role action shifts, and generates a rollback plan with deterministic preview tokens.
- **Failure Path**: Fails fast on malformed inputs, empty action strings, unknown roles, or duplicate actions (`BadRequestException`).
- **Authorization Path**: Fails closed if caller lacks `ADMIN` or `MAINTAINER` role (`ForbiddenException` / 403).
- **Retry Path**: `previewPolicyChangesWithRetry` retries transient storage or remote matrix fetch errors with exponential backoff before preview generation.

## Edge Cases & Rollback Behavior

1. **Admin Demotion Breaking Changes**: Accurately evaluates previous admin privileges against proposed user permissions to detect revoked actions that would lock administrative workflows.
2. **Atomic Rollback Snapshot**: The preview output includes `rollbackPlan.snapshotMatrix` and `snapshotStateDigest`. In the event an applied policy causes unexpected regressions, operators can restore the exact prior matrix using the digest.
3. **Contract Preservation**: All existing decorators, guard interfaces, and role definitions remain intact with 100% backward compatibility.

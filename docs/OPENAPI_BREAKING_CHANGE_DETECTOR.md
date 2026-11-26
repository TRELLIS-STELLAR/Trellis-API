# OpenAPI Schema Breaking-Change Detector & Client SDK Smoke Gate (#531)

## Overview

The OpenAPI Schema Breaking-Change Detector and Client SDK Smoke Gate module (`src/common/contract/openapi-drift.ts`, `scripts/check-openapi-drift.ts`, `src/monitoring/deployment-smoke`) provides automated structural contract comparison, breaking change classification, and client SDK smoke test gating to prevent breaking API regressions in the Trellis ecosystem.

In distributed microservice and client SDK architectures, inadvertent changes to API endpoints, request schemas, or response envelopes can silently break mobile apps, external partners, and automated trading bots. This subsystem ensures all controller decorator modifications are structurally validated against the committed OpenAPI specification (`docs/openapi.json`) prior to merge and deployment.

---

## Architectural Workflow

```text
PR / Release Pipeline
       │
       ▼
[ Controller Decorator Analysis ]
       │
       ▼
[ Canonical Structural Normalization ] ──► (Sorts object keys recursively, preserves array order)
       │
       ▼
[ Diff Engine vs docs/openapi.json ]
       ├── Added Paths / Operations ──► Compatible (Requires npm run openapi:export)
       ├── Modified Parameters / Schemas ──► Evaluated for Breaking Changes
       └── Removed Paths / Operations ──► Breaking (Fails Smoke Gate)
       │
       ▼
[ Client SDK Smoke Gate ]
       ├── Mock SDK Client Invocation against Endpoints
       └── Assert 200 OK / Structured Response Envelope
```

### Breaking vs. Compatible Classifications

| Change Type | Impact | Classification | Gate Behavior |
|---|---|---|---|
| New Path or HTTP Method | Non-breaking | Compatible | Pass (Warning to export spec) |
| Optional Request Field Added | Non-breaking | Compatible | Pass |
| Path or HTTP Method Removed | Breaking | Incompatible | Reject (Gate Failure) |
| New Required Parameter Added | Breaking | Incompatible | Reject (Gate Failure) |
| Response Field Type Altered | Breaking | Incompatible | Reject (Gate Failure) |
| Component Schema Deleted | Breaking | Incompatible | Reject (Gate Failure) |

---

## Operational Execution Paths

### 1. Normal Path
- Live controller definitions match `docs/openapi.json` exactly.
- `diffOpenApiDocuments` returns `{ drifted: false, addedPaths: [], removedPaths: [], ... }`.
- Client SDK smoke test initializes client bindings, executes test probes, and passes with 100% success.

### 2. Failure Path
- If a route is removed (e.g., removing `POST /api/v1/import/execute`), or a required property is added to an existing request DTO:
  - The detector catches the discrepancy and returns `drifted: true`.
  - The report lists specific `removedPaths`, `removedOperations`, or schema member diffs.
  - The CI smoke gate exits with status code `1`, blocking the pull request or release.

### 3. Retry Path
- If an intentional contract modification was made:
  - The developer runs `npm run openapi:export` to update `docs/openapi.json`.
  - Running the drift detector again confirms 0 drift and passes the smoke gate.

### 4. Authorization Path
- Security definitions (`securitySchemes`, `bearerAuth`, `apiKeyAuth`) are structurally enforced.
- Endpoints requiring authentication cannot silently drop security requirements in the schema.
- Unauthenticated requests during client SDK smoke testing are rejected with HTTP 401/403.

---

## Edge Cases, Recovery, and Rollback Behavior

- **Formatting & Key-Order Noise**: Key order, indentation variations, or CRLF vs LF line endings do not trigger false drift. Canonical sorting normalizes representations before comparison.
- **Rollback Behavior**: If a deployment fails post-merge, restoring the previous `docs/openapi.json` and controller artifacts restores full contract compatibility without data corruption.
- **Client SDK Compatibility**: Deprecated fields are annotated with `deprecated: true` for at least one major release cycle before removal.

---

## Compatibility & Migration Plan

- **Zero Breaking Changes**: Existing external consumers continue to receive consistent API contracts.
- **Contract Drift Pre-commit Hook**: Developers receive instant feedback during local verification before pushing changes.

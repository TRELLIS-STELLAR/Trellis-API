# Bulk Import Pipeline with Dry-Run Validation, Quarantine, and Rollback Guidance

## 1. Overview

The Trellis API bulk import pipeline provides a transactional, idempotent, and memory-efficient (`O(N)` linear processing with `O(1)` index lookups) interface for ingesting portfolio holdings, assets, and configuration data.

### Key Guarantees
1. **Zero-Side-Effect Dry Run:** The dry run mode (`dryRun: true`) evaluates schema rules, foreign key integrity, duplicate collisions, and generates diff previews with **zero persistent database writes**.
2. **External ID Idempotency:** Providing an `externalId` enables idempotent re-imports. Existing records are updated in place rather than duplicated.
3. **Quarantine of Unsafe Rows:** Rows that fail shape or semantic validation are isolated into a `quarantined` envelope with stable reason codes. They are never written to the database.
4. **Atomic Transaction Boundary:** Live imports run within atomic transactions. If any row fails validation and `allowPartial: false`, the entire transaction is rolled back. If a write fails mid-batch, already-applied writes are compensated.
5. **Traceability:** Every accepted row is reported in the preview with its `externalId`, action, and before/after snapshot. Every committed batch returns a `transactionId` and affected record IDs.
6. **Actionable Rollback Guidance:** In the event of errors or post-import remediation needs, the response contains structured rollback instructions with exact entity IDs and compensation steps.

---

## 2. API Endpoints

### 2.1 Dry-Run Validation (`POST /api/v1/import/validate`)
Validates a batch and returns a preview of what changes would occur. This endpoint always runs in dry-run mode regardless of the `dryRun` flag in the payload.

### 2.2 Live Execution (`POST /api/v1/import/execute`)
Executes the batch against the repository. Responds with HTTP 201 on success and HTTP 400 with an `IMPORT_REJECTED` body when the batch is rejected atomically.

### Request Payload
```json
{
  "entityType": "PORTFOLIO_ASSETS",
  "dryRun": true,
  "rows": [
    {
      "portfolioId": "b1a2c3d4-0000-0000-0000-000000000001",
      "symbol": "XLM",
      "amount": 5000.0,
      "currentPrice": 0.145,
      "targetAllocation": 50.0,
      "externalId": "ext-asset-001"
    },
    {
      "portfolioId": "b1a2c3d4-0000-0000-0000-000000000001",
      "symbol": "USDC",
      "amount": 2500.0,
      "currentPrice": 1.0,
      "targetAllocation": 50.0,
      "externalId": "ext-asset-002"
    }
  ],
  "options": {
    "updateExisting": true,
    "allowPartial": false
  }
}
```

### Response (200 OK)
```json
{
  "dryRun": true,
  "entityType": "PORTFOLIO_ASSETS",
  "totalRows": 2,
  "createCount": 2,
  "updateCount": 0,
  "skipCount": 0,
  "errorCount": 0,
  "isSuccess": true,
  "preview": [
    {
      "rowIndex": 1,
      "externalId": "ext-asset-001",
      "action": "CREATE",
      "summary": "Create new asset \"XLM\" under portfolio b1a2c3d4-0000-0000-0000-000000000001",
      "after": {
        "symbol": "XLM",
        "amount": 5000.0,
        "currentPrice": 0.145,
        "targetAllocation": 50.0
      }
    }
  ],
  "quarantined": [],
  "errors": [],
  "executionTimeMs": 42
}
```

---

## 3. Error Handling and Remediation

### Common Error Types

Quarantined rows carry stable reason codes (`IImportQuarantineReason`):

| Error Code | Condition | Cause | Remediation |
| :--- | :--- | :--- | :--- |
| **MISSING_REQUIRED_FIELD** | Required field absent | `rowIndex` lacks `portfolioId`. | Supply the missing field and re-submit the row. |
| **INVALID_SYMBOL** | Symbol fails format rule | `symbol` is empty or contains unsupported characters. | Normalize the symbol to 1-12 uppercase alphanumeric characters. |
| **INVALID_TYPE** | Wrong type or format | A field has an unexpected type (e.g. `amount` is a string). | Coerce or correct the value to the expected type. |
| **OUT_OF_BOUNDS** | Numeric value out of range | `amount < 0` or `targetAllocation > 100`. | Normalize numerical fields to valid domain ranges. |
| **DUPLICATE_EXTERNAL_ID** | Duplicate key within batch or existing record | The same `externalId` appeared more than once, or exists with `updateExisting: false`. | Consolidate duplicate rows or assign distinct external IDs. |
| **MISSING_FOREIGN_KEY** | Referenced entity missing | The `portfolioId` does not exist in the database. | Create the target portfolio prior to importing assets. |

### Partial Import & Rollback Guidance
When an import commits with `allowPartial: true` (or when maintainers need to roll back live changes), the `rollbackGuidance` envelope provides:
```json
{
  "rollbackGuidance": {
    "transactionId": "9fa8c12b-3456-4789-abcd-0123456789ab",
    "snapshotTimestamp": "2026-09-26T13:00:00.000Z",
    "affectedRecordIds": ["pa-001", "pa-002"],
    "remediationSteps": "To revert created records, execute DELETE FROM portfolio_assets WHERE id IN ('pa-001', 'pa-002');",
    "rollbackInstructions": "If this live batch needs to be rolled back manually, utilize the affected record IDs listed above."
  }
}
```

---

## 4. Operational Edge Cases and Failure Modes

| Edge Case | Behavior | Recovery |
| :--- | :--- | :--- |
| Empty payload or zero rows | Request rejected with `HTTP 400 EMPTY_IMPORT_PAYLOAD`. | Include at least one row. |
| Batch larger than 1000 rows | Request rejected with `HTTP 400 IMPORT_BATCH_TOO_LARGE`. | Split the payload into chunks of ≤1000 rows. |
| Unsupported `entityType` | Request rejected with `HTTP 400 UNSUPPORTED_ENTITY_TYPE`. | Use a supported entity type (currently `PORTFOLIO_ASSETS`). |
| Database write fails mid-batch | Previously applied writes are compensated (deletes for creates, restore for updates). Response is an error. | Retry the batch after investigating the underlying repository error. Compensation failures are logged with record IDs. |
| Repeated `externalId` across batches with `updateExisting: true` | Idempotent update in place. | No action needed; the previous values are reported in `preview[x].before`. |
| Repeated `externalId` with `updateExisting: false` | Row quarantined with `DUPLICATE_EXTERNAL_ID`. | Enable `updateExisting` or use a distinct external ID. |
| Concurrent imports targeting the same `externalId` | Last write wins; the before snapshot in the preview may be stale. | Use the `transactionId` and `snapshotTimestamp` to correlate and replay if necessary. |

### Rollback Procedure
1. Capture the `transactionId` and `affectedRecordIds` from the import response.
2. For created records, delete by ID as described in `remediationSteps`.
3. For updated records, restore the `preview[x].before` snapshot for each affected ID.
4. Re-run `POST /api/v1/import/validate` with the corrected payload to confirm the preview is clean before re-issuing `/execute`.

### Retry Path
- Retry only after addressing quarantined rows. Re-run `validate` to confirm the preview is clean.
- For transient repository failures, retry the entire batch with exponential backoff; the pipeline is idempotent when `externalId` is provided.
- Never retry a rejected batch without changes — the same quarantined rows will fail again.
# Migration Rollback, Deterministic Ordering & Data Reliability Architecture

This document specifies the operational guardrails, deterministic event ordering, rare failure fixture generators, safe ownership transfers, and post-rollback verification protocols implemented in Trellis-API.

---

## 1. Deterministic Sorting for Mixed-Status Records and Events (Issue #286)

### Purpose
To eliminate pagination drift, duplicate records across page boundaries, and non-deterministic results when sorting mixed-status events or batch-arriving records.

### Multi-Tiered Comparator Hierarchy
`DeterministicSorter` applies a 4-tier sorting evaluation:
1. **Status Priority Hierarchy**: Active/urgent statuses (`CRITICAL` -> `RETRYING` -> `PROCESSING` -> `PENDING`) are prioritized before terminal statuses (`COMPLETED` -> `FAILED` -> `CANCELLED` -> `EXPIRED`). Custom maps are supported.
2. **Timestamp / Sequence**: Normalizes ISO-8601 strings, millisecond Epoch values, or monotonic sequences.
3. **Deterministic Tie-Breaker**: Lexicographical comparison of unique identifiers (`id` / UUID).
4. **Opaque Cursors**: Encodes compound sort states into URL-safe base64 cursors (`encodeCursor` / `decodeCursor`) for drift-free cursor pagination.

### Usage Example
```typescript
import { DeterministicSorter } from "src/common/sorting";

const paginated = DeterministicSorter.paginate(events, {
  limit: 20,
  cursor: req.query.cursor,
  options: {
    sortFields: [
      { field: "status", isStatus: true, direction: "ASC" },
      { field: "createdAt", direction: "DESC" },
    ],
    tieBreakerField: "id",
  },
});
```

---

## 2. Fixture Generators for Rare Failure & Recovery Paths (Issue #287)

### Purpose
Provides reproducible test fixtures and simulation seeds for rare edge cases that are difficult to trigger in staging environments:

- **Ledger Reorganization (`generateLedgerReorg`)**: Simulates deep chain re-orgs with orphaned transactions and diverging block hashes.
- **Nonce / Sequence Collision (`generateNonceCollision`)**: Simulates concurrent worker race conditions on account sequence numbers resulting in `txBAD_SEQ`.
- **Malformed XDR Envelopes (`generateMalformedXdr`)**: Generates truncated payloads, invalid base64, mismatched network passphrases, and corrupted signatures.
- **Partial DB Commits & Compensations (`generatePartialCommit`)**: Simulates deadlocks in multi-table operations with rollback compensation instructions.
- **Dead Letter Queue Spills (`generateDeadLetterSpill`)**: Generates payload records after maximum retry exhaustion with DLQ routing keys.
- **Tampered Audit Trails (`generateTamperedAuditChain`)**: Simulates cryptographic hash chain corruption for tamper-evident ledger testing.

---

## 3. Safe Ownership Transfer with Pending Acceptance & Expiry (Issue #288)

### Problem & Design
Instantaneous ownership reassignment poses a catastrophic risk of permanent asset loss due to typos in destination account identifiers. Trellis-API implements an atomic two-step transfer pattern:

```
[Current Owner]  --( initiateTransfer )-->  PENDING (with 72h expiry)
                                                |
            +-----------------------------------+---------------------------------+
            |                                   |                                 |
 [Proposed Owner Accepts]            [Proposed Owner Rejects]          [Current Owner Cancels]
            v                                   v                                 v
        ACCEPTED                            REJECTED                          CANCELLED
 (Ownership transferred)              (Remains with current)           (Remains with current)
```

- **Expiration**: Requests past `expiresAt` automatically transition to `EXPIRED` and cannot be accepted.
- **Self-Transfer Prevention**: Throws `BadRequestException` if current owner matches proposed owner.
- **Duplicate Prevention**: Rejects opening multiple pending transfers for the same resource simultaneously.

### API Endpoints
- `POST /ownership/transfers`: Initiates transfer with resource type, ID, proposed owner, and validity window.
- `POST /ownership/transfers/:id/accept`: Proposed owner accepts transfer.
- `POST /ownership/transfers/:id/reject`: Proposed owner declines transfer.
- `DELETE /ownership/transfers/:id`: Current owner revokes pending transfer.
- `GET /ownership/transfers`: Lists pending incoming/outgoing transfers.

---

## 4. Rollback Verification After Failed Migrations or Deployments (Issue #289)

### Purpose
Executing a database rollback without verification risks silent data corruption, orphaned foreign keys, hanging migration locks, or broken application entities. `RollbackVerificationService` runs a comprehensive post-rollback health and invariant check.

### Automated Verification Pipeline
1. **Migration Lock Check**: Ensures `migrations_lock` table is released; detects hanging lock processes.
2. **Schema Table Invariants**: Confirms all 9 core tables (`users`, `portfolios`, `api_keys`, `wallets`, `reconciliation_invoices`, etc.) are present and match baseline schemas.
3. **Referential Integrity**: Checks for orphaned records violating foreign key constraints.
4. **Data Continuity**: Validates row counts and sequence ranges against pre-migration snapshots.
5. **Database Smoke Queries**: Executes active read/write smoke queries to ensure connection pool and entity mappings are functional.

### Rollback Verdicts & Runbook
- `VERIFIED`: All checks passed. Safe to route live production traffic (`canResumeTraffic: true`).
- `WARNING`: Minor non-fatal discrepancies (e.g. minor orphaned child records). Traffic allowed with alerts.
- `FAILED`: Fatal schema missing or lock acquired. Traffic is blocked (`canResumeTraffic: false`), and exact remediation steps are generated.

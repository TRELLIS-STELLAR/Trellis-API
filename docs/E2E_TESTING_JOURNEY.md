# End-to-End Test Suite: Highest-Risk User Journey

## Highest-Risk Journey: Stellar Payment Settlement & Reconciliation

In the Trellis architecture, the highest-risk operational workflow is the **Stellar Payment Settlement and Automated Reconciliation Lifecycle**. This flow directly handles customer funds, on-chain ledger confirmation, invoice settlement status transitions, and audit provenance logging. Failures in this pipeline can cause lost deposits, duplicate crediting, or mismatched ledger states.

---

## Test Suite Architecture & Scenarios

The deterministic test suite is located at:
[`test/e2e/payment-reconciliation-journey.e2e-spec.ts`](file:///Users/mac/Documents/OPENSOURCE/Drips/zaps/Trellis-API/test/e2e/payment-reconciliation-journey.e2e-spec.ts)

### Covered Scenarios:
1. **Happy Path (Full Lifecycle)**:
   - Registers a customer invoice with destination account, XLM asset code, and expected amount.
   - Ingests confirmed on-chain Stellar transaction referencing the invoice.
   - Verifies automatic state transition to `status: "paid"` and transaction `status: "matched"`.
   - Asserts audit entry with decision `MATCHED` is written to the audit log.

2. **Failure Mode 1: Validation Failure**:
   - Rejects malformed payloads with missing identifiers or negative values.
   - Asserts structured 400 response with `errorCode: VALIDATION_ERROR`, field-level constraint errors, and recovery guidance.

3. **Failure Mode 2: Settlement Failure & Underpayment**:
   - Simulates partial payment (underpayment); verifies invoice updates to `status: "partial"`.
   - Validates fatal `INSUFFICIENT_FUNDS` exception with non-retryable flag and funding guidance.

4. **Failure Mode 3: Transient Horizon Network Timeout & Recovery**:
   - Tests `SettlementTimeoutException` emitting `retryable: true` and `retryAfterSeconds: 5`.
   - Validates that client retry with backoff successfully ingests and matches the transaction.

5. **Failure Mode 4: Duplicate Replay Submission Protection**:
   - Simulates duplicate ingest of the same Stellar transaction hash.
   - Verifies idempotent behavior: returns existing record, emits audit decision `RETRY`, and prevents double-crediting invoice balance.

6. **Failure Mode 5: Unauthorized Access & RBAC Enforcement**:
   - Enforces `RolesGuard` rejecting unauthenticated or unauthorized users with `401 Unauthorized` or `403 Forbidden` on administrative audit endpoints.

---

## Deterministic Fixtures & Isolation

The E2E suite isolates external dependencies:
- In-memory repository mocks for `ReconciliationInvoice`, `StellarTransaction`, and `ReconciliationAudit`.
- Valid Stellar public key fixtures (`GA...`, `GB...`, `GC...`, `GD...`) matching the 56-character Ed25519 format.
- Independent test environments per test case to avoid state leakage.

---

## Running the E2E Test Suite Locally

Execute the following npm script:

```bash
npm run test:e2e -- test/e2e/payment-reconciliation-journey.e2e-spec.ts
```

All 9 tests will execute and report granular assertions for every success and failure mode.

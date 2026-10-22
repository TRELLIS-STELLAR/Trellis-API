# Deterministic ledger sequence fixtures (#346)

`src/testing/fixtures/ledger-sequence.fixtures.ts` supplies reusable oracle
transactions and explicit confirmation/TTL boundary cases. The transaction uses
a fixed test identity, account sequence, Testnet passphrase, invocation arguments,
and time bounds. Rebuilding it produces the same XDR and transaction/payload
hashes without a live RPC, secrets, database, or wall clock. The deterministic
identity is public test data: never fund it or use it in production. The envelope
is unsigned; these fixtures test off-chain verification, not on-chain signature
authorization or contract execution.

Run the executable verification locally:

```bash
npm test -- --runInBand src/testing/fixtures/ledger-sequence.spec.ts
```

Import `createLedgerSequenceFixture`, `CONFIRMATION_FIXTURES`, or
`LEDGER_TTL_FIXTURES` into another test to reuse the same inputs. Each factory
call creates a fresh transaction and submission reference. The existing
`fixtures:generate` output and its five scenario contracts remain unchanged.

## Boundaries and recovery

| Case | Existing behavior | Operational response |
| --- | --- | --- |
| Inclusion ledger | Counts as confirmation one | Wait for `ORACLE_MIN_CONFIRMATIONS`; do not add an extra ledger to the threshold. |
| One ledger short / stale RPC head | Retryable `INSUFFICIENT_CONFIRMATIONS` | Keep the original submission pending and verify it again after the head advances or the RPC catches up. Do not resubmit the transaction. |
| Exact threshold / above threshold | Verification succeeds | The fixture asserts the existing hash, timestamp, and ledger response. |
| uint32 upper boundary | Confirmation arithmetic stays exact | The corpus covers 4294967294–4294967295; it assumes no sequence wraparound. |
| Transaction not found | Retryable `TRANSACTION_NOT_FOUND` | Recheck the original hash; if outside RPC retention, use an archival RPC. Missing data alone does not prove failure. |
| Transaction failed | Nonretryable `TRANSACTION_FAILED` | Investigate the ledger failure before preparing a new transaction. |
| HTTP 429 / transient head read failure | Bounded exponential retry | Retry the read; the transaction is not submitted or reread within that attempt. Exhaustion returns retryable `RPC_UNAVAILABLE`. |
| RPC HTTP 403 | Nonretryable adapter `RPC_ERROR`; no immediate retry | Repair RPC access credentials. The verifier aborts the cycle without rejecting the pending submission for an infrastructure error. |
| Different registered submitter | Nonretryable `PAYLOAD_MISMATCH` | Investigate the registered reference; confirmations never override submitter binding. |
| TTL equals current ledger | Entry remains live | Expiry is inclusive. |
| Persistent TTL below current ledger (including placeholder zero) | Archived | Restore through the authorized operational workflow before new contract calls. |
| Temporary TTL below current ledger | Missing, not archived | Recreate through the application workflow; restoration cannot recover expired temporary data. |

The integration test runs the actual adapter inside `SubmissionVerifierService`
with in-memory history/audit doubles: a short confirmation count calls `defer`
without marking success or rejection; a later cycle verifies the same hash at
the threshold. RPC methods are stubbed at the SDK boundary. Authorization tests
cover RPC access refusal and submitter reference binding; they do not claim to
exercise HTTP guards or the on-chain submitter allow-list.

## Compatibility and rollback

This is a test-only addition. No routes, DTOs, database schemas, production retry
policies, or public responses change, and no migration is required. Tests never
submit transactions or write production state. Rollback consists of reverting
the fixture, test, and documentation additions; no ledger or database rollback
is needed. Do not treat the fixture's historical time bounds as a transaction
template suitable for submission.

# Oracle contract event schema compatibility

> Resolves issue #348: contract event schema compatibility tests.

The Trellis oracle contract ([Trellis-contracts `contracts/oracle-contract/src/events.rs`](https://github.com/TRELLIS-STELLAR/Trellis-contracts/blob/main/contracts/oracle-contract/src/events.rs))
publishes every event with:

- **topics** `(Symbol "oracle", Symbol <kind>)`
- **data** a tuple, which is an `ScVal` vector

The API decodes these events in
[`src/blockchain/oracle/events/oracle-contract-events.ts`](../src/blockchain/oracle/events/oracle-contract-events.ts).
`StellarOracleAdapter.verify()` uses the decoder to cross-check the `price`
event against the `submit_price` invocation.

## Registered schemas

| Kind | v1 data | v2 data |
| --- | --- | --- |
| `sub_reg`, `sub_del` | `submitter: Address, timestamp: u64` | v1 + `correlation_id: Symbol` |
| `price` | `feed_id: Symbol, price: i128, submitter: Address, timestamp: u64` | v1 + `correlation_id: Symbol` |
| `stale` | `window_seconds: u64, timestamp: u64` | v1 + `correlation_id: Symbol` |
| `staked` | `submitter, amount: i128, total_stake: i128, timestamp: u64` | - |
| `slashed` | `submitter, penalty_amount: i128, remaining_stake: i128, reason: Symbol, timestamp: u64` | - |
| `unbond` | `submitter, amount: i128, unlock_time: u64, timestamp: u64` | - |
| `withdrawn` | `submitter, amount: i128, timestamp: u64` | - |

Both versions are live. At the time of writing, `events.rs` publishes the v2
shapes (with `correlation_id`), while the contract's `lib.rs` call sites still
pass the v1 argument lists. Ledger history can therefore contain either shape.

## Compatibility rules

1. **Append-only.** A contract release may only add fields to the *end* of a
   data tuple. `assertAppendOnly()` enforces this on the registry, and the spec
   fails if a version reorders, retypes or removes a field.
2. **Every version decodes forever.** Each kind/version has a frozen golden
   XDR event in [`__fixtures__/oracle-contract-events.v1-v2.json`](../src/blockchain/oracle/events/__fixtures__/oracle-contract-events.v1-v2.json).
   Do not regenerate it. A decoder change that cannot read it breaks
   already-emitted history. The current entries were built with
   `@stellar/stellar-sdk` from the exact tuples in `events.rs`, not captured
   from a network. When a contract release is deployed to testnet, append an
   entry captured from a real `getTransaction` response.
3. **Forward compatible.** A tuple longer than the newest known version, whose
   prefix matches it, decodes as that version. The number of extra fields is
   reported as `unknownTrailingFields`. Unknown kinds under `oracle` are
   ignored. A contract upgrade that only adds fields or kinds therefore does
   not need an API release first.
4. **Fail closed on breaking shapes.** A known kind whose data fits no version
   throws `EVENT_SCHEMA_MISMATCH`. Malformed topics throw
   `EVENT_TOPIC_MISMATCH`.
5. **Only the configured contract is trusted.** Any contract can publish
   `("oracle", "price")`. Events whose emitter is not `ORACLE_CONTRACT_ADDRESS`,
   and system or diagnostic events, are ignored. A spoofed event never
   satisfies verification.
6. **Bounded.** At most 100 contract events per transaction and 16 data fields
   per event are processed. Larger inputs are refused before any element is
   decoded (#345).

## Verification behaviour

| Situation | Result |
| --- | --- |
| RPC returns no contract events (older RPC or protocol, or empty arrays) | Unchanged: argument-only verification, and the response has no `contractEvent` field. |
| Exactly one decodable `price` event from the oracle contract that matches feed, price and submitter | Verified; `contractEvent` is added to the result. |
| The event contradicts the invocation | `PAYLOAD_MISMATCH`, not retryable: the submission is **rejected**. |
| Schema drift (`EVENT_*` codes), or no or several price events from the oracle contract (`CONTRACT_EVENT_MISSING`) | **Retryable**: the submission is **deferred**, not rejected. |

Drift is retryable on purpose. It means the API does not understand a contract
release yet; it is not evidence that the submission is wrong. Rejecting would
permanently mark valid submissions as bad.

## Contract upgrade runbook

1. **Append-only release** (new trailing field or new kind): no API change is
   required. To expose the new field by name, add a version to the registry and
   add a golden fixture entry captured from the new contract.
2. **Breaking release** (reorder, retype, remove): this needs a coordinated API
   release. Add the new version to the registry and add its fixtures. Deploy
   the API **before** the contract upgrade. Old versions must stay registered
   while ledger history containing them is still verified.
3. **Recovery if a breaking release ships first:** submissions defer with
   `EVENT_SCHEMA_MISMATCH` (they appear in the verifier's `missing` list and
   audit record). Deploy the decoder update; the next verification cycle
   verifies them. Nothing needs to be re-submitted.
4. **Rollback of this change:** revert the adapter integration. Verification
   falls back to argument-only checks, and no persisted data changes.

## Verification

```sh
npm test -- --runInBand src/blockchain/oracle/events \
  src/blockchain/oracle/services/stellar-oracle.adapter.events.spec.ts
```

# Storage TTL monitoring and repair

Issue #337. Soroban storage entries expire at their `liveUntilLedger`.
Persistent entries are archived and can be restored; temporary entries are lost.
`src/storage-ttl/` classifies tracked entries, plans renewals, and repairs them.

## Health states

| State | Meaning | Repair |
| --- | --- | --- |
| `healthy` | At least `warnBelowLedgers` remain | none |
| `expiring` | Fewer than `warnBelowLedgers` remain | `extend` |
| `critical` | Fewer than `criticalBelowLedgers` remain | `extend` (before `expiring`) |
| `archived` | Persistent entry archived or past its live-until ledger | `restore`, then `extend` |
| `expired` | Temporary entry archived or past its live-until ledger | none; reported as unrecoverable |
| `unknown` | The gateway returned no usable TTL for the key | none; verify the key |

Defaults (about 5s per ledger): warn below 120,960 (7 days), critical below
17,280 (1 day), renew to 518,400 (30 days). `validatePolicy` rejects
non-positive values, `critical >= warn`, and `extendTo <= warn`, since the last
would leave a renewed entry inside the warning band forever.

## Monitoring (read-only)

```bash
npm run storage-ttl:check -- snapshot.json   # exit 0 healthy, 1 needs attention, 2 bad input
```

```json
{
  "currentLedger": 1000000,
  "entries": [
    { "key": "vault:balances", "durability": "persistent", "liveUntilLedger": 1050000 },
    { "key": "vault:old", "durability": "persistent", "liveUntilLedger": null, "archived": true }
  ]
}
```

The CLI makes no network calls. In the service, `StorageTtlService.scan()` reads
live TTLs through a `LedgerTtlGateway` and returns the same report; a gateway
failure propagates so monitoring can alert instead of reporting "healthy".

## Repair

`StorageTtlService.repair(entries, actor, { dryRun })`:

- **Authorization:** the actor must hold `ADMIN`; anything else is rejected with
  `ForbiddenException` before any chain call. Run `dryRun: true` first to review
  the plan.
- **Idempotent:** it re-reads each entry right before acting, so a repeated or
  concurrent run skips entries already renewed (`skipped`).
- **Retry:** only `TtlGatewayError` with `transient: true` is retried, with
  exponential backoff (`backoffMs * 2^(n-1)`, three attempts by default).
  Permanent errors fail immediately.
- **Partial failure:** one failing entry never blocks the rest. If `restore`
  succeeds and `extendTtl` fails, the retry sees the live-but-short entry and
  only extends it.
- **Bounded:** at most `maxRepairsPerRun` (50) repairs run at a time, most
  urgent first (archived, critical, expiring). The rest are returned as
  `deferred`; run again to continue.

## Edge cases and recovery

- Unrecoverable (`expired`/`unknown`) entries are listed, never touched. Rebuild
  expired temporary state from its source of truth; fix `unknown` keys in the
  tracked list.
- A failed result keeps its error text. Fix the cause and rerun; completed
  repairs are skipped.
- Nothing is persisted by this module. Rolling back means not calling `repair`;
  extending a TTL cannot be undone but only costs rent.
- The CLI and service add no API routes, schema, or contract changes. Wiring a
  real Soroban RPC gateway is a separate step behind `LedgerTtlGateway`.

Verify with `npx jest src/storage-ttl`.


---

## Proactive Archival Hook (#521)

`StorageTtlExpirationScanner` proactively identifies on-chain storage entries nearing
expiration and invokes `IProactiveArchivalHook` to back up state to cold storage
(e.g., S3, IPFS, or off-chain vault) before eviction occurs.

### 1. Temporary Entry Preservation
Temporary Soroban storage entries cannot be restored once expired. The scanner flags
live temporary entries approaching expiration with `temporary_entry_preservation` urgency,
triggering proactive export before ledger eviction destroys the data.

### 2. Proactive Archival Lifecycle & Invariants
1. **Candidate Discovery**: Live entries with `remainingLedgers <= proactiveArchivalThresholdLedgers` (default: `criticalBelowLedgers + 5000`) are flagged as archival candidates.
2. **Hook Execution & Integrity Check**: Invokes `archivalHook.archive(context)`. If the hook provides a `verify(location, digest)` method, post-archival checksum verification is performed.
3. **Rollback Safety**: If integrity verification fails, the scanner calls `archivalHook.rollback(key, location)` to purge corrupted archives and logs a failure outcome without terminating the remaining batch.
4. **Transient Retries**: Hook failures marked `transient: true` are retried up to `maxAttempts` (default 3) using exponential backoff.
5. **Authorization**: Read-only scanning is open to any monitor, but `executeProactiveArchival` requires `ADMIN` or `SYSTEM_OPERATOR` roles.

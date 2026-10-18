# Policy engine & simulation preview

The policy engine centralizes configurable business decisions across trading, DeFi protocol adapters, portfolio rebalancing constraints, authentication/access controls, and notification routing. It governs `POST /trading/execute` via `PolicyService` and provides a deterministic, read-only **Policy Simulation Preview** (`PolicySimulationService` and `PolicyController`) so maintainers can inspect affected records/users, expected side effects, and rollback constraints before committing high-impact or irreversible changes.

## Trading policy configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `TRADING_ENABLED` | `true` | Set to `false` to reject trade execution safely. |
| `TRADING_MAX_ORDER_AMOUNT` | `100000` | Inclusive maximum per trade request. |
| `TRADING_ALLOWED_ASSETS` | empty | Optional comma-separated asset allow-list. |
| `TRADING_ALLOWED_SIDES` | `buy,sell` | Comma-separated sides permitted for execution. |

Policy failures are returned as HTTP 400 responses with a stable `code`, the
relevant `field`, and a user-safe message. Amount-limit failures also include
the configured `limit`; restriction failures include `allowedValues`. Do not
use policy error details to expose account, authorization, or internal state.

### Boundary behavior

- An amount exactly equal to `TRADING_MAX_ORDER_AMOUNT` is accepted.
- Amounts above the maximum, zero, negative, non-finite values, and disabled
  trading are rejected.
- Asset allow-list comparisons are case-insensitive.

---

## Policy simulation preview (`src/policy`)

Before applying high-impact or irreversible policy mutations, maintainers can simulate the proposed policy against a point-in-time population snapshot.

### Supported policy domains

| Domain (`PolicyDomain`) | Key parameters | Primary affected records |
| --- | --- | --- |
| `trading` | `enabled`, `maxOrderAmount`, `allowedAssets`, `allowedSides` | `pending_trade`, `portfolio` |
| `defi_adapters` | `enabledAdapters`, `allowedChains`, `maxSlippageBps`, `minHealthFactor`, `emergencyExitOnly` | `defi_position` |
| `portfolio_rebalancing` | `autoRebalanceEnabled`, `minTradeSizeUsd`, `maxSingleAssetWeightPct`, `driftThresholdPct` | `portfolio` |
| `auth_access` | `requireMfaForSensitiveActions`, `minKycTier`, `sessionTtlMinutes`, `revokeUnverifiedSessions`, `disallowedRoles` | `user_session` |
| `notification_routing` | `mandatorySecurityChannels`, `digestWindowMinutes`, `suppressMarketingChannels`, `maxDeliveryRetries` | `notification_preference` |

### Maintainer API endpoints (`@Roles(Role.MAINTAINER)`)

| Method & Route | Purpose |
| --- | --- |
| `POST /policy/simulations/preview` | Runs a read-only (`dryRun: true`, `readOnly: true`) simulation preview and returns field-level diffs, redacted affected user/record summaries, expected side effects, rollback constraints, and a deterministic `commitToken`. |
| `POST /policy/simulations/assert` | Validates that a proposed policy change passes domain invariants, uses a fresh snapshot, and carries a matching `commitToken` when high-impact or non-reversible. |
| `POST /policy/simulations/commit` | Verifies `assertProceedable`, applies the policy change, and records an immutable `PolicyCommitRecord` with the prior policy snapshot for rollback. |
| `POST /policy/simulations/rollback/:commitId` | Restores the previous policy configuration from the commit snapshot and returns any manual recovery steps required for partially reversible or irreversible side effects. |
| `GET /policy/simulations/active` | Returns the currently active policy configuration across all domains. |
| `GET /policy/simulations/history` | Lists committed policy changes and their rollback status. |
| `GET /policy/simulations/metrics` | Returns observability counters by domain, status, impact severity, and reversibility. |

---

## Operational edge cases & failure modes

1. **Stale population snapshots (`STALE_SNAPSHOT_UNCERTAINTY` / `STALE_SNAPSHOT_BLOCKS_UNSAFE_COMMIT`)**:
   - If the population snapshot `observedAt` timestamp is older than `maxSnapshotAgeSeconds` (default `300s`), the preview flags `completeness: "stale_snapshot"` and elevates status to `high_impact_review_required`.
   - Attempting to call `POST /policy/simulations/commit` with a stale snapshot is rejected with HTTP 400 `POLICY_SIMULATION_SNAPSHOT_STALE` to prevent unpreviewed user impact.
2. **Sampled population snapshots (`PARTIAL_SAMPLE_EXTRAPOLATION`)**:
   - When `snapshot.isSampled` is `true`, the simulation engine computes `estimatedTotalAffectedUsers` using the population-to-sample ratio and attaches `PARTIAL_SAMPLE_EXTRAPOLATION` so operators see both the sample hit count and the extrapolated fleet-wide impact.
3. **Commit token drift protection (`POLICY_COMMIT_TOKEN_REQUIRED`)**:
   - Every simulation preview computes a deterministic `commitToken` (`pctk:<domain>:<sha256>`) over `(domain, currentPolicy, effectiveProposedPolicy, snapshotVersion)`.
   - If the underlying baseline policy or snapshot version changes between preview and commit, or if a maintainer attempts to commit a `high_impact_review_required` / non-reversible change without the matching `commitToken`, the commit is blocked.
4. **Anti-lockout & schema safety invariants (`blocked_invalid_policy`)**:
   - Proposed policies that violate safety bounds—such as adding `ADMIN` to `auth_access.disallowedRoles`, setting `trading.maxOrderAmount <= 0`, disabling all DeFi adapters without `emergencyExitOnly`, or emptying `notification_routing.mandatorySecurityChannels`—are rejected with actionable `validationErrors`.
5. **Sensitive identifier redaction**:
   - All `ownerId` and `affectedUserIds` fields in preview reports are masked via `maskIdentifier` (e.g. `user...0002`) so simulation previews and audit logs never leak raw wallet addresses, session tokens, or PII.

---

## Rollback constraints & recovery procedures

Every simulation preview classifies reversibility into one of three tiers and attaches explicit `rollbackConstraints`:

| Reversibility tier | Constraint code | Why config revert alone is insufficient | Recovery steps |
| --- | --- | --- | --- |
| `fully_reversible` | `CONFIG_REVERT_FULLY_SUPPORTED` | No destructive or one-way transitions occurred. | Invoke `POST /policy/simulations/rollback/:commitId` and verify `GET /policy/simulations/active`. |
| `partially_reversible` | `REJECTED_TRADES_REQUIRE_RESUBMISSION` | Rejected in-flight trades are not automatically re-queued when limits are relaxed. | 1. Roll back the `trading` policy commit.<br>2. Query audit logs for `TRADE_AMOUNT_LIMIT_EXCEEDED` / `ASSET_NOT_ALLOWED` rejections during the active window.<br>3. Instruct clients or rebalancing workers to resubmit with fresh idempotency keys. |
| `partially_reversible` | `PORTFOLIO_TARGETS_REQUIRE_VERSION_RESTORE` / `IN_FLIGHT_QUEUE_DRAIN_REQUIRED` | Lowered drift thresholds trigger immediate rebalance trades; tightened weight limits force new `TargetAllocationVersion` rows. | 1. Roll back the `portfolio_rebalancing` policy commit.<br>2. Drain unexecuted rebalancing jobs.<br>3. Inspect `GET /portfolio/:portfolioId/allocations/history` if prior target versions must be restored. |
| `partially_reversible` | `NOTIFICATION_OVERRIDES_REQUIRE_SNAPSHOT_RESTORE` | Security notifications already dispatched over mandatory channels cannot be recalled. | 1. Roll back the `notification_routing` policy commit.<br>2. Verify stored `NotificationPreference` rows remain unmodified. |
| `irreversible` | `IRREVERSIBLE_ONCHAIN_DEFI_EXIT` | Emergency DeFi exits and collateral deleveraging settle on external protocols (`Aave`, `Compound`) and cannot be undone by API config rollback. | 1. Pause the `defi-emergency-exit` Bull queue immediately.<br>2. Roll back the `defi_adapters` policy commit to stop unsubmitted jobs.<br>3. Run position reconciliation to re-sync positions that already settled on-chain. |
| `irreversible` | `IRREVERSIBLE_SESSION_REVOCATION` | Invalidated JWTs and terminated sessions cannot be silently re-hydrated; users must re-authenticate. | 1. Roll back the `auth_access` policy commit.<br>2. Clear auth rate-limit buckets so returning users are not throttled during re-login.<br>3. Monitor `/auth/challenge` and `/auth/verify` error rates. |

---

## Verification

Run the unit tests and executable verification suite:

```bash
npx jest src/policy/policy.service.spec.ts src/policy/policy-simulation.service.spec.ts --runInBand
node scripts/verify-policy-simulation.js
```

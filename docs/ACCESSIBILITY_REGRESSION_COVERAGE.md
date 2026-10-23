# Accessibility Architecture & Regression Coverage

This document outlines the accessibility guarantees, operational edge cases, failure modes, and rollback/recovery steps for Trellis API's core contributor surfaces: **Auth, Portfolio, DeFi Adapters, Notifications, Observability, and API Contracts**.

---

## 1. Architectural Scope & Invariants

Trellis API is primarily a high-performance backend, but it exposes presentation contracts, progressive disclosure envelopes, dense forms, and tabular data models used by web clients, mobile apps, CLI tools, and assistive technologies.

The accessibility framework establishes strict invariants:
1. **Focus Order & Containment**: Every dense form and modal workflow must provide a deterministic `focusOrder` containing the `initialFocusField` / target. When validation or runtime errors occur, keyboard focus must be explicitly directed to the offending field or error summary heading.
2. **Keyboard Navigation & 2D Grid Traversal**: Tabular datasets (such as portfolio asset weights, DeFi positions, active sessions, and telemetry regressions) must declare explicit 2D grid keys (`ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`) alongside `Enter` and `Escape` handlers.
3. **Screen-Reader & ARIA Live Regions**:
   - Error summaries and critical risk alerts must be broadcast assertively (`politeness: 'assertive'`, `interrupt: true`).
   - Progress and pagination updates must be polite (`politeness: 'polite'`).
   - Every input field must have an explicit human-readable label and screen-reader help text.
4. **Reduced-Motion Preferences**:
   - Clients signaling `Sec-CH-Prefers-Reduced-Motion: reduce` or `X-Reduced-Motion: true` must receive an accessibility envelope enforcing `skipAnimations: true` and `transitionDurationMs: 0`.
   - The API middleware reflects this guarantee via the `X-Reduced-Motion-Supported` header.
5. **Progressive Disclosure & Risk Invariants**:
   - As documented in `docs/transaction-details.md`, risk sections marked `critical` are always expanded, regardless of the requested detail tier (`summary`, `standard`, `advanced`), ensuring assistive technology users encounter critical alerts first in the tab order.

---

## 2. Core Domain Workflow Coverage

The accessibility regression test suite verifies 5 core domains:

| Domain | Dense Form Surface | Tabular Data Surface | Error Recovery & Rollback |
| :--- | :--- | :--- | :--- |
| **Auth** | SEP-10 non-custodial wallet challenge & signature verification (`Alt+P`, `Alt+S`) | Active authorized user sessions and device tokens | `AUTH_SEP10_SIGNATURE_INVALID` recovery with clock sync guidance & safe session reset |
| **Portfolio** | Multi-asset target allocation rebalancing with 7-decimal precision (`Alt+X`, `Alt+U`, `Alt+T`) | Portfolio asset holdings, 7-decimal stroop balances, and drift BPS | `PORTFOLIO_CONCENTRATION_LIMIT_EXCEEDED` recovery with allocation rebalancing & snapshot rollback |
| **DeFi Adapters** | Protocol liquidity supply & borrowing order execution (`Alt+P`, `Alt+A`) | Open collateral/debt positions, APR, and health factor thresholds | `DEFI_HEALTH_FACTOR_DEFICIT` recovery with collateral replenishment & atomic unwind |
| **Notifications** | Emergency alert dispatch preferences & digest windows | Notification dispatch audit log and delivery history | `NOTIFICATION_WEBHOOK_DELIVERY_FAILED` recovery with endpoint diagnostics & dead-letter replay |
| **Observability** | Telemetry metrics filter & latency regression thresholds | P95 latency baseline regressions and anomaly records | `OBSERVABILITY_BASELINE_CORRUPTED` recovery with lookback expansion & baseline recalculation |

---

## 3. Operational Edge Cases & Failure Modes

### Edge Case 1: Assistive Technology Header Desynchronization
- **Failure Mode**: Client omits `X-Screen-Reader-Supported` or sends conflicting reduced-motion headers across reverse proxies or CDNs.
- **System Behavior**: `AccessibilityMiddleware` defaults to progressive ARIA announcements without degrading payload throughput. It injects structured `_accessibility` metadata into all HTTP $\ge 400$ error responses.
- **Recovery Action**: Re-issue request with normalized `Sec-CH-Prefers-Reduced-Motion: reduce` header or inspect `_accessibility.suggestion`.

### Edge Case 2: Deeply Nested or Dense Form Validation Cascades
- **Failure Mode**: A multi-asset portfolio rebalancing submission contains multiple conflicting validation errors simultaneously (e.g. invalid asset code, concentration $> 70\%$, negative weight).
- **System Behavior**: The API rejects the request with HTTP 400 Problem Details and an assertive ARIA live announcement. The `focusTargetId` directs the cursor to the first invalid field in logical focus order (`xlmTargetPercent`).
- **Recovery Action**: Follow the ordered `recoverySteps` in the response envelope before re-submitting.

### Edge Case 3: High-Frequency Telemetry & Dynamic Screen-Reader Overload
- **Failure Mode**: Live-refreshing dashboards (e.g. `/api/v1/profiling/ui` or polling streams) spam the screen reader with continuous polite updates.
- **System Behavior**: Background metric refreshes are isolated in `aria-live="polite"` containers, while manual actions (CPU profiling, heap snapshots, deletions) dispatch high-priority notifications to `#liveAnnouncer` with `aria-live="assertive"`.

---

## 4. Rollback and Recovery Steps

When a workflow or transaction encounters an unrecoverable failure:

1. **Verify Rollback Safety**:
   - Inspect the `rollbackSafe` boolean flag in `ErrorRecoveryAccessibilityContract`.
   - Read-only queries, preflight checks, uncommitted simulations, and staged allocations are always `rollbackSafe: true`.
   - On-chain submitted transactions or externally dispatched webhooks have `rollbackSafe: false`, requiring compensating actions.

2. **Execute Rollback**:
   - For portfolio rebalances: invoke previous snapshot restore via policy rollback endpoint (`POST /api/v1/policy/rollback/:commitId`).
   - For DeFi adapter operations: execute emergency position unwind with `commitToken` validation.
   - For auth failures: discard local session challenge and reset state via `POST /api/v1/auth/challenge`.

3. **Validate Assistive Focus Restoration**:
   - After rollback execution, keyboard focus must return to `returnFocusTarget` (e.g. the trigger button or main view container) rather than resetting to `<body>`.

---

## 5. Automated Verification

Run the executable accessibility regression suite:

```bash
npm run verify:accessibility
```

Or execute directly via Node:

```bash
node scripts/verify-accessibility.js
node scripts/verify-accessibility.js --json
```

All 27 automated checks verify schema integrity, ARIA announcements, 2D grid keys, focus order, reduced motion enforcement, async status lifecycle states, retry counters, and invariant protection.

---

## 6. Async Status States, Focus & Keyboard Coverage

Async operations (SEP-10 challenge verification, portfolio rebalancing, DeFi order execution, notifications batching, and observability recalculation) transition through explicit lifecycle phases:

```
[idle] ──(submit)──> [submitting] ──(poll)──> [polling] ──(complete)──> [succeeded]
                           │                      │
                       (failure)              (failure)
                           ▼                      ▼
                       [failed] ──(retry)──> [retrying]
                           │                      │
                       (abort)              (exhausted)
                           ▼                      ▼
                       [aborted]               [failed]
```

### Invariants:
1. **Normal Path**:
   - `submitting` and `polling` broadcast polite ARIA live updates (`politeness: 'polite'`) containing progress percentage hints.
   - Focus is retained within `pendingFocusTarget` (e.g. progress bar or cancel button).
   - `succeeded` transitions focus to `completionFocusTarget` and announces successful completion.
2. **Failure Path**:
   - `failed` and `timeout` states immediately issue an assertive ARIA live announcement (`politeness: 'assertive'`, `interrupt: true`).
   - Focus is explicitly directed to `failureFocusTarget` (the error summary alert or retry trigger).
3. **Retry Path**:
   - Every retryable async operation defines a `retryShortcut` (default `KeyR`) and tracks `attempt` against `maxAttempts`.
   - When retry limits are exhausted, an assertive `exhaustedAnnouncement` is broadcast.
4. **Authorization Path**:
   - Unauthenticated or session-expired states transition to `unauthorized`, announcing session expiration and pointing focus to `authFocusTarget` (`reauthShortcut: 'Alt+A'`).
   - `returnFocusTargetAfterAuth` is strictly recorded to restore focus back to the pending operation after successful re-authentication.
5. **Abort & Rollback**:
   - Pressing `Escape` aborts any pending async job.
   - For rollback-safe operations (`rollbackOnAbort: true`), compensating rollbacks are triggered and focus returns to `abortFocusTarget`.


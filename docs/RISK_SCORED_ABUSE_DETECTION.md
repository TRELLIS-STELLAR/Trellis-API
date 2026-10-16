# Risk-Scored Abuse Detection for High-Impact Operations

This document specifies the design, risk signal catalogue, disposition tiers, operational edge cases, failure modes, and rollback/recovery procedures for the Trellis API Risk-Scored Abuse Detection subsystem (`src/security/abuse-detection`).

---

## 1. Overview and Objectives

High-impact operations across authentication, treasury/payouts, portfolio management, DeFi adapter execution, data exports, and notification fan-out require defense-in-depth beyond static rate limiting and binary RBAC checks.

The abuse detection engine evaluates contextual and behavioral signals in real time to:
1. **Produce explainable risk signals**: Every non-zero risk contribution emits a structured `AbuseRiskSignal` with a machine-readable `code`, `category`, `severity`, `weight`, human-readable `explanation`, actionable `remediation`, and sanitized `evidence`.
2. **Trigger proportional step-up or review**:
   - Moderate anomalies (`35 <= score < 70`) require step-up verification (`step_up_required` -> `allow_after_step_up` when a fresh TOTP/2FA or challenge proof is presented).
   - High-risk anomalies (`70 <= score < 85`) queue an operator review record (`manual_review` -> `allow_after_review` via a single-use `approvalToken` bound to the actor and operation digest).
   - Critical anomalies (`score >= 85` or `SANCTIONED_OR_HIGH_RISK_COUNTERPARTY`) immediately block execution (`block`).
3. **Avoid blocking legitimate low-risk use**:
   - Operations scoring `< 35` proceed immediately (`allow`) with zero added friction.
   - Established principals (`accountAgeDays >= 30`, `mfaEnabled: true`, normal velocity, and verified destination context) receive a `TRUSTED_PRINCIPAL_MITIGATION` (`-15` weight) so single mild anomalies (e.g., mobile network IP switch) do not falsely challenge legitimate users.

---

## 2. Signal Catalogue and Scoring Weights

| Signal Code | Category | Default Weight | Trigger Condition |
| --- | --- | --- | --- |
| `SANCTIONED_OR_HIGH_RISK_COUNTERPARTY` | `destination` | `+95` (`critical`) | Destination or counterparty is flagged on a sanctions or high-risk denylist. |
| `VELOCITY_BURST` | `velocity` | `+35` to `+55` | Actor exceeds `ABUSE_MAX_OPS_PER_WINDOW` (default `5`) within `ABUSE_VELOCITY_WINDOW_SECONDS` (`300s`). |
| `AMOUNT_ANOMALY_SPIKE` | `value_anomaly` | `+30` or `+45` | Operation amount exceeds `ABUSE_HIGH_VALUE_AMOUNT_THRESHOLD` (`50,000`) and/or `ABUSE_AMOUNT_SPIKE_MULTIPLIER` (`5x` actor baseline). |
| `DEFI_SLIPPAGE_OR_DRAIN_PATTERN` | `defi_portfolio` | `+25` or `+45` | DeFi/portfolio operation uses an unverified adapter, slippage `>= 300 bps`, or near-full position exit (`>= 90%`). |
| `PRIVILEGE_OR_IMPERSONATION_CONTEXT` | `session_context` | `+35` or `+40` | Operation executes inside an active impersonation session or mutates admin privileges / MFA state. |
| `BULK_FANOUT_OR_EXPORT_SPIKE` | `velocity` | `+35` or `+45` | Data export or notification dispatch targets `>= ABUSE_BULK_RECORD_THRESHOLD` (`500`) records/recipients. |
| `RAPID_DESTINATION_CHURN` | `destination` | `+35` | Actor targets `>= ABUSE_MAX_DESTINATIONS_PER_WINDOW` (`3`) distinct destinations within the active window. |
| `RECENT_AUTH_OR_CREDENTIAL_MUTATION` | `authentication` | `+35` | Password, MFA, API key, or wallet link changed within `ABUSE_CREDENTIAL_COOLING_MINUTES` (`30m`). |
| `REPEATED_FAILED_ATTEMPTS` | `authentication` | `+30` | Actor recorded `>= ABUSE_MAX_FAILED_ATTEMPTS_PER_WINDOW` (`3`) failed auth/preflight attempts in the window. |
| `UNVERIFIED_DESTINATION` | `destination` | `+25` | Value-moving operation targets an address outside the actor's `verifiedDestinations` allow-list. |
| `NEW_DEVICE_OR_IP_CONTEXT` | `session_context` | `+20` | Current device fingerprint and IP address are absent from the actor's known trusted contexts. |
| `TRUSTED_PRINCIPAL_MITIGATION` | `mitigation` | `-15` (`info`) | Established account (`>= 30d`), MFA enabled, low velocity (`<= 1`), zero failed attempts, and verified destination. |

Composite scores are clamped to `[0, 100]`.

---

## 3. API Contracts and Integration Seams

The implementation is strictly additive and preserves existing public APIs, schemas, and user-facing contracts:

### HTTP Endpoints (`/security/abuse-detection`)
- `POST /security/abuse-detection/evaluate` — Evaluates a `HighImpactOperationInput` and returns HTTP `200` with the full `AbuseAssessmentResult` (`assessmentId`, `score`, `riskLevel`, `disposition`, `signals`, `requiredAction`, `digest`).
- `POST /security/abuse-detection/assert` — Evaluates and enforces the disposition; returns HTTP `200` when `allowed === true` or throws an `AppException`-compatible HTTP `403` Problem Details response (`AbuseStepUpRequiredException`, `AbuseManualReviewRequiredException`, or `AbuseOperationBlockedException`).
- `GET /security/abuse-detection/reviews` — Lists queued or resolved manual review records (`admin` role).
- `POST /security/abuse-detection/reviews/:reviewId/resolve` — Approves or rejects a pending review with a mandatory audit reason (`>= 10` characters). Approved reviews return a single-use `approvalToken` (`rat_...`) bound to the actor and `operationDigest`.
- `GET /security/abuse-detection/metrics` — Returns an observability snapshot (`AbuseDetectionMetricsSnapshot`) broken down by disposition, risk level, operation kind, and signal code.

### Declarative Guard (`@HighImpactOperation` + `AbuseDetectionGuard`)
Controllers can annotate high-impact routes with `@HighImpactOperation({ kind: 'treasury_withdrawal' })` and `@UseGuards(AbuseDetectionGuard)`. Evaluated responses include diagnostic headers:
- `X-Abuse-Assessment-Id`
- `X-Abuse-Risk-Score`
- `X-Abuse-Risk-Level`
- `X-Abuse-Disposition`
- `X-Abuse-Required-Action`

---

## 4. Operational Edge Cases, Failure Modes, and Rollback / Recovery

| Scenario / Edge Case | Failure Mode & Impact | Mitigation, Recovery, and Rollback Steps |
| --- | --- | --- |
| **False-positive spike after threshold tuning or traffic shift** | Legitimate high-impact operations are challenged with `step_up_required` or held in `manual_review`. | 1. Switch `ABUSE_DETECTION_MODE=shadow` to immediately allow traffic while continuing to emit risk signals and increment `shadowWouldHaveBlockedOrChallenged` metrics.<br>2. Inspect `/security/abuse-detection/metrics` (`bySignalCode`) to identify the noisy signal.<br>3. Adjust the corresponding threshold env var (e.g., `ABUSE_STEP_UP_SCORE_THRESHOLD`, `ABUSE_MAX_OPS_PER_WINDOW`) and re-enable `ABUSE_DETECTION_MODE=enforce`. |
| **Inverted or invalid threshold configuration deployed** | Operator sets `ABUSE_STEP_UP_SCORE_THRESHOLD` higher than `ABUSE_MANUAL_REVIEW_SCORE_THRESHOLD` or a non-numeric value. | `AbuseDetectionService.resolveThresholds()` validates positive numeric values and monotonic ordering (`stepUp < manualReview < block <= 100`). Any invalid or inverted configuration automatically falls back to `DEFAULT_ABUSE_THRESHOLDS` without crashing startup. |
| **Legitimate user locked in velocity window after automated batch retry** | Client retry loop exhausts `ABUSE_MAX_OPS_PER_WINDOW`, causing subsequent requests to hit `VELOCITY_BURST`. | 1. The user can satisfy step-up (`X-TOTP-Token` / `stepUpVerified`) if score `< 70`.<br>2. For score `>= 70`, an operator can approve the queued review via `POST /security/abuse-detection/reviews/:reviewId/resolve` or clear the actor's window state via `resetActorWindowState(actorId)`. |
| **Replay or cross-operation misuse of an operator `approvalToken`** | A caller attempts to reuse an `approvalToken` (`rat_...`) for a second transfer or a modified destination/amount. | Approval tokens are cryptographically bound to `(actorId, operationDigest)` and consumed atomically on first match. Replaying the token or altering any operation parameter changes `operationDigest` and rejects the token. |
| **High-cardinality actor flood (memory pressure)** | Attacker rotates synthetic actor IDs to grow in-memory sliding-window buckets. | `AbuseDetectionService` enforces a hard `MAX_TRACKED_ACTORS` (`5,000`) eviction cap and prunes expired timestamps on every window read/write. |
| **Emergency full bypass required during incident** | Abuse scoring must be completely turned off during a broader platform recovery drill. | Set `ABUSE_DETECTION_MODE=disabled`. All evaluations immediately return `disposition: 'allow'`, `score: 0` with zero side effects. |

---

## 5. Verification

Run the focused unit and integration suite:

```bash
npx jest src/security/abuse-detection/abuse-detection.spec.ts --runInBand
npm run test:threat-model
npm run test:kyc-guard-scan
```

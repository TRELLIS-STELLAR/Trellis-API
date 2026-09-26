# Observability: Business Operation Telemetry & Conversion Metrics

This document details the business-critical telemetry, structured logging taxonomy, Prometheus metrics, and conversion funnel monitoring implemented across Trellis API.

---

## 1. Overview

Trellis API provides unified operational and business observability:
1. **Prometheus Metrics**: High-resolution latency histograms, throughput counters, failure counters partitioned by error code, and multi-step conversion funnel counters.
2. **Structured JSON Logs**: Uniform logging of business events with automatic sensitive value redaction (JWTs, private keys, seeds, passwords, Stellar secrets).
3. **Correlation Tracking**: Distributed correlation IDs linking HTTP requests, internal operations, audits, and exceptions.

---

## 2. Standard Structured Fields

Every business operation log emitted by `TelemetryService` contains standardized fields:

| Field | Type | Description | Example |
|---|---|---|---|
| `timestamp` | String (ISO 8601) | Precise UTC time of event | `"2026-09-25T21:11:54.720Z"` |
| `operation` | String | Dot-notated business operation name | `"payment.process"` |
| `actor_type` | String | Role/actor initiating operation | `"user"`, `"service_actor"`, `"operator"` |
| `result` | String | Outcome of operation | `"success" \| "failure"` |
| `latency_ms` | Number | Execution duration in milliseconds | `45.2` |
| `correlation_id` | String | Distributed tracing / request UUID | `"c7a1954c-1d0b-4e89-a294-0cfb25827363"` |
| `error_code` | String (optional) | Standard domain error code on failure | `"INSUFFICIENT_FUNDS"` |
| `funnel` | String (optional) | Business conversion funnel | `"payment_settlement"` |
| `step` | String (optional) | Step in multi-stage funnel | `"payment_submit"` |
| `metadata` | Object (optional) | Contextual attributes (strictly sanitized) | `{"invoiceId": "inv_123"}` |

### Sample Structured Log Entries

**Success Path:**
```json
{
  "timestamp": "2026-09-25T21:11:54.720Z",
  "operation": "wallet.authenticate",
  "actor_type": "user",
  "result": "success",
  "latency_ms": 45.2,
  "correlation_id": "c7a1954c-1d0b-4e89-a294-0cfb25827363",
  "funnel": "auth_onboarding",
  "step": "wallet_verify",
  "metadata": {
    "client": "web"
  }
}
```

**Failure Path with Error Code:**
```json
{
  "timestamp": "2026-09-25T21:11:54.723Z",
  "operation": "payment.process",
  "actor_type": "user",
  "result": "failure",
  "latency_ms": 120.5,
  "correlation_id": "9ec45e28-ab5e-48a2-a446-cf9dcbd4c80d",
  "error_code": "INSUFFICIENT_FUNDS",
  "funnel": "payment_settlement",
  "step": "payment_submit",
  "metadata": {
    "errorMessage": "Account lacks balance for transaction"
  }
}
```

---

## 3. Sensitive Data Sanitization & Redaction

`TelemetryService.maskSensitiveData` guarantees that sensitive data is masked prior to serialization and emission:
- **Keys Redacted**: Any object key matching `/password|secret|private[_-]?key|seed|token|bearer|auth|authorization|signature|api[_-]?key|access[_-]?token|refresh[_-]?token|credit[_-]?card|cvv|ssn/i` is replaced with `"[REDACTED]"`.
- **JWT Pattern Redaction**: Any string matching JWT format (`eyJ...`) is replaced with `"[REDACTED_JWT]"`.
- **Stellar Secret Key Redaction**: Any string matching Stellar secret key pattern (`S...`, 56 chars) is replaced with `"[REDACTED_STELLAR_SECRET]"`.
- **Hex Private Key Redaction**: Any 64-hex character string associated with crypto private keys is masked.

---

## 4. Core Instrumented Operations

| Operation | Component | File Path | Funnel | Step |
|---|---|---|---|---|
| `wallet.authenticate` | `AuthController.verifySignature` | `src/core/auth/auth.controller.ts` | `auth_onboarding` | `wallet_verify` |
| `payment.create` | `StellarPaymentsController.createPayment` | `src/payments/stellar-payments.controller.ts` | `payment_settlement` | `payment_create` |
| `payment.process` | `StellarPaymentsController.submit` | `src/payments/stellar-payments.controller.ts` | `payment_settlement` | `payment_submit` |
| `reconciliation.match` | `ReconciliationService.reconcileTransaction` | `src/reconciliation/reconciliation.service.ts` | `payment_settlement` | `reconciliation_match` |
| `portfolio.optimize` | `PortfolioController.runOptimization` | `src/investment/portfolio/portfolio.controller.ts` | `portfolio_management` | `portfolio_optimize` |
| `oracle.verify_submission` | `SubmissionVerifierService.verifyCycle` | `src/blockchain/oracle/submission-verifier.service.ts` | `oracle_sync` | `submission_verify` |

---

## 5. Prometheus Metrics Reference

| Metric Name | Type | Labels | Description |
|---|---|---|---|
| `trellis_business_operation_duration_seconds` | Histogram | `operation`, `actor_type`, `result` | Latency distribution of business-critical operations. Buckets: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` |
| `trellis_business_operation_total` | Counter | `operation`, `actor_type`, `result` | Total number of business-critical operation invocations |
| `trellis_business_failure_total` | Counter | `operation`, `actor_type`, `error_code` | Total failure counts broken down by domain error code |
| `trellis_conversion_funnel_total` | Counter | `funnel`, `step`, `status` | State transitions across conversion funnels (`started`, `completed`, `failed`) |

---

## 6. Dashboard & PromQL Queries

### 6.1 Latency Percentiles (p50, p95, p99)

- **p50 Latency (Median) per Operation:**
  ```promql
  histogram_quantile(0.50, sum(rate(trellis_business_operation_duration_seconds_bucket[5m])) by (le, operation))
  ```

- **p95 Latency per Operation:**
  ```promql
  histogram_quantile(0.95, sum(rate(trellis_business_operation_duration_seconds_bucket[5m])) by (le, operation))
  ```

- **p99 Latency per Operation:**
  ```promql
  histogram_quantile(0.99, sum(rate(trellis_business_operation_duration_seconds_bucket[5m])) by (le, operation))
  ```

### 6.2 Failure Rates

- **Overall Failure Rate by Operation:**
  ```promql
  sum(rate(trellis_business_operation_total{result="failure"}[5m])) by (operation)
    /
  sum(rate(trellis_business_operation_total[5m])) by (operation) * 100
  ```

- **Failure Distribution by Error Code:**
  ```promql
  sum(rate(trellis_business_failure_total[5m])) by (operation, error_code)
  ```

### 6.3 Conversion Funnel & Drop-off Analysis

- **Payment Settlement Conversion Rate (Submit to Reconciled):**
  ```promql
  sum(rate(trellis_conversion_funnel_total{funnel="payment_settlement", step="reconciliation_match", status="completed"}[15m]))
    /
  sum(rate(trellis_conversion_funnel_total{funnel="payment_settlement", step="payment_submit", status="completed"}[15m])) * 100
  ```

- **Funnel Drop-off Rate per Step:**
  ```promql
  sum(rate(trellis_conversion_funnel_total{status="failed"}[5m])) by (funnel, step)
    /
  sum(rate(trellis_conversion_funnel_total[5m])) by (funnel, step) * 100
  ```

---

## 7. Recommended Alert Thresholds

| Alert Name | PromQL Condition | Duration | Severity | Action |
|---|---|---|---|---|
| **HighPaymentFailureRate** | `sum(rate(trellis_business_failure_total{operation="payment.process"}[5m])) / sum(rate(trellis_business_operation_total{operation="payment.process"}[5m])) > 0.05` | 3m | Critical | Page on-call; inspect Stellar network status and account balances |
| **PaymentLatencyDegradation** | `histogram_quantile(0.95, sum(rate(trellis_business_operation_duration_seconds_bucket{operation="payment.process"}[5m])) by (le)) > 2.5` | 5m | Warning | Verify Horizon gateway latency and RPC connection pool health |
| **ReconciliationDropoffHigh** | `(1 - (sum(rate(trellis_conversion_funnel_total{step="reconciliation_match", status="completed"}[15m])) / sum(rate(trellis_conversion_funnel_total{step="payment_submit", status="completed"}[15m])))) > 0.10` | 10m | High | Check reconciliation listener backlog and Horizon ledger cursor |
| **AuthenticationAnomaly** | `sum(rate(trellis_business_failure_total{operation="wallet.authenticate"}[5m])) > 50` | 2m | Warning | Check for brute force attempts or wallet provider outages |
| **OracleSyncVerificationMismatch** | `sum(rate(trellis_business_failure_total{operation="oracle.verify_submission", error_code="ORACLE_SUBMISSION_MISMATCH"}[5m])) > 0` | 1m | Critical | Alert trading desks; verify on-chain and off-chain data source parity |

---

## 8. Log Query Examples (Grafana Loki / LogQL)

- **Find all failed business operations with error codes:**
  ```logql
  {app="trellis-api"} |= "[TELEMETRY]" | json | result = "failure" | line_format "{{.timestamp}} [{{.operation}}] actor={{.actor_type}} error={{.error_code}} latency={{.latency_ms}}ms corr={{.correlation_id}}"
  ```

- **Trace all operations for a specific correlation ID:**
  ```logql
  {app="trellis-api"} |= "c7a1954c-1d0b-4e89-a294-0cfb25827363"
  ```

- **Inspect payment failure reasons:**
  ```logql
  {app="trellis-api"} |= "[TELEMETRY]" | json | operation = "payment.process" and result = "failure"
  ```

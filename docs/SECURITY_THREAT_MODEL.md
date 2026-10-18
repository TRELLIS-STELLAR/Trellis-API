# Scenario-based threat model

This document models the trust decisions made by the Trellis API at its
cross-boundary interfaces. It describes the current NestJS service and its
PostgreSQL/Redis, Stellar, payment-provider, webhook, and optional-module
integrations; it is not a claim that any deployment is secure by default.
Review it when a new authentication strategy, value-moving endpoint, external
adapter, callback, data export, or privileged operational control is added.

## Assets and security objectives

| Asset | Security objective |
| --- | --- |
| User identity, sessions, API keys, and roles | Authenticate the claimed principal; limit each credential to its intended scope and lifetime. |
| Portfolios, DeFi positions, and private user data | Restrict reads and writes to the owning user or explicitly authorized operator. |
| Payment, oracle, and Stellar operations | Prevent forged, replayed, duplicated, or unauthorized side effects; reconcile uncertain outcomes before retry. |
| Webhook signing keys and application secrets | Keep secrets out of source, logs, API responses, and untrusted integrations; rotate and revoke them safely. |
| Tenant configuration, module lifecycle, and operational controls | Prevent cross-tenant changes and unauthorized configuration or execution. |
| Audit records, alerts, and delivery history | Preserve enough sanitized evidence to investigate and recover without leaking credentials or sensitive payloads. |

## Trust boundaries

| Boundary | Untrusted input or principal | Enforced decision |
| --- | --- | --- |
| Client / internet -> HTTP API | Headers, tokens, body, route IDs, origin, request volume | Global authentication, distributed rate limiting, role, KYC, and accessibility guards; validation and sanitization pipes; Helmet and configured CORS. Public routes must be explicitly declared. |
| Credential -> principal and permission | JWTs, wallet proofs, OAuth credentials, API keys, role and scope claims | Strategy validation and route strategy allowlists; API-key scopes are checked for every explicit permission or read/write method and do not become user permission grants. |
| Authenticated principal -> resource / tenant | User-supplied portfolio, position, module, tenant, or operation identifiers | Resolve ownership/tenant scope from trusted identity and persisted state; do not trust a caller-supplied owner ID. Administrative actions require explicit role authorization. |
| External provider -> callback endpoint | Provider headers, timestamp, raw bytes, event IDs and event type | Verify provider-specific HMAC against exact raw bytes, enforce timestamp tolerance, validate the event, and durably deduplicate before dispatch. |
| API -> adapter, chain, or provider | Remote responses, timeouts, transaction acceptance, adapter return values | Treat remote data as untrusted; validate and bound it, use idempotency where supported, and reconcile unknown outcomes with the authoritative provider/ledger before retry. |
| API -> database, Redis, queue, and workers | Availability, concurrency, stale state, partial completion | Enforce database constraints and durable idempotency/replay records; use health/readiness and reconciliation rather than assuming an acknowledged request completed downstream. |
| API -> notifications and telemetry | User-controlled content, event payloads, identifiers and exception details | Minimize and sanitize sensitive data; protect delivery and metrics/trace endpoints; never include credentials, signing material, or full authorization headers in logs. |
| Operator / deployment -> secrets and privileged controls | Environment configuration, migrations, feature flags, module lifecycle and rollback commands | Restrict operator access, validate production configuration, preserve audit evidence, rotate secrets through a secret manager, and use reviewed reversible mitigations. |

## Abuse scenarios and controls

| Scenario / attacker action | Trust decision at risk and impact | Mitigations and executable checks |
| --- | --- | --- |
| A stolen read-only API key is used to submit a trade, oracle request, or payment; an attacker also tries to use its chosen scopes as elevated user permissions. | Credential scope escalation could enable value movement or privileged access. | `StrategyAuthGuard` revalidates API-key JWTs against key state, checks method or endpoint scopes, and does not promote key scopes into `request.user.permissions`. Run `npm run test:threat-model`; `strategy-auth.guard.spec.ts` covers read-only writes, explicit scopes, revoked keys, key-management strategy restrictions, and permission-grant separation. |
| A user substitutes another user's portfolio identifier in a read or mutation. | Insecure direct object reference exposes or changes another user's financial data. | Portfolio routes apply `PortfolioOwnerGuard`, which fetches the persisted owner and denies missing identity, missing route ID, and a non-owner. The guard test checks each outcome. Extend ownership checks and the same test command whenever a new resource-ID route is added. |
| An unverified or geographically restricted principal attempts a KYC-gated action; a new endpoint accidentally bypasses the gate. | Compliance restrictions could be bypassed, causing prohibited activity. | `KycGuard` is registered as an application-wide guard; exemptions are explicit method-level `@SkipKyc()` metadata and checked by `npm run test:kyc-guard-scan`. Health routes bypass the guard as public routes. The module registry retains reviewed method-level exemptions for its administrator-only endpoints; new controller methods are gated unless explicitly allowlisted. `kyc.guard.spec.ts` verifies unverified and restricted users are denied and documents deliberate public/exempt behavior. |
| An attacker forges or replays an inbound or payment-provider webhook, changes the signed body, or races duplicate event IDs. | Forged or duplicated callbacks can trigger repeated business side effects. | Inbound and payment webhook verifiers use exact raw bytes, HMAC, a bounded timestamp window, and structured failure responses; inbound processing uses a durable unique event claim. Run `npm run test:threat-model`; the inbound service and payment signature/e2e specs exercise invalid signatures, tampering, stale/future timestamps, malformed input, and duplicate handling. Raw-body preservation for payment callbacks is wired in `main.ts` and the payments module. |
| A contributor submits a malicious or incompatible optional module/adapter, or a privileged caller changes enablement for another tenant. | Untrusted code or cross-tenant configuration can access service privileges or alter tenant behavior. | The registry validates manifests and versions, checks compatibility again on enable, resolves tenant overrides before global defaults, and wraps lifecycle changes in database transactions. Only administrator-role routes can mutate the module registry. Run the registry service spec in `npm run test:threat-model`. Manifest validation is not a sandbox: module code must be trusted, reviewed, and deployed under the normal code-release controls. |
| A provider, chain node, database, or Redis becomes unavailable after the API has accepted a request or side effect. An operator blindly retries it. | Duplicate payments/trades or local state diverging from the authoritative ledger/provider. | Use the existing operation/idempotency and reconciliation records; pause risky writes when the result is uncertain and query the provider/ledger before resubmission. Run `npm run dr:validate` and the focused fault tests as appropriate; use the [operational runbook](OPERATIONAL_RUNBOOK.md) and [disaster recovery invariants](disaster-recovery-invariants.md). |
| Sensitive values are copied into logs, audit events, notifications, traces, or metrics during a failure. | Credential compromise or disclosure of personal/financial data. | Keep secrets out of diagnostic context; use the audit payload sanitizer and sensitive-content boundary. Restrict observability endpoints and access to stored logs. Consult [sensitive content boundary](SENSITIVE_CONTENT_BOUNDARY.md), [operational data controls](operational-data-controls.md), and [maintainer metrics privacy](MAINTAINER_METRICS_PRIVACY.md). |
| An attacker or compromised account rapidly executes suspicious high-impact actions (treasury drain, unverified DeFi adapter swaps, mass export, credential cooling bypass). | Account takeover or protocol exploit causing catastrophic asset or data loss. | `AbuseDetectionService` computes explainable risk signals across velocity, amount spikes, destination churn, credential cooling, and DeFi drain patterns, enforcing step-up verification (`step_up_required`) or manual review (`manual_review`) while exempting low-risk legitimate use (`TRUSTED_PRINCIPAL_MITIGATION`). Run `node scripts/verify-abuse-detection.js` and consult [risk-scored abuse detection](RISK_SCORED_ABUSE_DETECTION.md). |

## Focused verification

Run the focused checks after changing an authentication, ownership, KYC,
webhook, payment callback, or module-registry boundary:

```sh
npm run test:threat-model
npm run test:kyc-guard-scan
node scripts/verify-abuse-detection.js
```

The first command runs targeted Jest tests for API-key/strategy authorization,
KYC, portfolio ownership, inbound webhook verification and deduplication,
payment webhook signature verification over HTTP, and optional-module registry
transactions. The second scans controller metadata for unintended KYC
exemptions. These are regression checks, not substitutes for deployment
configuration review, provider contract testing, or an independent security
assessment.

For changes involving API contracts or recovery behavior, also run
`npm run test:contract` and/or `npm run dr:validate`. Run the production
configuration and migration checks for the target deployment before release.

## Operational edge cases and recovery

| Failure mode | Safe response and rollback / recovery |
| --- | --- |
| Authentication or authorization failures spike, or a key may be exposed | Treat suspected exposure as a high-severity incident. Disable the affected key/integration or risky write path, rotate the secret through the secret manager, revoke/invalidate affected sessions or keys, then verify health and a known-good authenticated request. Preserve audit evidence; do not paste credentials into incident records. |
| A webhook signature is invalid, outside tolerance, or the delivery ID is already claimed | Reject it and do not bypass verification or manually replay it. Confirm provider timestamp, exact-body signing, configured secret and clock synchronization. For a legitimately failed downstream delivery, inspect durable event/delivery/dead-letter state and retry through the idempotent delivery workflow only after confirming the event has not produced its side effect. |
| Callback accepted but downstream dispatch is delayed or fails | Keep the durable claim and delivery history as evidence. Restore the worker/dependency, inspect retry and dead-letter state, and replay only through the supported workflow. Do not delete a deduplication record to force a retry; reconcile any uncertain external side effect first. |
| Payment or Stellar submission times out with an unknown outcome | Pause automated retries for the affected operation. Query the provider or authoritative ledger using the operation/transaction identity, reconcile local state, and retry only if the operation is confirmed absent and idempotency permits it. Never infer failure from a timeout alone. |
| Database/Redis outage, migration failure, or restore | Drain risky writes if correctness is uncertain. Do not flush Redis or run a blind migration revert. Follow the migration-specific recovery plan, restore only from a verified backup and approved point, retain sensitive-action events together with their chain-head record, then run reconciliation and `npm run dr:validate` before reopening writes. |
| Bad module/adapter release or tenant configuration | Disable the affected tenant integration (or the global module only if required); do not deregister code that is still enabled. Roll back to a reviewed compatible release/configuration. If a lifecycle hook performed an external side effect before failing, use a reviewed compensating action; database transaction rollback cannot undo remote effects. |
| Notification, telemetry, or log sink outage | Preserve application availability only where doing so does not suppress security/audit requirements. Bound retries and queues, protect sensitive payloads, restore the sink, and verify delivery/retention. Never substitute unredacted payload logging as a diagnostic workaround. |

Use the [operational runbook](OPERATIONAL_RUNBOOK.md) for incident roles,
severity, and escalation. Record release/configuration changes and the
operator, preserve request/trace/transaction identifiers without secrets, and
confirm recovery with health checks plus the relevant focused test or
reconciliation check. Roll back application code only when the schema and
persisted operations remain compatible; otherwise prefer a reviewed forward
fix or compensating operation.

## Review ownership

Feature owners maintain the threat scenarios and focused tests for their
boundary. Security-sensitive changes should update this document and its
verification command in the same change. Re-evaluate the model before the
first production/mainnet deployment and after adding new providers, auth
strategies, external modules, or value-moving flows.

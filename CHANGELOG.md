# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Permission-diff preview before policy changes with dry-run simulation, per-role impact assessment, privilege escalation warnings, and atomic rollback snapshots ([#482](docs/PERMISSION_DIFF_PREVIEW.md))
- Complete RFC 7807 problem details error taxonomy mapping for all 54 error codes, including the import pipeline catalog and structured remediation guidance ([#483](docs/ERROR_TAXONOMY.md))
- Bounded cache invalidation with safety caps, SWR stale detection inspection, resilient exponential backoff retry, and degraded-mode stale serving ([#486](docs/BOUNDED_CACHE_INVALIDATION.md))
- Feature rollout guard with deterministic canary hashing, 0% rollout exclusion semantics, fail-closed audit evidence capture, and emergency disablement recovery ([#489](docs/operational-rollout-guardrails.md))
- Recovery-evidence gate in the release gate (restore drill, RPO/RTO targets and
  post-restore invariant report) ([#493](docs/RELEASE_READINESS.md))
- `--json`, `--only` and `--help` options for the contributor diagnostics
  command ([#491](docs/DEVELOPER_DIAGNOSTICS.md))
- Storage TTL monitoring, repair planning and an ADMIN-only repair service with
  retry and idempotency, plus `npm run storage-ttl:check`
  ([#337](docs/STORAGE_TTL_MONITORING.md))
- Held operations: queue work during an emergency pause and replay it after
  resume with idempotency, expiry and re-pause handling
  ([#338](docs/HELD_OPERATIONS.md))
- Expiring, single-use capability tokens for sensitive actions: minted with
  `POST /auth/capabilities` (TOTP step-up when 2FA is on), required on API key
  create/revoke when `CAPABILITY_TOKENS_ENFORCED=true`, consumed only on
  success so failed requests can be retried ([#273](docs/CAPABILITY_TOKENS.md))
- Request correlation across the API, background workers, retries and outbound
  webhooks via a validated `x-correlation-id` (`x-request-id` still honoured)
  ([#270](docs/REQUEST_CORRELATION.md))
- Oracle contract event schema registry, fail-closed decoder, golden XDR
  compatibility fixtures and `price` event cross-check in submission
  verification ([#348](docs/oracle-contract-event-compatibility.md))
- Worst-case input resource budgets for log sanitisation, redaction,
  correlation headers and contract event scans
  ([#345](docs/resource-budget-tests.md))
- Dependency health checks with public critical-only summary, admin diagnostics
  and a `npm run deps:health` CLI ([#124](docs/dependency-health.md))
- Progressive transaction details via `details=summary|standard|advanced` and
  `dryRun=true` previews ([#125](docs/transaction-details.md))
- Machine-readable protocol changelog with JSON Schema validation,
  `GET /changelog/protocol` and `npm run changelog:validate`
  ([#126](docs/protocol-changelog.md)); the source of truth for protocol changes
  is [`changelog/protocol-changes.json`](changelog/protocol-changes.json)
- Deterministic fault-injection harness and failure-mode suites for
  reconciliation and on-chain submission ([#127](docs/fault-injection.md))
- Comprehensive documentation for portfolio optimization
- WebSocket reconnection service with exponential backoff
- Connection pool management for dashboard WebSockets
- Event buffering to prevent WebSocket flooding
- Multi-wallet management system
- KYC guard with comprehensive coverage scanning
- Rate limiting for sensitive endpoints
- Token blacklisting service for secure session management
- OpenTelemetry distributed tracing integration
- Sentry error tracking and performance monitoring
- Prometheus metrics with Grafana dashboards
- Kubernetes health probes and liveness/readiness checks

### Security
- Redaction of log messages, error responses (all environments), Sentry extras,
  export values, failed-export reasons, retry/job errors and persisted webhook
  headers, with a shared cross-surface test corpus
  ([#271](docs/REDACTION_COVERAGE.md))
- Added helmet security headers
- Implemented CORS whitelisting
- Added input sanitization on all endpoints
- Enhanced password hashing with bcrypt
- JWT token with secure expiration

### Fixed
- TypeScript compilation errors across all modules
- Memory leaks in WebSocket connections
- Race conditions in oracle submission batching
- SQL injection vulnerabilities in query builders

## [0.1.0] - 2026-07-31

### Added
- Initial NestJS project structure
- Basic authentication system
- Blockchain oracle module
- DeFi portfolio tracking
- Real-time dashboard WebSocket gateway
- Core user profile management
- Basic AI compute bridge

[Unreleased]: https://github.com/TRELLIS-STELLAR/Trellis-API/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TRELLIS-STELLAR/Trellis-API/releases/tag/v0.1.0
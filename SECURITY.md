# Security Policy

Trellis API handles authentication, API keys, webhook signing, KYC checks,
oracle payload signing and payment flows, so we treat security reports as a
priority. Thank you for helping keep Trellis and its users safe.

## Supported Versions

Trellis API is pre-1.0 and has no maintained release branches yet. Security
fixes land on `main` only.

| Version        | Supported |
| -------------- | --------- |
| `main` (0.1.x) | ✅        |
| Older commits  | ❌        |

## Deployment Status

Trellis API is **pre-release (v0.1.0) and not deployed to production**. By
default it connects to the Stellar **testnet**
(`https://horizon-testnet.stellar.org`). Per the [roadmap](ROADMAP.md), a first
production deployment is planned for v0.3.0 and mainnet for v1.0.0. Reports are
still very welcome: anything found now is fixed before a production launch.

## Reporting a Vulnerability

**Do not open a public issue, discussion or pull request for a security
vulnerability.** Report it privately through one of these channels:

1. **GitHub private vulnerability reporting (preferred):** open the
   repository's **Security** tab and click **Report a vulnerability**, or go to
   <https://github.com/TRELLIS-STELLAR/Trellis-API/security/advisories/new>.
2. **Email:** **security@trellis.example**

Please include:

- a description of the vulnerability and its impact
- the affected endpoint, module or file, and the commit you tested
- steps to reproduce or a proof of concept
- any suggested fix or mitigation

While investigating, do not access or modify other users' data, and do not run
tests that degrade the service for others (denial of service, spam or social
engineering).

## What to Expect

| Stage                                              | Target                 |
| -------------------------------------------------- | ---------------------- |
| Acknowledgement of your report                     | within 3 business days |
| Initial assessment (validity and severity)         | within 7 days          |
| Fix or mitigation for confirmed critical/high bugs | within 30 days         |

We will keep you updated on progress, agree a disclosure date with you, and
credit you in the published advisory unless you would rather stay anonymous.

## Security Tooling

These checks already exist in the repository. Contributors should run
`npm run security:check` before opening a pull request.

| Command                             | What it does                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run security:check`            | Runs `security:audit`, `lint` and `test:kyc-guard-scan` in sequence.                                                                                                             |
| `npm run security:audit`            | `npm audit --audit-level=moderate`: fails on moderate or higher advisories in dependencies.                                                                                      |
| `npm run test:kyc-guard-scan`       | `scripts/check-kyc-guard-coverage.js`: fails unless `KycGuard` is registered globally, no controller uses class-level `@SkipKyc()`, and every method-level `@SkipKyc()` is allowlisted. |
| `npm run security:generate-secrets` | `scripts/generate-secrets.sh`: generates strong random values for `JWT_SECRET`, `SESSION_SECRET`, `DATABASE_PASSWORD` and `REDIS_PASSWORD`.                                     |

`scripts/pre-commit-security.sh` is an optional pre-commit hook that blocks
commits containing likely secrets (private keys, API keys, hard-coded
passwords) or a `.env` file. Install it with:

```bash
ln -s ../../scripts/pre-commit-security.sh .git/hooks/pre-commit
```

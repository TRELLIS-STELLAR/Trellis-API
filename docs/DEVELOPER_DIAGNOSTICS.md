# Developer diagnostics

Run the full local setup check from the repository root:

```bash
npm run diagnostics
```

The command loads `.env`, reports actionable fixes, and exits `1` when a
blocking check fails (`2` for an unexpected script error). Warnings are
non-blocking and exit `0`; review them before relying on the related feature.
For a faster pass that skips slow external network, build, audit, and test
checks, use `npm run diagnostics:quick`. PostgreSQL and Redis connectivity are
still checked in quick mode when their URLs are configured.

## What it checks

- Required tools, installed key Node packages, TypeScript, and a focused set of
  diagnostic-related tests.
- Required `DATABASE_URL` and `JWT_SECRET`, common placeholder values, and
  optional integration settings. Secret values are not included in the report.
- PostgreSQL TCP reachability, credentials/query access, and presence of the
  `public.users` table.
- Redis TCP reachability when `REDIS_URL` is configured.
- A GET probe against the configured Stellar Horizon URL and a TCP probe to
  configured SMTP host/port. These probes need outbound network access in full
  mode.
- The configured bootstrap admin target, when either
  `ADMIN_BOOTSTRAP_EMAIL` or `ADMIN_BOOTSTRAP_WALLET` is set. The check follows
  the API's email-first precedence and reports whether the account exists and
  already has the `ADMIN` role. It does not create or promote accounts.

The external probes establish reachability only. They do not verify provider
credentials, send email, submit transactions, or test every optional service.
An unconfigured bootstrap target is expected and is reported as skipped; the
API does not create a default admin account. A configured target that is absent
or not yet promoted is a warning because startup seeding only promotes an
existing account.

## Common failures and recovery

| Check                                          | Typical cause                                                                            | Safe recovery                                                                                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required env missing or placeholder            | `.env` was not created or still has template values                                      | Copy `.env.example` to `.env`; set a local PostgreSQL URL and generate a unique `JWT_SECRET` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Do not reuse production secrets.                            |
| PostgreSQL unreachable or query fails          | Database is stopped, URL/credentials are wrong, or outbound access is blocked            | Start the intended local database and verify the URL with the matching host, port, database, and credentials. The diagnostic does not modify the database.                                                                                |
| `public.users` missing                         | Schema has not been initialized                                                          | For local development, follow the database setup and start the API, which applies the configured TypeORM schema behavior. For migration-managed environments, review pending migrations and backups before using `npm run migration:run`. |
| Bootstrap admin missing                        | Configured email/wallet has not registered in this database                              | Register that account through the normal flow, then restart the API. No account is synthesized by diagnostics or startup seeding.                                                                                                         |
| Bootstrap account is not `ADMIN`               | The account has not passed through the startup seeder, or the configured target is wrong | Confirm the target, then restart the API. If the warning remains, inspect startup logs and verify the account in the intended database; do not manually edit production roles to silence the check.                                       |
| Redis, Horizon, or SMTP unreachable            | Service is stopped, endpoint/port is wrong, or network policy blocks access              | Verify local service status and configured endpoint. In quick mode, retry full diagnostics when external access is available. A Horizon/SMTP warning does not mean credentials or delivery are valid.                                     |
| Dependency, typecheck, or focused test failure | Install is incomplete or source changes introduced an error                              | Run `npm ci`, then rerun `npm run diagnostics`; use the failure's command/remediation and investigate lockfile changes before updating dependencies.                                                                                      |

Diagnostics is read-only: it does not run migrations, start services, change
roles, write seed rows, or send provider requests. Do not use a passing result
as authorization to apply schema changes in a shared or production database.

### Rollback and recovery

If a setup or configuration change breaks local development, restore the last
known-good `.env` values and rerun `npm run diagnostics`; rotate any secret
that was exposed. The diagnostics command itself needs no rollback.

Before applying a migration or other schema change, take a database backup and
review its forward and down operations. If the change fails, stop writes and
restore the known-good local database snapshot when data preservation matters.
Use `npm run migration:revert` only when the corresponding migration is known
to be reversible and its down operation has been reviewed; otherwise recover
from backup or use a reviewed forward fix. Do not drop a shared database or
volume as a setup shortcut.

See [Operational Runbook](OPERATIONAL_RUNBOOK.md) for service incident and
production rollback procedures.

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
- Required `DATABASE_URL` and `JWT_SECRET`, common placeholder values, secret
  entropy/length verification (`auth:JWT_SECRET`), and workspace directory write
  permissions (`fs:workspace-write`). Secret values are never printed or logged.
- `.env` drift against `.env.example` (`env:template-drift`): warns with the
  names, never the values, of template variables missing from `.env`. Skipped
  when either file is absent.
- API port availability (`env:PORT`): fails when `PORT` (default `3001`, as in
  `src/main.ts`) is invalid or already in use. The probe binds and immediately
  releases the port; it does not start the API.
- PostgreSQL TCP reachability (with automated retry and exponential backoff),
  authentication handshake vs database missing validation (`db:authentication`),
  and presence of the `public.users` table.
- Redis TCP reachability with automated retry when `REDIS_URL` is configured.
- Outbound endpoint probes: HTTP probe to Stellar Horizon with retry/backoff
  and TCP probe to configured SMTP host/port. Skipped in `--quick` mode.
- The configured bootstrap admin target, when either
  `ADMIN_BOOTSTRAP_EMAIL` or `ADMIN_BOOTSTRAP_WALLET` is set. The check follows
  the API's email-first precedence and reports whether the account exists and
  already has the `ADMIN` role. It does not create or promote accounts.

### Retry and Backoff Behavior

Network probes (PostgreSQL TCP, Redis TCP, Stellar Horizon HTTP, SMTP TCP) execute with automated retry:
- Default: Up to 2-3 attempts with linear/exponential backoff (150ms-200ms multiplier).
- Transmit failures and transient socket resets are retried before reporting failure or warning.
- Detail messages distinguish first-attempt successes from retry recoveries (`succeeded on retry attempt N`).

### Authorization & Security Validation

Diagnostics validates credentials and security boundaries without mutating state:
- **Database Auth Handshake**: Distinguishes connection refusal (`unreachable`), wrong username/password (`auth_failed`), and missing database entity (`db_missing`).
- **Cryptographic Secret Entropy**: Enforces minimum 32 characters and flags predictable dictionary phrases (`secret`, `changeme`, `password`, `12345678`, etc.).
- **Filesystem Permissions**: Tests that the workspace directory is writable by the running process for temp files and artifacts without leaving residue.

## Common failures and recovery

| Check                                          | Typical cause                                                                            | Safe recovery                                                                                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required env missing or placeholder            | `.env` was not created or still has template values                                      | Copy `.env.example` to `.env`; set a local PostgreSQL URL and generate a unique `JWT_SECRET` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Do not reuse production secrets.                            |
| `.env` is missing template variables         | `.env` was copied from an older `.env.example`                                           | Compare `.env` with `.env.example` and add the listed names. Optional integrations may stay unset; the check never prints values.                                                                                                         |
| Port already in use (`env:PORT`)               | A previous API run or another service holds the port                                     | Find it with `lsof -i :<port>`, stop that process, or set a different `PORT` in `.env`. Rerun `npm run diagnostics`; the check is safe to repeat.                                                                                          |
| Secret entropy warning or failure              | `JWT_SECRET` is under 32 characters or uses dictionary phrases                           | Re-generate a secure random 256-bit secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Replace in `.env` and restart.                                                                                 |
| Database authentication failed                 | Password or username in `DATABASE_URL` is invalid                                        | Check user permissions in Postgres: `ALTER USER user WITH PASSWORD 'password';`. Update `.env` with correct credentials.                                                                                                                |
| Database missing                               | Target database name in `DATABASE_URL` has not been created                              | Run `createdb -h localhost trellis_dev` or `CREATE DATABASE trellis_dev;` in PostgreSQL.                                                                                                                                                 |
| PostgreSQL unreachable or query fails          | Database is stopped, URL/credentials are wrong, or outbound access is blocked            | Start the intended local database and verify the URL with the matching host, port, database, and credentials. The diagnostic does not modify the database.                                                                                |
| `public.users` missing                         | Schema has not been initialized                                                          | For local development, follow the database setup and start the API, which applies the configured TypeORM schema behavior. For migration-managed environments, review pending migrations and backups before using `npm run migration:run`. |
| Bootstrap admin missing                        | Configured email/wallet has not registered in this database                              | Register that account through the normal flow, then restart the API. No account is synthesized by diagnostics or startup seeding.                                                                                                         |
| Bootstrap account is not `ADMIN`               | The account has not passed through the startup seeder, or the configured target is wrong | Confirm the target, then restart the API. If the warning remains, inspect startup logs and verify the account in the intended database; do not manually edit production roles to silence the check.                                       |
| Redis, Horizon, or SMTP unreachable            | Service is stopped, endpoint/port is wrong, or network policy blocks access              | Verify local service status and configured endpoint. Retries are attempted automatically. In quick mode, retry full diagnostics when external access is available. A Horizon/SMTP warning does not mean credentials or delivery are valid. |
| Filesystem write permission failure            | Workspace directory is read-only or owned by another user/process                        | Verify permissions with `ls -la` and grant write access: `chmod -R u+rwX .`.                                                                                                                                                              |
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

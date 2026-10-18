# Provenance CSV export operations

`GET /provenance/export/bulk` streams CSV in keyset-paginated batches of at most
250 records. Non-admin requests are restricted to the authenticated user's
records, even when the request omits `userId`; admins may select a user with the
existing filter. Single-record exports apply the same owner/admin check.

The CSV schema is an explicit allowlist. It omits input and output payloads,
error details, metadata, signatures, and record hashes. Keep this list small:
adding a field can disclose user data or cryptographic material. CSV text cells
are quoted and formula-like strings are prefixed to prevent spreadsheet formula
execution.

## Operational behavior

- The database query and response are bounded to one 250-row page plus the
  current response buffer. Keyset pagination orders by `createdAt` and `id` so
  ties do not skip rows.
- A disconnected client or aborted request stops response writes and prevents
  the next page from being requested. A database query already in flight may
  finish before cancellation is observed; the database driver does not expose a
  portable cancellation handle through this repository API.
- If a database error occurs after response headers or CSV bytes have been
  sent, the connection is destroyed. The partial file must be discarded and
  the export retried; it is not a complete artifact.
- Responses use `Cache-Control: no-store` because the export contains
  user-associated audit data.

## Rollback and recovery

This change does not require a schema migration. To roll back, revert the
streaming controller/service change and restore the previous CSV handler. If a
client received a truncated response, retry the same authorized request; CSV
exports are read-only and safe to repeat. Monitor application/database logs for
failed export queries and ensure clients treat a dropped connection as failure.

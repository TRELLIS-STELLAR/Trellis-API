# User API keys

With an authenticated account JWT, use `POST /auth/api-keys` with `name`,
`permissions` (defaults to `["read"]`) and optional `expiresInDays` (1–365).
The response includes the random key exactly once. Store it securely; it cannot
be retrieved. The database stores only a SHA-256 digest of its 256-bit random
value. `GET /auth/api-keys` returns metadata only, and `DELETE /auth/api-keys/:id`
revokes only the caller's own key. Rotate by creating a replacement, switching
the consumer, then revoking the previous key. API keys cannot manage other keys.

Send `X-API-Key` for programmatic requests. Scopes restrict the account's existing
permissions; they never replace ownership or role checks. On routes with explicit
permission metadata every required permission must appear in the key's scopes.
Other routes require `read` for GET/HEAD/OPTIONS and `write` for other methods.
Supported scopes are `read`, `write` and the application's named permissions.

The strategy caches a maximum of 1,000 metadata entries for 30 seconds. A conditional
database update checks revocation and expiry and records last use on every successful
authentication. Consequently revocation applies immediately across all API instances,
even when another instance cached metadata or a consumer holds an API-key-issued JWT.
Authentication fails closed if the database is unavailable.

`SYSTEM_API_KEYS` remains supported for migration and logs a deprecation warning.
Move consumers to persisted keys and remove static configuration when migrated.
Old API-key JWTs without a tracked key identity must reauthenticate. No static key
removal date is imposed by this change.

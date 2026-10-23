# Stale-session and token revocation handling

Issue #369. Builds on the jti revocation store in
`src/core/auth/token-blacklist.service.ts` and refresh-token family rotation in
`src/core/auth/refresh-token-rotation.service.ts`.

## What changed

Per-jti revocation only covers tokens whose jti is known when the revocation
happens. `POST /auth/logout` revoked the caller's current access token and the
user's refresh tokens, but access tokens held on other devices stayed valid
until their 15 minute expiry.

`TokenBlacklistService` now keeps a per-subject cutoff:

- `revokeSubjectSessions(subject, cutoffSeconds = now)` records the cutoff.
- `isSessionStale(subject, iat)` is true when `iat <= cutoff`.
- `JwtStrategy.validate` rejects a stale session with `401 Session is no longer
  valid`, after the existing jti check, for both traditional (`sub`) and wallet
  (`address`) tokens.
- `POST /auth/logout` records a cutoff for the user after revoking refresh
  tokens. Other callers (password change, refresh-token reuse handling) can call
  `revokeSubjectSessions` the same way.

The cutoff is stored in Redis (`token-cutoff:<subject>`, TTL
`SESSION_CUTOFF_TTL_SECONDS`, 24h, longer than any access token) when the
configured client supports `get`, and in process otherwise.

No API response shape changes and no migration is needed. Tokens issued after
the cutoff are unaffected.

## Paths

| Path | Behaviour |
| --- | --- |
| Normal | No cutoff for the subject: token accepted. |
| Revoked | `iat` at or before the cutoff: `401 Session is no longer valid`. |
| Retry | Repeating or re-ordering a revocation only moves the cutoff forward, never back. |
| Authorization | Cutoffs are per subject; other users are unaffected. A token without `iat` is stale once a cutoff exists. |

## Operational edge cases

- `iat` has one second resolution, so a login in the same second as a logout is
  also rejected. The user logs in again; this is the safe direction.
- If Redis is unreachable when writing a cutoff, it is kept in process and an
  error is logged; other replicas will not see it until the 15 minute access
  tokens expire. If Redis is unreachable on lookup, the in-process cutoff is
  used. Check `isDistributed()` and the `Redis session cutoff failed` log.
- Cutoffs expire after 24 hours; every token they cover has expired by then.

## Recovery and rollback

Reverting the change restores the previous behaviour (only the current jti and
refresh tokens are revoked). Existing Redis `token-cutoff:*` keys are ignored by
the old code and expire on their own. To undo an accidental logout-everywhere
for one user, delete `token-cutoff:<userId>`; the user's old tokens become valid
again until they expire, so only do this for a mistaken revocation, never for a
security incident.

## Verification

```bash
npx jest src/core/auth/token-blacklist.service.spec.ts src/core/auth/jwt.strategy.spec.ts
```

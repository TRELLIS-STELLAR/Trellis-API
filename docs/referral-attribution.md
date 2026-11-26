# Referral attribution boundary

Email registration in both auth services validates the supplied referral code against
`User.referralCode` and persists the referring user through `User.referredById`.
That database relationship is the authoritative signup attribution. Codes generated
by the API are eight uppercase characters from a UUID; incoming codes are matched
case insensitively. The frontend should send the code as `RegisterDto.referralCode`
and preserve it until registration; contract integration should use the same code
and user identity mapping.

After the user row is saved, auth emits `referral.registered` through Nest's event
emitter. Its payload has `userId`, `referringUserId`, `referralCode`, and
`registeredAt` (the persisted user's creation time). A reward listener should use
`userId` as its idempotency key and use the database relationship to recover missed
events. Event delivery is best effort: listener errors are logged and never reject
registration. The reward integration therefore cannot be a prerequisite for signup.

---

## Attribution Window Verifier and Clawback Guard (#522)

### 1. Attribution & Qualification Windows
- **Attribution Window** (`attributionWindowMs: 30 days`): Measures elapsed time between the referral click / promo code generation timestamp and user registration. Signups outside this window fail with `ATTRIBUTION_WINDOW_EXPIRED`.
- **Clock Skew Guard**: Registrations with timestamps prior to the click timestamp (beyond a 5-minute clock skew tolerance) fail with `CLOCK_SKEW_FUTURE_CLICK`.
- **Qualification Window** (`qualificationWindowMs: 14 days`): Referred users must complete their qualifying action (minimum trades, deposit, or transactions) within 14 days of account registration. Actions completed after window expiration fail with `QUALIFICATION_WINDOW_EXPIRED`.

### 2. Clawback Guard & Invariants
When retroactive abuse, chargebacks, sybil account farming, or self-referrals are discovered post-payout:
1. **Idempotency & Double-Clawback Prevention**: Calling `initiateClawback` on a reward that has already been clawed back returns the existing record idempotently without duplicate deductions.
2. **Clawback Time Horizon Guard** (`clawbackWindowMs: 90 days`): Standard clawbacks are restricted to within 90 days of reward grant. Attempts after 90 days require an explicit `forceOverride: true` and an administrative audit note.
3. **Failure & Retry Path**: If simulated on-chain balance recovery or wallet deduction fails due to transient ledger errors, the reward transitions to `CLAWBACK_FAILED`, recording error details and supporting `retryClawback()`.
4. **Dispute Reversal / Rollback**: If a clawback is contested and resolved in favor of the user, `reverseClawback()` restores the award status to `CLAWBACK_REVERSED` with complete audit trails.
5. **Authorization Path**: Restricts clawback operations strictly to `ADMIN` or `GROWTH_LEAD` roles; all other actors receive `ForbiddenException`.

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

There is currently no reward listener or contract adapter in this repository. A
future consumer may award a reward based on the event and reconcile against users
with `referredById` set. A durable queue/outbox is needed if reward delivery must
survive an API process crash between user save and event emission.

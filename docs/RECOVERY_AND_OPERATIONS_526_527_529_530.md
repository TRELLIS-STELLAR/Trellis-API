# Recovery and operations: #526, #527, #529, #530

Four focused vertical slices from the Stellar Wave backlog. Each one is a
self-contained module with automated tests, no HTTP route changes and no
database migrations. Existing contracts are preserved: every change is
additive, opt-in, or an optional constructor argument.

| Issue | Module | Opt-in |
|---|---|---|
| #526 Session revocation broadcast bus | `src/session-revocation/revocation-bus.ts` | Wire `TokenFamilyInvalidations` into `RefreshTokenRotationService` |
| #527 Flamegraph snapshot collector | `src/profiling/flamegraph/` | `PROFILING_FLAMEGRAPH_MEMORY_THRESHOLD` |
| #529 Disbursement checkpoint journal | `src/common/batch/checkpoint-journal.ts` | Call `runResumableDisbursement` |
| #530 Payment pipeline synthetic probe | `src/synthetic-monitoring/payment-pipeline-probe.ts` | Register the journey with `SyntheticMonitoringService` |

---

## #526 Session revocation broadcast bus with token family invalidation

**What it does.** When a refresh-token family must die on every replica
(reuse detected, "log out everywhere", an operator action), `RevocationBus.revokeFamily`
records the invalidation locally and broadcasts a `token-family` event. Each
replica records the same invalidation. `RefreshTokenRotationService.rotate`
then refuses any token whose family is invalidated, even if that replica never
saw the original reuse.

**Authorization.** Only `ADMIN` and `SERVICE_ACTOR` may revoke. A `USER` gets
`ForbiddenException` before anything changes, and nothing is published.

**Normal path.** Local invalidation, then publish. Receivers apply the event
once. Result: `{ localInvalidated: true, broadcast: true, attempts: 1 }`.

**Failure and retry paths.**
- A publish failure is retried with exponential backoff (`maxPublishAttempts`,
  default 3, `retryDelayMs`, default 50ms).
- Local invalidation happens *before* publishing, so a broken transport never
  lets this node accept the revoked family.
- An event that still fails is parked in an outbox. `flushOutbox()` resends
  it. An event leaves the outbox only after it has been published.
- Receivers dedupe by event id, so a retry or redelivery cannot re-apply a
  revocation or rewrite its audit record.

**Edge cases.**
- *Partition window.* Between a local invalidation and a successful broadcast,
  other replicas still accept the family. That window is bounded by the
  broadcast retry and outbox flush. Operators should call `flushOutbox()`
  periodically and alert on `pendingBroadcasts() > 0`.
- *Malformed events* (empty id, unknown kind, oversized reason) are dropped
  and never applied.
- *Expiry.* Invalidations expire after `ttlMs`, which defaults to 30 days. Set
  it to at least the longest refresh-token lifetime so an invalidation outlives
  every token it could cover.
- *Padded or empty family ids* are rejected before publishing.

**Recovery and rollback.**
- Invalidations are additive. There is deliberately no "un-revoke". A user
  whose family was revoked by mistake signs in again, which issues a new family.
- To roll back the feature, remove the optional `TokenFamilyInvalidations`
  argument. Rotation then behaves exactly as before. No data is stored in the
  database, so nothing needs reverting.
- **Production transport.** `InMemoryRevocationHub` only spans one process. For
  multiple replicas, implement `RevocationTransport` over Redis pub/sub (the
  same publish/subscribe shape). That adapter is not included in this change,
  and until it is, invalidations do not cross process boundaries.

**Compatibility.** `RefreshTokenRotationService` takes an optional third
constructor argument. Existing call sites and their tests are unchanged.

---

## #527 Profiling flamegraph snapshot collector with memory threshold trigger

**What it does.** Converts a V8 CPU profile into a flamegraph tree and folded
stacks, and writes both to the profiles directory. It can run on demand
(`captureFlamegraph`, admin only) or automatically when heap usage crosses a
threshold.

**Gates, in order.** Each refusal happens before a profile starts.
1. **Authorization.** Manual capture requires `ADMIN`.
2. **Feature gate.** In production, profiling must be enabled with
   `ENABLE_PROFILING=true`. This matches the existing profiling controller.
3. **Concurrency.** One capture at a time. A second manual request gets `409`.
   A trigger that finds a capture running is skipped rather than queued.

**Memory trigger.** Opt-in via `PROFILING_FLAMEGRAPH_MEMORY_THRESHOLD` (a ratio
in (0, 1), e.g. `0.85`). An invalid value is logged and disables the trigger
rather than failing startup.
- *Hysteresis.* It fires once when usage crosses the threshold, and re-arms only
  after usage falls below `threshold - 0.05`. A process hovering at the threshold
  produces one capture, not one per sample.
- *Cooldown.* At least `PROFILING_FLAMEGRAPH_COOLDOWN_MS` (default 15 minutes)
  between captures, even across separate excursions.
- *Duration.* `PROFILING_FLAMEGRAPH_DURATION_MS` (default 5000).

**Failure and retry paths.**
- A failing profile source is retried with backoff (default 2 attempts).
- If the trigger's capture fails, the error is logged and the monitoring loop
  continues. A failed capture is not retried immediately, so a broken profiler
  cannot thrash.
- Writes go to a temp file and are renamed into place. A failed write removes
  any file already written for that capture.
- A malformed profile (no nodes, a cycle, a dangling reference) is rejected and
  writes nothing.

**Edge cases.**
- Folded-format delimiters (`;`) in frame names are replaced, so output stays
  parseable.
- A capture with zero samples produces an empty folded file, not an error.
- The in-flight flag is cleared in a `finally`, so a failed capture never blocks
  the next one.

**Recovery and rollback.**
- Artifacts are plain files named `flame-<timestamp>-<rand>.{flamegraph.json,folded}`
  in the profiles directory. Nothing deletes them automatically. Remove them by
  hand.
- To roll back, unset `PROFILING_FLAMEGRAPH_MEMORY_THRESHOLD`. With it unset,
  the monitoring loop does no extra work.
- Artifacts are not registered in the existing profile list, so they do not
  appear in `GET /api/v1/profiling/profiles`. Adding them there would change the
  `ProfileMetadata` type, which is a contract change, so it was left out.

**Compatibility.** No new HTTP routes, so the OpenAPI document is unchanged.
`ProfilingService` gains a method and an internal collector. Its constructor
signature is unchanged.

---

## #529 Recovery checkpoint journal for interrupted batch disbursements

**The problem.** If a process dies while a disbursement is in flight, it cannot
tell whether the external system accepted the payout. A plain "done" checkpoint
cannot distinguish "never sent" from "sent, not confirmed". Resubmitting the
second case pays twice.

**Design.** An append-only JSONL journal per batch, with three entry states:
- `intent` is written *before* the external call.
- `confirmed` is written after it returns, with the external reference.
- `failed` is written after an error, flagged `retryable` or not.

On restart, `plan()` classifies every item:

| Last journal entry | Classification | On resume |
|---|---|---|
| none | `toExecute` | execute |
| `confirmed` | `confirmed` | skip |
| `intent` (no terminal) | `indeterminate` | reconcile, see below |
| `failed`, retryable | `toExecute` | execute |
| `failed`, not retryable | `permanentlyFailed` | halt for operator review |

**Indeterminate items** are never resubmitted blindly. If a `reconcile`
function is supplied, it asks the external system: `confirmed` records the
payout and skips it, and `absent` makes it safe to execute. With no reconciler,
the run halts before touching the item.

**Failure contract.**
- `isRetryable(error)` must be true *only* for errors raised before the payout
  was submitted. Those are the only errors retried automatically.
- Any other error has an unknown outcome. It is journaled as non-retryable and
  the run halts. It is never retried, because a timeout can hide a payout that
  landed.
- Items run strictly in order. A run halts on the first unresolved item, so a
  later payout cannot overtake one still in doubt.

**Authorization.** The actor must hold `payment:process`. The check runs before
any journal write, so a refused caller leaves no trace.

**Durability.** Each append is `write` + `fsync` on one descriptor. A torn final
line (crash mid-write) was never acknowledged and is ignored. A corrupt or
out-of-sequence line anywhere else throws, because skipping it could hide a
confirmed payout.

**Edge cases.**
- Batch ids are validated, so a path-like id cannot escape the journal directory.
- Each item's idempotency key is `<batchId>:<itemKey>`. It stays the same across
  retries and resumes, so the processor can dedupe.
- Attempt numbers continue from the journal, so they stay unique after a restart.

**Recovery and rollback.**
- To resume an interrupted batch, call `runResumableDisbursement` again with the
  same `batchId`. Confirmed items are skipped.
- For a `permanentlyFailed` item, an operator must check the external system.
  If the payout landed, append a `confirmed` entry for that item. If it did not,
  append a `failed` entry marked `retryable: true`. Either way, do this by hand
  and record why. The journal is the audit trail.
- The journal is single-writer. Run one process per batch id at a time.
- To roll back, stop calling `runResumableDisbursement`. The journal files are
  plain JSONL and can be archived or deleted after reconciliation.

**Compatibility.** A new module under `src/common/batch/`, exported alongside the
existing batch processor. Nothing existing changes.

---

## #530 Synthetic health probe for authenticated payment pipelines

**What it does.** Builds a `Journey` for the existing `SyntheticMonitoringService`
that walks the authenticated payment surface:

1. `authenticate`: `GET /api/v1/auth/status` must report an authenticated session.
2. `list-processors`: `GET /api/v1/payments/processors` must return a list.
3. `enabled-processor`: at least one processor must be enabled.

The probe is **read-only**. It never creates a quote, payment or payout, so
running it is safe in production.

**Failure classification.**

| Kind | Trigger | Retried |
|---|---|---|
| `authorization` | 401/403, or no credential configured | no |
| `client` | other 4xx, or a non-JSON body | no |
| `server` | 5xx | yes |
| `timeout` | step exceeded `stepTimeoutMs` | yes |
| `network` | fetch rejected before a response | yes |
| `pipeline` | no processor enabled | no |

Retries are safe because every probe request is a GET. Step error messages
name the path and the status or error class. They never include the credential
or the response body.

**Fail closed.** With no credential configured, the probe sends no request and
reports a failure. A missing credential must never look like a pass.

**Base URL.** Must be `https`, except for `localhost` and `127.0.0.1`. An
unparseable URL is rejected when the journey is built.

**Edge cases.**
- A failing step skips the rest (existing executor behaviour), so an auth failure
  does not produce a flood of secondary errors.
- The processor list is fetched once and reused for the enabled check.

**Recovery and rollback.**
- A probe failure has no side effects to undo. Check the failing step's kind.
- An `authorization` failure means the probe credential was rotated or revoked.
  Issue a new one and rerun.
- **Credential.** Use a dedicated service account, not a personal token. It only
  needs to pass the JWT guard for these two routes. Do not give it ADMIN. The
  stuck-operations route needs ADMIN, so the probe does not call it.
- To stop probing, unregister the journey.

**Compatibility.** Additive. The existing `SyntheticMonitoringService` contract
is unchanged.

---

## Test coverage

Each slice has a spec covering the normal, failure, retry and authorization
paths, plus the edge cases above.

| Spec | Tests |
|---|---|
| `src/common/batch/checkpoint-journal.spec.ts` | 18 |
| `src/synthetic-monitoring/payment-pipeline-probe.spec.ts` | 17 |
| `src/session-revocation/revocation-bus.spec.ts` | 17 (3 are rotation integration) |
| `src/profiling/flamegraph/flamegraph.spec.ts` | 17 |
| `src/profiling/flamegraph/flamegraph-collector.spec.ts` | 13 |

Run them with:

```bash
npx jest src/common/batch/checkpoint-journal src/synthetic-monitoring \
  src/session-revocation src/profiling/flamegraph src/core/auth/refresh-token-rotation
```

## Known gaps (not in this change)

- Redis pub/sub transport for #526 (the interface is in place).
- An HTTP route for manual flamegraph capture (#527). The collector is
  admin-gated, but no route is exposed yet, which keeps the OpenAPI document unchanged.
- Wiring the disbursement journal into the live payout path (#529). The journal
  and runner are ready to call from there.
- Wiring the probe into the scheduler and alerting (#530).

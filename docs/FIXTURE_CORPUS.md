# Golden Fixture Corpus — Malformed External Payloads & Adversarial Records

Tracking issue: #208

The corpus under `src/testing/fixtures/external-payloads/` is a checked-in set
of adversarial inputs (JSON files) paired with the **golden outcome** the
system must produce for each one. It exists to make "we handle bad inputs"
an executable claim: every fixture is replayed through the **real**
validation path by `external-payload-corpus.spec.ts` on every `npm test`.

## Running the corpus

```bash
npm test -- external-payload-corpus        # full corpus + integrity checks
npx jest src/testing/fixtures/external-payloads   # same, explicit path
```

No database, network, or secrets are required; every fixture is
deterministic (see `CORPUS_NOW_MS` in `corpus.ts`).

## Layout

```
src/testing/fixtures/external-payloads/
  corpus.ts                          # types, constants, loader
  external-payload-corpus.spec.ts    # integrity + execution against real code
  invalid-signature/                 # signature/HMAC checks that must fail
  missing-fields/                    # required fields absent
  oversized/                         # values past contract limits
  replay/                            # replay-window and dedup controls
  schema-drift/                      # stored-event version drift
  tampered-record/                   # post-validation tampering attempts
```

## Categories and targets

| Category | What it pins down | Example fixture |
| --- | --- | --- |
| `invalid-signature` | Wrong, malformed, or absent HMACs on payment and inbound webhooks | `stripe-wrong-hmac` |
| `missing-fields` | Required fields absent at every layer (headers, body DTO, event schema) | `payment-create-empty-body` |
| `oversized` | Values past contract limits (256-char idempotency key, 300-char event id, exponent-form amounts) | `inbound-oversized-event-id` |
| `replay` | 300s timestamp windows, unique `externalEventId` dedup (409) | `inbound-duplicate-delivery` |
| `schema-drift` | Stored events pinned to unknown versions (poison/halt) or older minors (upcast) | `event-unknown-schema-version` |
| `tampered-record` | Smuggled properties, XSS in metadata, ledger hash-chain violations | `event-ledger-hash-mismatch` |

Each fixture targets one validation path:

| Target | Real code under test |
| --- | --- |
| `payments.webhook-signature` | `WebhookSignatureService` (raw-bytes HMAC, replay window, per-provider schemes) |
| `webhooks.inbound` | `WebhookInboundService` (timestamp window, HMAC, event-shape checks, dedup conflict) |
| `api.body-validation` | `SanitizePipe` → global `ValidationPipe` (whitelist + `forbidNonWhitelisted`) on `CreatePaymentDto` / `SubmitPayloadDto` |
| `events.replay` | `EventReplayEngine` + `DEFAULT_UPCASTERS` on `userDirectoryProjection` |

## Fixture contract

Every fixture JSON must have:

- `id` — identical to the file name without `.json`, unique corpus-wide.
- `category` — identical to the containing directory; one of the six above.
- `target` — one of the four validation paths.
- `description` — one line explaining the attack.
- `input` — the adversarial input, self-contained (test secrets are baked in;
  `corpus_stripe_secret` / `corpus_inbound_key` are **test-only** constants).
- `expected` — the golden outcome (exact reason codes, field lists, replay
  report counters, or a sanitized-value subset).

The integrity tests enforce all of the above, plus: no unresolved
`__COMPUTE_*` generator placeholders and exactly the six required categories.

Runner-computed values: `webhooks.inbound` fixtures that need a *valid*
signature omit `headers["x-webhook-signature"]` and the runner computes it
over the fixture's own body+timestamp; adversarial fixtures pin their bad
signature explicitly and are used verbatim.

## Adding a fixture

1. Pick a category directory; name the file `<id>.json`.
2. Copy the closest existing fixture; keep the input minimal and
   self-contained. Use `nowSeconds: 1800000000` / `CORPUS_NOW_MS` for time.
3. Write the golden `expected` from the *code's* actual contract (error
   reason codes from `WebhookSignatureFailureReason`, inbound `reason`
   strings, DTO field names, `ReplayReport` counters) — never invent them.
4. Run `npm test -- external-payload-corpus`. Do not update a golden to make
   a failing test pass until you have confirmed the failure is fixture rot,
   not a regression (see below).

## Failure modes and triage

A failing corpus test means one of three things:

| Symptom | Likely cause | Action |
| --- | --- | --- |
| A previously green fixture now fails after a code change | **Regression** in the validation path | Fix the code (preferred) or, if the contract intentionally changed, update the fixture in the same PR with the rationale in the commit message |
| Many fixtures fail at once after a dependency change (e.g. sanitizer, class-validator) | Upstream behaviour drift | Diff upstream changelogs; re-golden deliberately, one commit |
| A new fixture fails on first write | Golden written from assumption, not contract | Re-read the target's error codes/messages and correct the fixture |

Specific edges the corpus deliberately pins:

- Payment webhook verification is over **raw bytes**; re-serialised bodies
  must not verify (`stripe-tampered-body` family).
- Missing raw body fails **closed** with `raw_body_unavailable` (500-class
  misconfiguration is `secret_not_configured`, sender-error is 400).
- Inbound timestamps are checked **before** signatures, so clock problems
  surface as `missing_timestamp`/`stale_signature`, not `invalid_signature`.
- Duplicate external event ids surface as HTTP 409 `duplicate_event` — the
  unique constraint is the replay defence, not the timestamp window.
- Schema drift with no upcaster path **halts** the replay (nothing published,
  checkpoint preserved) and records a poison event; drifted minors upcast.
- Ledger-chained events abort the whole replay on hash mismatch — tamper
  evidence is all-or-nothing.

## Rollback / recovery

- Corpus files are inert at runtime (test-time only; never imported by
  `src/main.ts` or any module). Rolling back is `git revert` of the corpus
  commit — no data migration, no API change, no deploy coordination.
- If a corpus commit must be reverted while a code fix lands separately,
  revert the **spec first**, then the fixtures, so no fixture exists without
  its executor.
- Quarantine (last resort, requires PR justification): add
  `it.skip("...", ...)`-style skip **only** in the execution table by moving
  the fixture's assertion to `it.todo` — never delete a failing golden
  silently; the integrity tests still load it so it cannot rot unnoticed.
- Restoring a previous corpus version restores the previous goldens exactly
  (files are static JSON; nothing is generated at test time except the two
  runner-computed inbound signatures).

## Compatibility

The corpus changes no public API, schema, migration, or user-facing
behaviour. It asserts the *existing* contracts of the payment webhook,
inbound webhook, DTO validation, and event replay paths. If one of those
contracts must change, the fixture update is the visible, reviewable
contract-change artefact that ships with the code change.

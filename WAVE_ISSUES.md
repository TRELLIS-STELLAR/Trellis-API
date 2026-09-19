# Trellis API — NestJS off-chain services — Wave Program issues

Twenty issues for the Trellis API, grounded in the current state of `main`. Each
cites the file and line that prompted it. Note that #8 is a security defect and
should be reviewed before it is posted publicly.

These are staged for release, not posted all at once. Each stage is a batch you can push when the previous one has been picked up.

| Stage | Issues | When to post |
| --- | --- | --- |
| 1 | 7 (#1–#7) | Ready to post now |
| 2 | 8 (#8–#15) | Core contributor work |
| 3 | 5 (#16–#20) | Needs a maintainer decision first |

Create them with `.github/create-issues.sh <stage>` — see the bottom of this file.

---

## Stage 1 — Ready to post now

Self-contained, low-risk, and reviewable in a single pass. Most need no prior knowledge of the codebase. Post these first so the first wave of contributors has somewhere to land.

### 1. `test/enhanced-auth.service.spec.ts` does not compile

**Labels:** `bug`, `good first issue`, `test`

`test/enhanced-auth.service.spec.ts` fails to parse. Two separate problems:

1. **Line 120** has a doubled closing paren:
   ```ts
   const result = await service.register(registerDto, "127.0.0.1", "test-agent"););
   ```
2. **The end of the file** contains pasted tool-call markup that is not
   TypeScript at all:
   ```
   });</content>
   <parameter name="filePath">/workspaces/trellis-api/test/enhanced-auth.service.spec.ts
   ```

`tsc` reports `TS1128: Declaration or statement expected` at 120:85 and again at
192:1, plus `TS1110` and `TS1005`. This is the only file in the repository with
that artifact — a check across all `.ts` and `.js` files found no others.

## Why this matters

An auth service spec that cannot compile is a test that never runs. Enhanced
auth covers registration, login and MFA setup — exactly the paths you want
covered. The file has been broken in `main` for some time, so whatever
regression it was written to catch has been unguarded since.

## Tasks

- [ ] Remove the trailing `</content>` and `<parameter …>` block from the end of the file
- [ ] Fix the doubled `);` on line 120
- [ ] Run `npx tsc --noEmit` and confirm the file parses
- [ ] Run `npm test -- enhanced-auth` and make the tests actually pass, not just compile
- [ ] Check git history around the commit that introduced the paste — the same edit may have dropped real assertions elsewhere in the file

## Files to look at

- `test/enhanced-auth.service.spec.ts`
- `src/core/auth/enhanced-auth.service.ts`

## Acceptance criteria

- The file parses under `tsc --noEmit`
- `npm test -- enhanced-auth` passes
- The PR notes whether any test content was lost in the original bad paste

## Notes

Check the surrounding tests carefully rather than only making it compile. A paste
that appended markup may also have truncated the test it landed in.

---

**Skills:** TypeScript  
**Estimated effort:** 30 minutes

### 2. LICENSE says MIT, package.json says Apache-2.0

**Labels:** `bug`, `good first issue`, `legal`, `documentation`

The repository declares two different licences:

- `LICENSE` begins `MIT License`
- `package.json` line 7 is `"license": "Apache-2.0"`
- The README badge renders "license Apache 2.0"
- `src/config/swagger.config.ts` calls `.setLicense("Apache 2.0", …)` in the
  published OpenAPI metadata

So the file on disk says one thing and every machine-readable declaration says
another. For comparison, the `Trellis` contracts repo claims MIT (and has no
LICENSE file at all — tracked separately there).

## Why this matters

A licence contradiction is genuinely unresolvable for a downstream consumer.
They cannot know which terms apply, tooling that reads `package.json` will report
Apache-2.0 while GitHub reads the file and reports MIT, and anyone doing licence
compliance has to stop and ask. The two licences differ meaningfully — Apache-2.0
carries a patent grant that MIT does not.

## Tasks

- [ ] Decide which licence is intended — a maintainer decision, note it in the thread
- [ ] Replace the `LICENSE` file with the full text of the chosen licence
- [ ] Make `package.json`, the README badge and the Swagger `setLicense` call agree
- [ ] Check the generated client packages in `.github/workflows/build-check.yml`, which also declare a licence
- [ ] Raise whether all three Trellis repositories should use the same licence

## Files to look at

- `LICENSE`
- `package.json`
- `README.md`
- `src/config/swagger.config.ts`
- `.github/workflows/build-check.yml`

## Acceptance criteria

- Every licence declaration in the repository names the same licence
- GitHub's sidebar and `package.json` agree
- The OpenAPI document's licence metadata matches

---

**Skills:** Markdown, JSON  
**Estimated effort:** 30 minutes

### 3. Add SECURITY.md with a vulnerability disclosure policy

**Labels:** `good first issue`, `documentation`, `security`

There is no `SECURITY.md`. The repository has `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `LICENSE` and a PR template — the security
policy is the one community file missing.

This service handles authentication, API keys, webhook signing, KYC guard
coverage and payment flows. `package.json` even defines `security:audit`,
`security:generate-secrets` and `security:check` scripts, so security tooling is
taken seriously; there is just no route for an outside reporter.

## Why this matters

A researcher who finds an auth bypass here today has no private channel. Given
this service signs oracle payloads and initiates payments, a publicly-disclosed
vulnerability would be materially damaging. GitHub's Security tab is empty until
this file exists.

## Tasks

- [ ] Write `SECURITY.md`: supported versions, how to report privately, expected response time
- [ ] Enable GitHub private vulnerability reporting in repository settings and link it
- [ ] Document the existing `npm run security:check` flow so contributors know what already runs
- [ ] State the current deployment status plainly — testnet, staging, or production
- [ ] Match the structure used in the sibling repositories so the three are consistent

## Files to look at

- `SECURITY.md (new)`
- `package.json`
- `scripts/`

## Acceptance criteria

- GitHub's Security tab shows the policy
- A private reporting channel and response-time commitment are stated
- The existing security tooling is referenced

---

**Skills:** Markdown  
**Estimated effort:** 1 hour

### 4. Jest collects coverage but enforces no threshold

**Labels:** `good first issue`, `test`, `ci`

`jest.config.js` sets `collectCoverageFrom` (line 24) but no `coverageThreshold`.
So coverage can be computed with `npm run test:cov`, but nothing enforces a floor
and CI does not report it.

The repository has 105 `.spec.ts` files, which is substantial — but the ROADMAP
targets "80% code coverage across all modules" and nobody currently knows the
real number.

## Why this matters

Without a threshold, coverage can only go down silently. The roadmap's 80% target
is unmeasurable until the baseline is recorded, and a visible coverage trend is
one of the strongest signals a programme like this can show reviewers.

## Tasks

- [ ] Run `npm run test:cov` and record the current global and per-module baseline in the issue thread
- [ ] Add `coverageThreshold` set just below the current baseline so CI cannot regress
- [ ] Add per-directory thresholds for the sensitive areas: `src/core/auth`, `src/payments`, `src/blockchain`
- [ ] Surface the coverage summary in the CI job output
- [ ] Agree a ratchet plan rather than setting 80% immediately

## Files to look at

- `jest.config.js`
- `.github/workflows/build-check.yml`
- `package.json`

## Acceptance criteria

- The current baseline is documented
- CI fails when coverage drops below the threshold
- Auth, payments and blockchain modules carry a higher bar than the global floor

---

**Skills:** TypeScript, Jest  
**Estimated effort:** 2–3 hours

### 5. A Python FastAPI service lives inside the NestJS `src/` tree

**Labels:** `good first issue`, `documentation`, `refactor`

There is a second, unrelated application inside this repository:

- `src/main.py` — a FastAPI app titled "Advanced Portfolio Simulation Engine"
- `src/api/portfolio.py`
- `src/models/portfolio.py`
- `examples/python-client-example.py`
- `requirements.txt` at the repository root

`src/main.py` sits directly beside `src/main.ts`, the NestJS entrypoint. Nothing
in the README, CONTRIBUTING or the docs mentions that a Python service exists,
how to run it, or how it relates to the Nest application.

## Why this matters

A newcomer opening `src/` sees two entrypoints in two languages with no
explanation. Worse, tooling gets confused: `tsconfig`, the Nest CLI and the
Docker build all assume `src/` is TypeScript, and `requirements.txt` at the root
suggests to any scanner that this is a Python project.

Either it is a real component and deserves documentation and a home, or it is a
prototype that should be archived.

## Tasks

- [ ] Establish in the issue thread what the simulation engine is for and whether it is live
- [ ] If it is real: move it to its own top-level directory (`services/portfolio-simulator/` or similar), document how to run it, and explain how the Nest app calls it
- [ ] If it is a prototype: move it to `examples/` or remove it, preserving the history
- [ ] Either way, make sure `Dockerfile` and `docker-compose.yml` reflect the decision
- [ ] Document the outcome in the README's project structure section

## Files to look at

- `src/main.py`
- `src/api/portfolio.py`
- `src/models/portfolio.py`
- `requirements.txt`
- `Dockerfile`
- `docker-compose.yml`
- `README.md`

## Acceptance criteria

- `src/` contains one application, or the second one is clearly delineated and documented
- The README explains what the Python component is and how to run it, or it is gone
- The Docker build is unaffected or updated deliberately

---

**Skills:** Python, TypeScript, repository structure  
**Estimated effort:** half a day

### 6. Add a documentation index to the README

**Labels:** `good first issue`, `documentation`

This repository has the best documentation of the three — 29 markdown files,
including a `docs/` directory with twelve: `PORTFOLIO_OPTIMIZATION.md` (825
lines), `PORTFOLIO_INTEGRATION.md` (656), `PORTFOLIO_SETUP.md` (568),
`WEBSOCKET_SPECIFICATION.md` (362), `PORTFOLIO_QUICK_START.md` (359),
`RBAC.md`, `GRAPHQL_GATEWAY.md`, `monitoring.md`, `module-registry.md`,
`kubernetes-health-probes.md` and `MULTI_WALLET_MANAGEMENT.md`.

The README links to about seven of them. The rest — plus `PROJECT_STATUS.md`
(418 lines), `PROFILING.md`, `src/observability/PROFILING_GUIDE.md`,
`src/payments/README.md` and `monitoring/README.md` — are only findable by
browsing the tree.

## Why this matters

Roughly 5,000 lines of good documentation is partially invisible. A contributor
looking for the WebSocket contract or the RBAC model has no reason to think
those documents exist. This is pure recovered value from work already done.

## Tasks

- [ ] Add a `## Documentation` section to the README with every markdown file, grouped by topic
- [ ] Give each a one-line description of what the reader will find
- [ ] Include the nested ones (`src/payments/README.md`, `src/observability/PROFILING_GUIDE.md`, `monitoring/README.md`)
- [ ] Verify every relative link resolves on the rendered GitHub page
- [ ] Consider whether the PORTFOLIO_* quartet should be consolidated — flag it, do not do it here

## Files to look at

- `README.md`
- `docs/`
- `PROJECT_STATUS.md`
- `PROFILING.md`
- `src/payments/README.md`
- `monitoring/README.md`

## Acceptance criteria

- Every markdown file is reachable from the README in one click
- Each entry has a one-line description
- No broken relative links on GitHub

---

**Skills:** Markdown  
**Estimated effort:** 1 hour

### 7. The OpenAPI spec is generated in CI but published nowhere

**Labels:** `documentation`, `ci`, `help wanted`

The OpenAPI pipeline is well built and ends in a cul-de-sac:

- `npm run openapi:export` generates `docs/openapi.json`
- `npm run openapi:validate` checks it
- `npm run openapi:client` generates TypeScript and Python clients from it
- `.github/workflows/build-check.yml` has a dedicated `openapi` job that runs on
  pushes to main and uploads the results as workflow artifacts

`docs/openapi.json` is gitignored (line 156), which is a reasonable choice for a
generated file. But the result is that the spec exists only as a CI artifact
behind a login, and Swagger UI is only reachable by running the service locally
(`/api/docs`, and it is opt-in in production via `SWAGGER_ENABLED`).

## Why this matters

There is no URL anyone can send to an integrator. The frontend team, a partner,
or a Wave reviewer wanting to see the API surface has to clone the repository,
install dependencies and boot the service. For a project whose application form
asks for documentation links, that is a real gap — and the hard part is already
done.

## Tasks

- [ ] Decide where to publish — GitHub Pages is the cheapest option
- [ ] Extend the existing `openapi` job to deploy a rendered spec (Redoc or Swagger UI) to Pages
- [ ] Publish the raw `openapi.json` at a stable URL so clients can be generated from it
- [ ] Add a CI check that fails when the committed route surface and the generated spec disagree
- [ ] Link the published URL from the README and from the frontend repository

## Files to look at

- `.github/workflows/build-check.yml`
- `scripts/export-openapi.ts`
- `scripts/validate-openapi.ts`
- `src/config/swagger.config.ts`
- `README.md`

## Acceptance criteria

- The API reference is browsable at a public URL without cloning
- The raw spec is fetchable at a stable URL
- The published docs rebuild on every merge to `main`

---

**Skills:** GitHub Actions, OpenAPI  
**Estimated effort:** 1 day

---

## Stage 2 — Core contributor work

The substance of the programme: real features, real test coverage, real bug fixes. Each has a defined acceptance test. Post once Stage 1 has cleared and reviewers have bandwidth.

### 8. Webhook subscriptions are created with a hardcoded `userId = "system"`

**Labels:** `bug`, `security`, `help wanted`

`src/infrastructure/webhooks/webhook.controller.ts`, `createSubscription`:

```ts
async createSubscription(@Body() dto: CreateWebhookSubscriptionDto) {
  // TODO: extract userId from auth guard
  const userId = "system";
  const sub = await this.subscriptionService.create(userId, dto);
  ...
}
```

The endpoint takes no authenticated principal. Every webhook subscription
created through it is owned by the literal string `"system"`, and the handler
carries no guard decorator.

## Why this matters

This is the most serious defect I found in the repository, and it is two bugs at
once:

1. **No authorisation.** If the route is reachable without a guard, anyone can
   register a webhook subscription.
2. **No ownership.** Because every subscription belongs to `"system"`, they
   cannot be isolated per user. Any subsequent list, update or delete scoped by
   owner will return or modify *every* subscription, across all users.

The response body even says "Store the signingKey securely — it will not be shown
again", so this endpoint hands out a signing secret.

## Tasks

- [ ] Confirm whether the route is currently reachable unauthenticated — write a failing test that demonstrates it either way
- [ ] Apply the appropriate auth guard, consistent with the rest of the controllers
- [ ] Extract the real user from the request rather than hardcoding
- [ ] Audit the other handlers in this controller for the same pattern
- [ ] Check whether existing `"system"`-owned subscriptions need a data migration
- [ ] Add tests: unauthenticated is rejected, subscriptions are scoped to their owner, one user cannot see another's

## Files to look at

- `src/infrastructure/webhooks/webhook.controller.ts`
- `src/infrastructure/webhooks/services/`
- `src/core/auth/`
- `src/infrastructure/webhooks/services/webhook-hmac.service.ts`

## Acceptance criteria

- The endpoint rejects unauthenticated requests
- Subscriptions are owned by the authenticated user
- A test proves one user cannot read or modify another user's subscriptions
- Any migration needed for existing rows is described in the PR

## Notes

Security-sensitive — not a first contribution, and it needs a careful review.
Please report privately rather than in a public PR description if the route turns
out to be reachable unauthenticated in a deployed environment.

---

**Skills:** NestJS, authentication, guards  
**Estimated effort:** 2–3 days

### 9. API key strategy has no database lookup for user-generated keys

**Labels:** `enhancement`, `security`, `help wanted`

`src/core/auth/strategies/api-key/api-key.strategy.ts` line 175:
`// TODO: Add database lookup for user-generated API keys`

The strategy validates against statically configured keys only. Users cannot
create, rotate or revoke their own.

## Why this matters

Service-to-service auth is advertised in the Swagger metadata as an `X-API-Key`
header, which implies per-consumer keys. Without a database lookup there is one
shared static key: it cannot be revoked for one consumer without breaking all of
them, it cannot be rotated without coordinated downtime, and there is no
per-consumer audit trail.

## Tasks

- [ ] Design the key entity: hashed key, owner, scopes, created/last-used/expires, revoked flag
- [ ] Store only a hash — never the key itself — and show the plaintext once at creation
- [ ] Implement the lookup with caching, since it runs on every request
- [ ] Add endpoints for create, list (metadata only), and revoke
- [ ] Record last-used timestamps for audit
- [ ] Keep the existing static keys working during migration, then deprecate them
- [ ] Add tests: valid key, revoked key, expired key, unknown key, scope enforcement

## Files to look at

- `src/core/auth/strategies/api-key/api-key.strategy.ts`
- `src/core/auth/`
- `src/migrations/`
- `src/config/swagger.config.ts`

## Acceptance criteria

- Users can create, list and revoke their own API keys
- Keys are stored hashed and shown in plaintext exactly once
- Revocation takes effect immediately, including through any cache
- Tests cover valid, revoked, expired and unknown keys

---

**Skills:** NestJS, Passport, TypeORM  
**Estimated effort:** 1 week

### 10. Oracle submission verifier has a placeholder blockchain adapter

**Labels:** `enhancement`, `help wanted`, `blockchain`

`src/blockchain/oracle/submission-verifier.service.ts` line 81:
`// TODO: Replace with actual blockchain adapter (ethers/web3)`

The verifier does not actually talk to a chain. The comment also names
`ethers`/`web3`, which are Ethereum libraries — this project is on Stellar and
already depends on `@stellar/stellar-sdk` ^14. So the placeholder was written
against the wrong ecosystem.

## Why this matters

The whole point of the oracle subsystem is that off-chain data becomes verifiable
on-chain. Without a real adapter, submissions are signed and then never
verified against the ledger, so the trust property the architecture claims does
not hold end to end.

## Tasks

- [ ] Implement the adapter against `@stellar/stellar-sdk` and Soroban RPC, not an Ethereum library
- [ ] Point it at the `oracle-contract` in the `Trellis` repository — note that contract is currently a stub, so coordinate with that work
- [ ] Handle the failure modes: RPC unavailable, transaction not found, insufficient confirmations, network mismatch
- [ ] Make it configurable across testnet and mainnet via existing config
- [ ] Add retry with backoff for transient RPC failures
- [ ] Add tests against a mocked RPC covering each failure mode

## Files to look at

- `src/blockchain/oracle/submission-verifier.service.ts`
- `src/blockchain/oracle/services/payload-signing.service.ts`
- `src/config/env.validation.ts`

## Acceptance criteria

- Submissions are verified against the real ledger
- The Ethereum library reference is gone from code and comments
- Transient RPC failures retry; permanent ones surface clearly
- Tests cover each failure mode

## Notes

Cross-repository: depends on `oracle-contract` in `TRELLIS-STELLAR/Trellis`
existing. Link the two issues and agree the payload shape once, in one thread.

---

**Skills:** TypeScript, Stellar SDK, Soroban  
**Estimated effort:** 1–2 weeks

### 11. Oracle submission verifier queries a placeholder instead of the database

**Labels:** `enhancement`, `help wanted`

`src/blockchain/oracle/submission-verifier.service.ts` line 89:
`// TODO: Replace with DB query`

Submission history is not read from persistent storage, so the verifier cannot
tell whether it has seen a given submission before.

## Why this matters

Without submission history there is no replay protection at the service layer and
no audit trail. A resubmitted payload cannot be recognised as a duplicate, which
matters because the same verifier is what decides whether a submission is
trustworthy.

## Tasks

- [ ] Define the submission entity: payload hash, submitter, timestamp, verification status, transaction hash
- [ ] Write the migration — see `src/migrations/` for the existing pattern
- [ ] Replace the placeholder with a real query
- [ ] Index on the fields used for duplicate detection; this is a hot path
- [ ] Add a retention policy or archival strategy, agreed in the thread
- [ ] Add tests: first submission accepted, duplicate detected, history queryable

## Files to look at

- `src/blockchain/oracle/submission-verifier.service.ts`
- `src/migrations/`
- `src/models/`

## Acceptance criteria

- Submission history persists across restarts
- Duplicate submissions are detected
- The duplicate-detection query is indexed
- Tests cover acceptance, duplicate rejection and history retrieval

---

**Skills:** TypeScript, TypeORM  
**Estimated effort:** 3–5 days

### 12. Rebalancing service: `storeTargetAllocations` is unimplemented

**Labels:** `enhancement`, `help wanted`

`src/portfolio/services/rebalancing.service.ts` line 16:
`// TODO: Implement logic to store target allocations for the portfolio.`

This is the first of three consecutive unimplemented methods in the same file
(lines 16, 29 and 46) — target allocations, recommendations, and execution. The
service is a shell.

## Why this matters

Target allocations are the input to everything else in the rebalancing flow.
Neither recommendations nor execution can be built until a portfolio's desired
allocation can be persisted and read back.

## Tasks

- [ ] Define the target allocation model: portfolio, asset, target weight, updated-at
- [ ] Enforce the invariant that weights sum to 100% (or document the chosen tolerance)
- [ ] Write the migration
- [ ] Implement store and retrieve, with validation on the way in
- [ ] Version or audit changes so allocation history is recoverable
- [ ] Add tests: valid set, weights not summing to 100, unknown asset, update replaces cleanly

## Files to look at

- `src/portfolio/services/rebalancing.service.ts`
- `src/migrations/`
- `src/models/`

## Acceptance criteria

- Target allocations persist and are retrievable
- Invalid weight sets are rejected with a clear error
- Tests cover the validation cases

## Notes

First of three — take all three or coordinate in the thread, as they share a data model.

---

**Skills:** TypeScript, NestJS, TypeORM  
**Estimated effort:** 3–5 days

### 13. Rebalancing service: `calculateRebalancingRecommendations` is unimplemented

**Labels:** `enhancement`, `help wanted`

`src/portfolio/services/rebalancing.service.ts` line 29:
`// TODO: Implement logic to calculate rebalancing recommendations.`

The method that compares current holdings against targets and produces the set
of trades needed to close the gap does not exist.

## Why this matters

This is the analytical core of the feature. It is also the part users will trust
most directly — a recommendation to sell one asset and buy another is acted on
with real money, so the arithmetic and the threshold behaviour need to be right
and testable.

## Tasks

- [ ] Fetch current holdings and the stored target allocations
- [ ] Compute the drift per asset and the trades required to close it
- [ ] Apply a drift threshold so trivial deviations do not generate trades — make it configurable
- [ ] Account for trading fees and minimum trade sizes, so recommendations are not uneconomic
- [ ] Return a structured recommendation: asset, direction, amount, expected drift after
- [ ] Add table-driven tests: already balanced, single asset drifted, all assets drifted, drift below threshold, empty portfolio

## Files to look at

- `src/portfolio/services/rebalancing.service.ts`
- `src/investment/portfolio/services/`
- `src/defi/`

## Acceptance criteria

- Recommendations close the gap between current and target allocations
- Drift below the configured threshold produces no trades
- Fees and minimum trade sizes are accounted for
- Table-driven tests cover the listed scenarios

## Notes

Depends on the target allocations issue.

---

**Skills:** TypeScript, NestJS, portfolio mathematics  
**Estimated effort:** 1 week

### 14. Rebalancing service: `executeRebalancing` is unimplemented

**Labels:** `enhancement`, `help wanted`, `blockchain`

`src/portfolio/services/rebalancing.service.ts` line 46:
`// TODO: Implement logic to execute rebalancing trades.`

The third of the three stubs. Nothing executes the recommended trades.

## Why this matters

This is the method that moves user funds, so it carries the most risk in the
trio. Partial execution is the central problem: if three of five trades succeed
and two fail, the portfolio is left in a state that matches neither the original
allocation nor the target, and the user needs to know that.

## Tasks

- [ ] Agree the execution model in the thread: all-or-nothing, or best-effort with reporting?
- [ ] Implement execution through the existing payment and transaction services rather than a new path
- [ ] Make the operation idempotent so a retry cannot double-execute
- [ ] Record every attempt and its outcome before and after submission
- [ ] Handle partial failure explicitly — report which trades executed and what the resulting allocation is
- [ ] Add a dry-run mode that reports what would happen without submitting
- [ ] Add tests: full success, partial failure, total failure, retry after partial

## Files to look at

- `src/portfolio/services/rebalancing.service.ts`
- `src/investment/portfolio/services/trading-transaction.service.ts`
- `src/payments/`

## Acceptance criteria

- Recommended trades are actually executed
- A retry cannot double-execute
- Partial failure is reported with the resulting allocation, not swallowed
- Dry-run mode works and is covered by tests

## Notes

Handles real funds. Needs careful review and should land after the other two.

---

**Skills:** TypeScript, NestJS, Stellar SDK  
**Estimated effort:** 1–2 weeks

### 15. `trading-transaction.service.ts` has no trade execution logic

**Labels:** `enhancement`, `help wanted`, `blockchain`

`src/investment/portfolio/services/trading-transaction.service.ts` line 17:
`// TODO: Implement actual trade execution logic here`

The service other components call to execute trades — including the rebalancing
execution above — does not execute trades.

## Why this matters

This is the shared execution primitive. Rebalancing, portfolio management and
anything else that needs to move assets all route through it, so it is the
right place to implement submission, confirmation and error handling once rather
than in each caller.

## Tasks

- [ ] Define the trade request and result contracts before implementing
- [ ] Build, sign and submit the transaction via `@stellar/stellar-sdk`
- [ ] Wait for confirmation with a sensible timeout, and distinguish 'timed out' from 'failed'
- [ ] Handle: insufficient balance, trustline missing, price moved beyond slippage tolerance, network error
- [ ] Persist every trade with its resulting transaction hash
- [ ] Make submission idempotent via a client-supplied reference
- [ ] Add tests against a mocked Horizon/RPC covering each failure mode

## Files to look at

- `src/investment/portfolio/services/trading-transaction.service.ts`
- `src/payments/`
- `src/blockchain/`

## Acceptance criteria

- Trades submit and confirm on the configured network
- Every listed failure mode is handled distinctly
- A timed-out submission is never reported as failed without checking the ledger
- Trades are persisted with their transaction hash

---

**Skills:** TypeScript, NestJS, Stellar SDK  
**Estimated effort:** 1–2 weeks

---

## Stage 3 — Needs a maintainer decision first

Worth doing, but the approach should be agreed in the issue thread before anyone writes code. Post with a maintainer already assigned to discuss.

### 16. Decide and execute the database identifier rename

**Labels:** `refactor`, `needs discussion`, `ops`

The rebrand deliberately left the database identifiers alone, so twelve
references to the old project name remain:

- `src/common/database/database.config.ts` — `"alian-structure"`,
  `"alian-structure-staging"`, `"alian-structure-production"`
- `src/common/database/environments/development.config.ts` —
  `process.env.DB_DATABASE ?? "alianStructure"`
- `test/oracle-e2e.spec.ts` — `process.env.DB_NAME || "alian-structure_test"`
- `docker-compose.yml` — `POSTGRES_USER`/`POSTGRES_DB` defaults and the
  `pg_isready` healthcheck
- `.env.example`, `docs/PORTFOLIO_SETUP.md` — connection strings

They were kept so existing databases and Docker volumes keep working.

## Why this matters

It is the last place the old name survives in any of the three repositories.
Leaving it is defensible; the reason it needs a decision rather than a patch is
that renaming a database is an operational change, not a code change — existing
volumes and deployed databases keep their old names regardless of what the code
says.

## Tasks

- [ ] Decide in the thread whether to rename at all — 'no, and document why' is a legitimate outcome
- [ ] If renaming: write the migration runbook first (rename vs. dump-and-restore, and the downtime implied)
- [ ] Change the defaults in code and compose only after the runbook is agreed
- [ ] Provide a compatibility window where `DB_DATABASE` can override, so deployments can migrate independently
- [ ] Update `.env.example` and `docs/PORTFOLIO_SETUP.md` together with the code
- [ ] Note the Docker volume implications — an existing volume will not rename itself

## Files to look at

- `src/common/database/database.config.ts`
- `src/common/database/environments/development.config.ts`
- `docker-compose.yml`
- `.env.example`
- `docs/PORTFOLIO_SETUP.md`
- `test/oracle-e2e.spec.ts`

## Acceptance criteria

- A decision is recorded in the issue, either way
- If renamed: a runbook exists and a fresh `docker compose up` works end to end
- If not renamed: the reason is documented where a future contributor will find it

---

**Skills:** TypeScript, PostgreSQL, deployment  
**Estimated effort:** 2–3 days plus coordination

### 17. Auth service has an unimplemented reward service integration

**Labels:** `enhancement`, `needs discussion`

`src/core/auth/auth.service.ts` line 81:
`// TODO: Implement reward service integration when available`

Registration does not notify any reward or referral system, so a signup arriving
through a referral link is not attributed at the point of registration.

## Why this matters

This is the join between authentication and the referral economics implemented in
`referral-contract` and surfaced in the frontend's affiliate dashboard. Until it
exists, referral attribution has a hole exactly where it matters most — at
signup.

It needs discussion because the boundary is not obvious: attribution could live
in auth, in a dedicated referral module, or be event-driven.

## Tasks

- [ ] Agree the integration boundary in the thread — direct call, domain event, or queue?
- [ ] Prefer an event so auth does not take a hard dependency on the reward system's availability
- [ ] Make sure a reward-system failure cannot fail a registration
- [ ] Define what is attributed: referral code, timestamp, referring user
- [ ] Coordinate with the frontend's affiliate referral work so the code format matches
- [ ] Add tests including the reward-system-unavailable path

## Files to look at

- `src/core/auth/auth.service.ts`
- `src/growth/`
- `src/notifications/`

## Acceptance criteria

- Registration attributes a referral when one is present
- A reward-system outage does not prevent registration
- The integration mechanism is documented
- Tests cover the attributed, unattributed and degraded paths

## Notes

Cross-repository: coordinate with the referral work in the frontend and contracts repos.

---

**Skills:** TypeScript, NestJS  
**Estimated effort:** 3–5 days

### 18. ML prediction service uses a placeholder portfolio weight

**Labels:** `enhancement`, `needs discussion`

`src/investment/portfolio/services/ml-prediction.service.ts` line 134:
`// TODO: Get weight from portfolio`

The prediction runs against a placeholder weight rather than the asset's actual
weight in the portfolio being analysed.

## Why this matters

A prediction computed against the wrong weights is not a less accurate
prediction — it is a prediction about a different portfolio. Any output derived
from it is misleading, and it looks authoritative, which is the dangerous
combination.

## Tasks

- [ ] Establish where portfolio weights are authoritative — this overlaps with `src/portfolio/` and needs agreement
- [ ] Fetch real weights for the portfolio under analysis
- [ ] Handle the edge cases: empty portfolio, single asset, asset with zero weight
- [ ] Decide what the service should do when weights are unavailable — failing loudly beats predicting on defaults
- [ ] Add tests asserting that different weight distributions produce different predictions

## Files to look at

- `src/investment/portfolio/services/ml-prediction.service.ts`
- `src/portfolio/`
- `src/defi/`

## Acceptance criteria

- Predictions use the analysed portfolio's real weights
- Unavailable weights produce an explicit error rather than a silent default
- A test proves predictions vary with the weight distribution

---

**Skills:** TypeScript, portfolio mathematics  
**Estimated effort:** 3–5 days

### 19. Add integration tests against Stellar testnet

**Labels:** `test`, `needs discussion`

There are 105 spec files, but the blockchain interactions are tested against
mocks. `test/oracle-e2e.spec.ts` exists and is the closest thing to an
integration test, and it still does not exercise a real network.

The service talks to Horizon (`horizon-testnet.stellar.org` appears in the docs)
and is meant to submit to the Soroban contracts in the sibling repository.

## Why this matters

Mocks encode what you believe the chain does. They stay green when the SDK
changes its response shape, when a contract's interface changes, or when a
transaction is rejected for a reason you did not anticipate. Given this service
submits oracle payloads and initiates payments, the gap between "the mock says
it worked" and "the ledger says it worked" is where the expensive bugs live.

## Tasks

- [ ] Agree scope and cost in the thread — testnet tests are slow and flaky, so they should not gate every PR
- [ ] Set up a funded testnet account via friendbot in CI
- [ ] Write integration tests for: payment submission, oracle submission, transaction confirmation, failure on insufficient balance
- [ ] Run them on a schedule or on a label, not on every pull request
- [ ] Make failures actionable — distinguish 'our code is wrong' from 'testnet is down'
- [ ] Document how to run them locally

## Files to look at

- `test/`
- `test/oracle-e2e.spec.ts`
- `jest.config.js`
- `.github/workflows/build-check.yml`

## Acceptance criteria

- Core blockchain interactions are exercised against real testnet
- The suite runs on a schedule rather than blocking PRs
- Testnet outages are distinguishable from genuine failures
- Local instructions are documented

## Notes

Cross-repository: most valuable once `oracle-contract` is deployed to testnet.

---

**Skills:** TypeScript, Jest, Stellar SDK  
**Estimated effort:** 1–2 weeks

### 20. `src/` has 30+ top-level modules with overlapping portfolio concerns

**Labels:** `refactor`, `needs discussion`, `architecture`

`src/` contains more than thirty top-level directories: `api`, `billing`,
`blockchain`, `common`, `config`, `core`, `dashboard`, `defi`, `discovery`,
`email`, `graphql`, `growth`, `health`, `infrastructure`, `investment`,
`logging`, `migrations`, `models`, `modules`, `monitoring`, `notifications`,
`observability`, `payments`, `portfolio`, `profiling`, `rate-limiting`,
`reconciliation`, `search`, `simulator` and `types`.

Several clearly overlap. Portfolio logic lives in at least three places:
`src/portfolio/`, `src/investment/portfolio/` and `src/defi/`. The rebalancing
service is in `src/portfolio/services/` while the trading transaction service it
needs is in `src/investment/portfolio/services/`. There is also both a
`src/modules/` and a set of top-level modules.

## Why this matters

A contributor asked to "fix rebalancing" has to search three directories to find
where the logic lives, and then guess where new code belongs. That guess is how
the overlap grew in the first place, so it compounds. `docs/module-registry.md`
exists and is 143 lines, which suggests the problem is already recognised.

## Tasks

- [ ] Produce an inventory: module, responsibility, what depends on it
- [ ] Identify the genuine overlaps — portfolio is the obvious one; check `modules/` versus the top-level layout too
- [ ] Agree a target structure in the thread before moving any file
- [ ] Move incrementally, one concern at a time, keeping tests green at each step
- [ ] Update `docs/module-registry.md` to describe the result
- [ ] Add a short architecture note so the next contributor knows where things go

## Files to look at

- `src/`
- `src/portfolio/`
- `src/investment/portfolio/`
- `src/defi/`
- `src/modules/`
- `docs/module-registry.md`

## Acceptance criteria

- An inventory of every top-level module and its responsibility exists
- Portfolio logic has one clear home
- `docs/module-registry.md` reflects the real structure
- No behaviour change — the test suite passes unchanged

## Notes

Large and disruptive. Do not start moving files before the thread agrees a target,
and expect to land it as a series of PRs rather than one.

---

**Skills:** NestJS, architecture  
**Estimated effort:** 1–2 weeks

---

## Posting these

```bash
# from the repository root, with the GitHub CLI authenticated
./.github/create-issues.sh 1     # post stage 1
./.github/create-issues.sh 2     # later
./.github/create-issues.sh 3

./.github/create-issues.sh 1 --dry-run   # print without creating
```

The script reads `.github/wave-issues.json`, which is generated from the same source as this file. Edit the JSON if you want to tweak wording before posting; this document is the readable copy.

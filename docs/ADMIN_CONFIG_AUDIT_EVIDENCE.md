# Audit evidence for administrative configuration changes (#280)

Administrative configuration changes now leave tamper-evident evidence in the
sensitive-action audit trail (see [SENSITIVE_ACTION_AUDIT.md](SENSITIVE_ACTION_AUDIT.md)),
and a change whose evidence cannot be written does not take effect.

## Covered changes

| Route | Catalogue action | Resource |
| --- | --- | --- |
| `POST /status/maintenance` | `config.maintenance-window.changed` (`operation: activate`) | `status.maintenance-window/global` |
| `POST /status/maintenance/clear` | `config.maintenance-window.changed` (`operation: clear`) | `status.maintenance-window/global` |
| `POST /status/degradation` | `config.status-degradation.changed` (`operation: declare`) | `status.component-degradation/<componentId>` |
| `POST /status/degradation/clear` | `config.status-degradation.changed` (`operation: clear`) | `status.component-degradation/<componentId>` |
| `POST /pause-control/activate` | `config.emergency-pause.toggled` (`operation: activate`) | `pause-scope/<scope>` |
| `POST /pause-control/resume` | `config.emergency-pause.toggled` (`operation: resume`) | `pause-scope/<scope>` |

Each event records actor id and role, client IP and user agent, the mandatory
reason, a sanitized snapshot of the configuration **before and after** the
change, and an outcome (`applied`, `apply_failed`, `unauthorized`). Events are
hash-chained, so `GET /audit-trail/sensitive-actions/integrity` detects edits,
deletions and reordering.

New domain code should use `AdminConfigAuditService.applyWithEvidence()` from
`AdminConfigAuditModule` rather than recording events by hand.

## Behaviour

1. **Authorization.** Route guards (JWT + `ADMIN` + admin 2FA) are unchanged.
   The service checks the role again, so a background job or a new caller cannot
   skip it. A refused attempt is recorded as a `failed` event and returns 403.
2. **Normal path.** Snapshot → apply → snapshot → append evidence.
3. **Change fails.** A `failed` event with the before state and the error type
   is recorded (best effort) and the original error is returned.
4. **Evidence write fails.** It is retried with backoff (3 attempts). Concurrent
   writers racing on the chain head and short database blips are absorbed here.
5. **Evidence still cannot be written.** The change is **reverted** to the
   before snapshot and the request fails with **503** ("rolled back because its
   audit evidence could not be recorded"). Status transitions and pause events
   are re-emitted so the public status reflects the reverted state, and the
   pause audit table gets a `rollback` row.
6. **Revert also fails.** 503 with "manual reconciliation required" and a
   `CRITICAL` log line naming the action and resource. The change is live and
   unaudited; reconcile by hand (below).

## Retries and idempotency

The six routes are marked `@Idempotent()`. A client that retries with the same
`Idempotency-Key` gets the stored response replayed: the change is not applied
again and no duplicate evidence is written. Reusing a key with a different body
returns 409 (see [IDEMPOTENCY.md](IDEMPOTENCY.md)). Without the header the
routes behave as before.

## Operational edge cases

* **Audit database unavailable.** Operator changes fail with 503 and are rolled
  back. This is deliberate. If an emergency pause must be applied while the audit
  store is down, restore the store first, or apply the pause directly in the
  database and have an engineer record the action afterwards with
  `SensitiveActionAuditService.recordSensitiveAction()` (one-off script) and a
  reason, so the trail stays complete.
* **Chain head mismatch** ("does not match its recorded chain head"). The
  audit service refuses to append to a chain that was edited out of band. Every
  admin change is then rolled back until the chain is investigated, which is
  the intended fail-closed outcome. Use the `integrity` route to find the break.
* **Manual reconciliation** after a CRITICAL log: compare the current
  configuration with the `beforeState` in the log context, put the intended
  state back, then record the corrective action (as above) with a reason.
* **Secrets in configuration.** Before/after states pass through the audit
  sanitizer; secret-looking keys are redacted and listed in `redactedPaths`.

## Contracts and migration

Routes, request bodies and success responses are unchanged. New failure modes
are a 403 for a role that bypassed the guard and a 503 when evidence cannot be
recorded. `PublicStatusService` and `PauseControlService` behave exactly as
before when `AdminConfigAuditService` is not provided (unit tests, standalone
use). Two catalogue entries were added; no migration is needed because
`sensitive_action_events.action` is a free-form column.

**Rollback:** reverting the change restores the previous behaviour. Evidence
already written stays valid in the chain.

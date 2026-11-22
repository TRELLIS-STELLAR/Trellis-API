# Email Template Locale Fallback Resolver and Bounce Suppression List

## Overview

Addresses **Issue #519**: Implements automated RFC 5646 locale fallback resolution for email templates and an automated bounce suppression system to protect sender reputation, preserve deliverability metrics, and eliminate wasted provider quota.

---

## 1. Locale Fallback Resolver

### Resolution Chain
When a template is requested for a specific regional or dialect locale tag (e.g., `fr-CA`, `es-MX`, `zh-Hant-HK`), the resolver decomposes the locale progressively down to base languages and the configured system fallback:

```
fr-CA ──> fr ──> en (Default)
zh-Hant-HK ──> zh-Hant ──> zh ──> en (Default)
```

Optional tenant-level fallback defaults can be inserted before the final system default (`tenantFallbackLocale`).

### Resolution Telemetry
Every resolution returns structured metadata:
- `name`: Template identifier.
- `requestedLocale`: The exact normalized locale string passed in the request.
- `resolvedLocale`: The actual locale resolved in the fallback hierarchy.
- `fallbackUsed`: Boolean flag indicating whether fallback occurred (`resolvedLocale !== requestedLocale`).
- `chainTraversed`: Array of locales evaluated in order until a match was found.
- `fromCache`: Whether the resolution was served from the bounded in-memory cache.

### Strict Mode & Error Handling
- **Strict Resolution**: When `strict: true` is passed, the resolver only checks the exact requested locale. If the template is missing in that specific dialect, it immediately throws `NotFoundException` rather than falling back.
- **Missing Template**: If a template name does not exist across any locale in the chain, it throws `NotFoundException` detailing the searched path.

---

## 2. Bounce Suppression List

### Suppression Classification
1. **Permanent Suppressions**:
   - `hard_bounce`: Mailbox does not exist, domain does not exist, or permanent 5xx rejection.
   - `spam_complaint`: Recipient filed an abuse complaint or marked email as spam.
   - `manual_suppression`: Operator or automated compliance hold.
   - `unsubscribe`: Recipient opted out via unsubscribe flow.
2. **Temporary Bounded Suppressions**:
   - `soft_bounce`: Transient failures (mailbox full, server temporary overload).
   - Tracked via consecutive failure counters (`bounceCount`).
   - Reaching threshold (`softBounceThreshold: 3`) triggers temporary suppression with configurable TTL (`softBounceTtlMs: 14 days`).
   - Expired soft-bounce entries are automatically lifted upon subsequent checks or via `clearExpiredSuppressions()`.

### Delivery Success Invariant
When an email is successfully delivered to an address with prior transient soft bounces, the soft bounce counter is reset to `0`, preventing spurious threshold triggering on healthy accounts.

---

## 3. RBAC & Administrative Controls

Suppression management is protected under role-based access control:
- **Authorization**: Only `ADMIN` or `SUPPORT` roles may manually suppress addresses, lift suppressions, or clear entries.
- **Auditability**: Unsuppressing an address records `unsuppressedAt`, `unsuppressedBy`, and mandatory audit reason strings.
- **Fail-Safe Dispatch**: Any attempt by `sendEmail` or `retryFailed` to dispatch to a suppressed recipient is halted pre-flight, logging a warning and returning `EmailStatus.FAILED` with suppression details without consuming provider quota.

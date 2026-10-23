# Strict allow-list validation for URLs, file types and destinations (#279)

Inputs that make the server **send a request** or **store a file** are
validated against explicit allow-lists. A value is accepted only if every
property is allowed, rather than rejected only when it matches a known-bad
pattern.

Code: `src/common/validators/allow-list/`.

## Outbound destinations (webhooks)

`DestinationAllowListService` checks webhook URLs when a subscription is
**created or updated** (400 with a stable `code`) and again **immediately
before every delivery**.

| Rule | Default |
| --- | --- |
| Scheme | `https` only |
| Credentials in URL | rejected |
| Port | `443` (plus `80` when http is enabled) |
| Host | any public FQDN, or only the configured allow-list |
| IP-literal hosts | rejected (`https://127.0.0.1`, `https://2130706433`, `https://[::1]`) |
| Internal names | rejected (`localhost`, `*.local`, `*.internal`, `*.lan`, `*.corp`, single-label names, cloud metadata hosts) |
| Resolved addresses | every DNS answer must be public (no loopback, RFC 1918, link-local / `169.254.169.254`, CGNAT, multicast, IPv4-mapped IPv6 of those) |

| Variable | Example |
| --- | --- |
| `WEBHOOK_DESTINATION_ALLOWED_HOSTS` | `hooks.partner.io,*.example.com` (`*.` matches subdomains only, at a label boundary) |
| `WEBHOOK_DESTINATION_ALLOWED_PORTS` | `443,8443` |
| `WEBHOOK_DESTINATION_ALLOW_HTTP` | `true` (local development only) |

At delivery time:

* the request connects **only to the addresses that were validated** (pinned
  DNS lookup), which closes the DNS-rebinding gap between check and connect;
* **redirects are not followed** (`maxRedirects: 0`), so an allowed host cannot
  bounce the request to an internal address. A 3xx counts as a failed attempt;
* a **policy violation** (`retryable: false`) dead-letters the delivery
  immediately instead of using up retries;
* a **DNS failure** (`DESTINATION_DNS_FAILED`, `retryable: true`) follows the
  normal backoff and retry schedule.

Violation codes: `DESTINATION_INVALID`, `DESTINATION_TOO_LONG`,
`DESTINATION_PROTOCOL_NOT_ALLOWED`, `DESTINATION_CREDENTIALS_NOT_ALLOWED`,
`DESTINATION_PORT_NOT_ALLOWED`, `DESTINATION_IP_LITERAL_NOT_ALLOWED`,
`DESTINATION_HOST_NOT_ALLOWED`, `DESTINATION_PRIVATE_ADDRESS`,
`DESTINATION_DNS_FAILED`.

## File types (uploads)

`FileValidationService` now also runs `checkFileTypeAllowList()`. A file is
accepted only when its **extension**, **declared MIME type** and **content**
(magic-byte signature, or valid UTF-8 without NUL bytes for text types) agree on
one entry of `FILE_TYPE_ALLOW_LIST`. Names that hide an executable or active
extension (`invoice.exe.pdf`, `x.html.png`) and names with control or path
characters are rejected.

No longer accepted, because they carry active content: **SVG**
(`image/svg+xml`, script), **HTML**, **XML** (`application/xml`, external
entities). Every other previously accepted type is still allowed, now with a
content check.

| `FILE_TYPE_ALLOWLIST_MODE` | Behaviour |
| --- | --- |
| `enforce` (default) | reject files that fail the strict check |
| `report` | accept, but log `[allow-list report-only] ... would be rejected` |
| `off` | previous behaviour only (emergency rollback) |

## Migration plan

1. **Webhook subscriptions created before this change** are re-validated on
   their next delivery. Any that point at `http://`, non-443 ports, IP literals or
   internal hosts are dead-lettered with
   `Destination blocked by allow-list (<code>)`. Before deploying, list them:
   ```sql
   SELECT id, "userId", url FROM webhook_subscriptions
   WHERE status = 'active' AND (url NOT LIKE 'https://%' OR url ~ '^https://[0-9\[]');
   ```
   Ask the owners to update the URL, or set `WEBHOOK_DESTINATION_ALLOW_HTTP` /
   `WEBHOOK_DESTINATION_ALLOWED_PORTS` temporarily. Dead-lettered deliveries can
   be retried through the existing dead-letter endpoint once fixed.
2. **Uploads.** Deploy with `FILE_TYPE_ALLOWLIST_MODE=report` first, watch for
   `[allow-list report-only]` log lines (typically mislabelled MIME types or
   SVGs), then switch to `enforce`.
3. **Rollback.** `FILE_TYPE_ALLOWLIST_MODE=off` restores the previous upload
   behaviour without a deploy. For webhooks, widen the allow-list variables, or
   revert. Nothing is migrated in the database, so a revert is clean.

## Edge cases

* **Partner behind a CDN with changing IPs.** Fine: addresses are resolved and
  checked on every delivery, and pinning lasts for one request only.
* **Partner that answers with a redirect.** Ask them for the final URL; 3xx is
  treated as failure on purpose.
* **IPv6-only destinations.** Supported; pinned lookups return the AAAA records
  that were validated.
* **Split-horizon DNS** (a public name resolving to an internal IP inside the
  VPC) is blocked. That is the attack this rule exists to stop.

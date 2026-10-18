# Durable Notification Preference & Mandatory-Alert Routing Model (#243)

## Overview
While users must have full control over routine notifications (marketing, social updates, and daily digests), vital lifecycle, security, and compliance alerts must guarantee delivery without being silenced or suppressed by user preferences, quiet hours, or batching.

The enhanced notification architecture introduces a **Mandatory-Alert Routing Model** with **Durable Preference Storage**:

### 1. Mandatory Alert Identification
Notifications meeting any of the following criteria are classified as **Mandatory Alerts**:
- `priority === NotificationPriority.CRITICAL`
- `category === NotificationCategory.SECURITY`
- `category === NotificationCategory.COMPLIANCE`
- Explicit metadata flag: `metadata.isMandatory === true`

### 2. Guaranteed Delivery Semantics
Mandatory alerts bypass all discretionary suppression rules:
- **Opt-Out Preference Bypass**: If a user sets a channel preference to `DISABLED`, mandatory alerts continue to deliver over that channel.
- **Quiet Hours Bypass**: Active quiet hours and timezone delays are bypassed so urgent security notifications arrive instantly.
- **Digest Deferral Bypass**: Mandatory alerts are never bundled into daily or weekly digests.
- **Minimum Priority Filter Bypass**: Strict priority threshold settings (`minPriority`) are overridden.
- **Guaranteed Fallback Addressing**: If recipient contact details (e.g., SMS phone number) are missing for the target channel, the processor automatically resolves fallback addresses or routes via `IN_APP` so no alert is dropped.

### 3. Preference Durability & Administration Guards
- `NotificationPreferenceService.updatePreference` rejects attempts to disable mandatory categories (`SECURITY`, `COMPLIANCE`) on primary channels (`EMAIL`, `IN_APP`) with `BadRequestException`.
- Preset configurations (e.g. `all_off`) strictly maintain `ENABLED` state for mandatory security and compliance alerts on primary channels.
- Default preferences seed durable active routing for all users.

### 4. Auditing & Deliverability Logs
Whenever a user's discretionary preference is overridden to route a mandatory alert, the processor logs an audit note in `notification_delivery_logs`:
```json
{
  "bypassedUserPreference": true,
  "bypassReason": "MANDATORY_ALERT"
}
```

## Architecture & Tests
- `src/notifications/entities/notification-preference.entity.ts`: Entity schema for user preferences, quiet hours, and channel endpoints.
- `src/notifications/services/notification-preference.service.ts`: Preference management with policy validation.
- `src/notifications/services/notification-processor.service.ts`: Delivery engine with mandatory alert bypass and audit logging.
- `src/notifications/test/mandatory-alert-routing.spec.ts`: Test suite covering preference guards, bypass rules, fallback routing, and audit logs.

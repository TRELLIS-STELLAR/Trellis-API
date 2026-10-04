# Trellis Domain Event Schemas & Versioned Consumers

Trellis domain events enforce explicit, versioned payload schemas to ensure downstream consumers process events reliably without payload drift.

## Architectural Overview

- **Producer Validation**: Every event emitted via `DomainEventProducer` is validated against the `DomainEventRegistry` before being published to the transport.
- **Explicit Versioning**: All domain event payloads include an explicit `schemaVersion` string (e.g., `"1.0"`, `"2.0"`).
- **Versioned Consumers**: Consumers register handlers for specific schema versions and can declare a fallback handler to handle older or unmapped version payloads gracefully.

## Event Payload Structure

```json
{
  "eventId": "evt-12345678",
  "eventName": "user.created",
  "schemaVersion": "1.0",
  "timestamp": "2026-10-04T08:00:00.000Z",
  "producer": "trellis-api",
  "payload": {
    "userId": "usr_99887766",
    "email": "user@example.com",
    "role": "user"
  }
}
```

## Consumer Compatibility Rules

1. **Backwards Compatibility**: Minor schema additions maintain fallback compatibility.
2. **Version Registration**: Consumers should register handlers for versions they explicitly support (`registerHandler('event.name', '1.0', handler)`).
3. **Consumer Fallback**: When an unknown or older schema version is received, the consumer fallback handler (`registerFallbackHandler('event.name', fallbackFn)`) translates or handles the payload without raising fatal errors.

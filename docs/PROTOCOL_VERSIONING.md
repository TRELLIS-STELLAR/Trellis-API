# Protocol Configuration Versioning & Compatibility

Trellis API enforces strict semver compatibility rules on protocol configuration consumed across services, background jobs, and contracts.

## Version Policy

- **Current Version**: `1.2.0`
- **Minimum Supported Version**: `1.0.0`
- **Maximum Supported Version**: `1.99.99`

## Compatibility Verification Flow

Before initiating dependent operations (such as contract invocations, ledger sync, or batch processing), the system validates incoming protocol version metadata using `assertProtocolCompatibility(version)`.

### Version Matrix

| Version Range | Status | Result / Action |
| --- | --- | --- |
| `>= 1.0.0 <= 1.99.99` | **Compatible** | Execution proceeds cleanly |
| `< 1.0.0` | **Old Incompatible** | Fails early with `IncompatibleProtocolVersionError` (`OLD_INCOMPATIBLE`) |
| `> 1.99.99` (e.g. `2.0.0`) | **Future Unknown** | Fails early with `IncompatibleProtocolVersionError` (`FUTURE_UNKNOWN`) |
| `0.8.0`, `0.9.0` | **Deprecated** | Fails early with `IncompatibleProtocolVersionError` (`DEPRECATED`) |

## Upgrade & Deprecation Guidelines

1. **Upgrades**: Increment minor/patch versions for backwards-compatible changes.
2. **Deprecation**: Update `minSupportedVersion` and add retired versions to `deprecatedVersions` in `src/config/protocol-config-versioning.ts`.

import {
  validateProtocolConfig,
  assertProtocolCompatibility,
  IncompatibleProtocolVersionError,
  CURRENT_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  MAX_SUPPORTED_PROTOCOL_VERSION,
} from './protocol-config-versioning';

describe('Protocol Configuration Versioning & Compatibility Checks (#113)', () => {
  it('should validate current version successfully without warnings', () => {
    const res = validateProtocolConfig(CURRENT_PROTOCOL_VERSION);

    expect(res.compatible).toBe(true);
    expect(res.version).toBe(CURRENT_PROTOCOL_VERSION);
    expect(() => assertProtocolCompatibility(CURRENT_PROTOCOL_VERSION)).not.toThrow();
  });

  it('should validate old-compatible version within supported range', () => {
    const oldCompatibleVersion = '1.0.0';
    const res = validateProtocolConfig(oldCompatibleVersion);

    expect(res.compatible).toBe(true);
    expect(res.version).toBe(oldCompatibleVersion);
    expect(() => assertProtocolCompatibility(oldCompatibleVersion)).not.toThrow();
  });

  it('should fail early with clear error for old-incompatible version below minSupportedVersion', () => {
    const oldIncompatibleVersion = '0.5.0';

    expect(() => validateProtocolConfig(oldIncompatibleVersion)).toThrow(
      IncompatibleProtocolVersionError,
    );

    try {
      assertProtocolCompatibility(oldIncompatibleVersion);
    } catch (err: any) {
      expect(err).toBeInstanceOf(IncompatibleProtocolVersionError);
      expect(err.reason).toBe('OLD_INCOMPATIBLE');
      expect(err.message).toContain(`Minimum required version is '${MIN_SUPPORTED_PROTOCOL_VERSION}'`);
    }
  });

  it('should fail early with clear error for future-unknown version exceeding maxSupportedVersion', () => {
    const futureUnknownVersion = '2.0.0';

    expect(() => validateProtocolConfig(futureUnknownVersion)).toThrow(
      IncompatibleProtocolVersionError,
    );

    try {
      assertProtocolCompatibility(futureUnknownVersion);
    } catch (err: any) {
      expect(err).toBeInstanceOf(IncompatibleProtocolVersionError);
      expect(err.reason).toBe('FUTURE_UNKNOWN');
      expect(err.message).toContain(`Maximum supported version is '${MAX_SUPPORTED_PROTOCOL_VERSION}'`);
    }
  });

  it('should fail early for deprecated versions', () => {
    const deprecatedVersion = '0.9.0';

    try {
      validateProtocolConfig(deprecatedVersion);
    } catch (err: any) {
      expect(err).toBeInstanceOf(IncompatibleProtocolVersionError);
      expect(err.reason).toBe('DEPRECATED');
      expect(err.message).toContain('is deprecated');
    }
  });

  it('should throw for invalid semver strings', () => {
    expect(() => validateProtocolConfig('not-a-version')).toThrow(
      IncompatibleProtocolVersionError,
    );
  });
});

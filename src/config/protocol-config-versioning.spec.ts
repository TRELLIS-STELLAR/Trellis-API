import {
  validateProtocolConfig,
  assertProtocolCompatibility,
  IncompatibleProtocolVersionError,
  CURRENT_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  MAX_SUPPORTED_PROTOCOL_VERSION,
  DEFAULT_PROTOCOL_CONFIG,
  validateProtocolConfigsAcrossEnvironments,
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

  describe('cross-environment compatibility', () => {
    const configs = (versions: {
      development: string;
      staging: string;
      production: string;
    }) => ({
      development: {
        ...DEFAULT_PROTOCOL_CONFIG,
        configVersion: versions.development,
      },
      staging: {
        ...DEFAULT_PROTOCOL_CONFIG,
        configVersion: versions.staging,
      },
      production: {
        ...DEFAULT_PROTOCOL_CONFIG,
        configVersion: versions.production,
      },
    });

    it('accepts aligned compatible protocol versions in every environment', () => {
      const report = validateProtocolConfigsAcrossEnvironments(
        configs({
          development: '1.2.0',
          staging: '1.2.0',
          production: '1.2.0',
        }),
      );

      expect(report.compatible).toBe(true);
      expect(report.versionsAligned).toBe(true);
      expect(report.environments.every((environment) => environment.compatible)).toBe(true);
    });

    it('reports version skew without hiding per-environment compatibility', () => {
      const report = validateProtocolConfigsAcrossEnvironments(
        configs({
          development: '1.2.0',
          staging: '1.1.0',
          production: '1.2.0',
        }),
      );

      expect(report.compatible).toBe(false);
      expect(report.versionsAligned).toBe(false);
      expect(report.environments.every((environment) => environment.compatible)).toBe(true);
    });

    it('identifies a failing environment and allows the check to pass after correction', () => {
      const failing = configs({
        development: '1.2.0',
        staging: '1.2.0',
        production: '2.0.0',
      });
      const report = validateProtocolConfigsAcrossEnvironments(failing);

      expect(report.compatible).toBe(false);
      expect(report.environments[2]).toMatchObject({
        environment: 'production',
        compatible: false,
      });
      expect(report.environments[2].error).toContain('Maximum supported version');

      failing.production = {
        ...DEFAULT_PROTOCOL_CONFIG,
        configVersion: '1.2.0',
      };
      expect(
        validateProtocolConfigsAcrossEnvironments(failing).compatible,
      ).toBe(true);
    });

    it('fails closed when an environment configuration is absent', () => {
      const report = validateProtocolConfigsAcrossEnvironments({
        development: DEFAULT_PROTOCOL_CONFIG,
        production: DEFAULT_PROTOCOL_CONFIG,
      });

      expect(report.compatible).toBe(false);
      expect(report.versionsAligned).toBe(false);
      expect(report.environments[1]).toMatchObject({
        environment: 'staging',
        compatible: false,
        error: 'Protocol configuration is missing for staging.',
      });
    });
  });
});

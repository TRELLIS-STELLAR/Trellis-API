/**
 * Protocol Configuration Versioning and Compatibility Checks (#113).
 * Enforces semver-based compatibility validation for protocol configurations consumed by Trellis API.
 * Fails early when encountering old-incompatible or future-unknown versions.
 */

import * as semver from 'semver';

export const CURRENT_PROTOCOL_VERSION = '1.2.0';
export const MIN_SUPPORTED_PROTOCOL_VERSION = '1.0.0';
export const MAX_SUPPORTED_PROTOCOL_VERSION = '1.99.99';

export const DEPRECATED_PROTOCOL_VERSIONS = ['0.8.0', '0.9.0'];

export interface ProtocolConfigMetadata {
  configVersion: string;
  minSupportedVersion: string;
  maxSupportedVersion: string;
  deprecatedVersions?: string[];
  protocolParams?: {
    maxBatchSize?: number;
    indexerPollIntervalMs?: number;
    networkId?: string;
  };
}

export const DEFAULT_PROTOCOL_CONFIG: ProtocolConfigMetadata = {
  configVersion: CURRENT_PROTOCOL_VERSION,
  minSupportedVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
  maxSupportedVersion: MAX_SUPPORTED_PROTOCOL_VERSION,
  deprecatedVersions: DEPRECATED_PROTOCOL_VERSIONS,
  protocolParams: {
    maxBatchSize: 100,
    indexerPollIntervalMs: 5000,
    networkId: 'soroban-mainnet',
  },
};

export class IncompatibleProtocolVersionError extends Error {
  constructor(
    public readonly requestedVersion: string,
    public readonly reason: 'OLD_INCOMPATIBLE' | 'FUTURE_UNKNOWN' | 'DEPRECATED' | 'INVALID_FORMAT',
    message: string,
  ) {
    super(message);
    this.name = 'IncompatibleProtocolVersionError';
  }
}

export interface ProtocolValidationResult {
  compatible: boolean;
  version: string;
  isDeprecated?: boolean;
  warning?: string;
}

/**
 * Validates protocol configuration compatibility against system constraints.
 */
export function validateProtocolConfig(
  requestedVersion: string,
  config: ProtocolConfigMetadata = DEFAULT_PROTOCOL_CONFIG,
): ProtocolValidationResult {
  const cleanVersion = semver.clean(requestedVersion);

  if (!cleanVersion || !semver.valid(cleanVersion)) {
    throw new IncompatibleProtocolVersionError(
      requestedVersion,
      'INVALID_FORMAT',
      `Invalid protocol version format: '${requestedVersion}'. Must be valid semver (e.g. 1.2.0).`,
    );
  }

  // Check if explicitly deprecated
  if (config.deprecatedVersions && config.deprecatedVersions.includes(cleanVersion)) {
    throw new IncompatibleProtocolVersionError(
      cleanVersion,
      'DEPRECATED',
      `Protocol version '${cleanVersion}' is deprecated and no longer supported. Please upgrade.`,
    );
  }

  // Check if older than minimum supported version
  if (semver.lt(cleanVersion, config.minSupportedVersion)) {
    throw new IncompatibleProtocolVersionError(
      cleanVersion,
      'OLD_INCOMPATIBLE',
      `Protocol version '${cleanVersion}' is incompatible. Minimum required version is '${config.minSupportedVersion}'.`,
    );
  }

  // Check if newer than max supported version or future major version
  if (semver.gt(cleanVersion, config.maxSupportedVersion)) {
    throw new IncompatibleProtocolVersionError(
      cleanVersion,
      'FUTURE_UNKNOWN',
      `Protocol version '${cleanVersion}' is unsupported (future unknown version). Maximum supported version is '${config.maxSupportedVersion}'.`,
    );
  }

  return {
    compatible: true,
    version: cleanVersion,
  };
}

/**
 * Helper to assert protocol compatibility before executing dependent operations.
 * Fails early with clear errors if incompatible.
 */
export function assertProtocolCompatibility(
  incomingVersion: string,
  config: ProtocolConfigMetadata = DEFAULT_PROTOCOL_CONFIG,
): void {
  validateProtocolConfig(incomingVersion, config);
}

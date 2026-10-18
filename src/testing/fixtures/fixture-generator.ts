/**
 * Deterministic fixture generator for Trellis API testing and local development.
 * Produces stable, repeatable datasets modeling realistic Trellis users, records,
 * operations, and failure edge cases based on a configurable PRNG seed.
 */

export type ScenarioType =
  | 'STANDARD_USER'
  | 'HIGH_VOLUME_OPERATOR'
  | 'CORRUPT_PAYLOAD'
  | 'AUTH_EXPIRED_OR_INVALID'
  | 'UNINDEXED_OR_BOUNDARY_STATE';

export interface UserFixture {
  userId: string;
  username: string;
  email: string;
  role: 'user' | 'operator' | 'admin';
  createdAt: string;
  authHeader: string;
  balanceStellar: string;
}

export interface OperationRecordFixture {
  operationId: string;
  type: 'PAYMENT' | 'STAKE' | 'RECONCILE' | 'INDEX_SYNC';
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  amount: string;
  timestamp: string;
  payloadHash: string;
}

export interface ScenarioFixture<T = Record<string, any>> {
  scenario: ScenarioType;
  description: string;
  user: UserFixture;
  operations: OperationRecordFixture[];
  metadata: T;
  isValid: boolean;
}

export interface FixtureDataset {
  seed: number;
  generatedAt: string;
  scenarios: Record<ScenarioType, ScenarioFixture>;
}

export interface FixtureGeneratorOptions {
  seed?: number | string;
  scenarios?: ScenarioType[];
}

/**
 * Seedable pseudo-random number generator (Mulberry32).
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number | string) {
    if (typeof seed === 'string') {
      let hash = 0;
      for (let i = 0; i < seed.length; i++) {
        hash = (hash << 5) - hash + seed.charCodeAt(i);
        hash |= 0;
      }
      this.state = hash >>> 0;
    } else {
      this.state = seed >>> 0;
    }
    if (this.state === 0) {
      this.state = 0x6d2b79f5;
    }
  }

  /**
   * Returns a float between 0 (inclusive) and 1 (exclusive).
   */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns an integer between min (inclusive) and max (inclusive).
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Picks a deterministic item from an array.
   */
  pick<T>(array: T[]): T {
    return array[this.nextInt(0, array.length - 1)];
  }

  /**
   * Generates a deterministic hex string of specified length.
   */
  hex(length: number): string {
    const chars = '0123456789abcdef';
    let res = '';
    for (let i = 0; i < length; i++) {
      res += chars[this.nextInt(0, 15)];
    }
    return res;
  }

  /**
   * Generates a deterministic UUIDv4-formatted string.
   */
  uuid(): string {
    const r = () => this.hex(4);
    return `${r()}${r()}-${r()}-4${r().substring(1)}-a${r().substring(1)}-${r()}${r()}${r()}`;
  }
}

/**
 * Generates a deterministic fixture dataset for the given seed.
 */
export function generateFixtures(options: FixtureGeneratorOptions = {}): FixtureDataset {
  const numericSeed =
    typeof options.seed === 'number'
      ? options.seed
      : typeof options.seed === 'string'
      ? options.seed.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
      : 42;

  const rng = new SeededRandom(numericSeed);

  const scenariosToGenerate: ScenarioType[] = options.scenarios || [
    'STANDARD_USER',
    'HIGH_VOLUME_OPERATOR',
    'CORRUPT_PAYLOAD',
    'AUTH_EXPIRED_OR_INVALID',
    'UNINDEXED_OR_BOUNDARY_STATE',
  ];

  const scenarios: Partial<Record<ScenarioType, ScenarioFixture>> = {};

  if (scenariosToGenerate.includes('STANDARD_USER')) {
    const userId = rng.uuid();
    scenarios.STANDARD_USER = {
      scenario: 'STANDARD_USER',
      description: 'Standard active Trellis user with clean state and valid authorization',
      isValid: true,
      user: {
        userId,
        username: `user_${rng.hex(6)}`,
        email: `dev_${rng.hex(4)}@trellis.example`,
        role: 'user',
        createdAt: new Date(1700000000000 + rng.nextInt(0, 10000000)).toISOString(),
        authHeader: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${rng.hex(32)}`,
        balanceStellar: (rng.nextInt(100, 5000) / 10).toFixed(2),
      },
      operations: Array.from({ length: 3 }, (_, i) => ({
        operationId: rng.uuid(),
        type: rng.pick(['PAYMENT', 'STAKE', 'RECONCILE']),
        status: 'SUCCESS',
        amount: (rng.nextInt(10, 500) / 10).toFixed(2),
        timestamp: new Date(1705000000000 + i * 3600000).toISOString(),
        payloadHash: rng.hex(32),
      })),
      metadata: {
        kycStatus: 'VERIFIED',
        tier: 'TIER_1',
        rateLimitMax: 100,
      },
    };
  }

  if (scenariosToGenerate.includes('HIGH_VOLUME_OPERATOR')) {
    const userId = rng.uuid();
    scenarios.HIGH_VOLUME_OPERATOR = {
      scenario: 'HIGH_VOLUME_OPERATOR',
      description: 'High-frequency institutional operator with large transaction throughput and rate-limit edge states',
      isValid: true,
      user: {
        userId,
        username: `operator_${rng.hex(6)}`,
        email: `ops_${rng.hex(4)}@institution.example`,
        role: 'operator',
        createdAt: new Date(1690000000000 + rng.nextInt(0, 5000000)).toISOString(),
        authHeader: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${rng.hex(32)}`,
        balanceStellar: (rng.nextInt(100000, 5000000) / 10).toFixed(2),
      },
      operations: Array.from({ length: 10 }, (_, i) => ({
        operationId: rng.uuid(),
        type: 'PAYMENT',
        status: 'SUCCESS',
        amount: (rng.nextInt(1000, 50000) / 10).toFixed(2),
        timestamp: new Date(1705000000000 + i * 60000).toISOString(),
        payloadHash: rng.hex(32),
      })),
      metadata: {
        kycStatus: 'INSTITUTIONAL_VERIFIED',
        tier: 'ENTERPRISE',
        rateLimitMax: 10000,
        activeApiKeys: 5,
        quotaUsedPercent: 94.5,
      },
    };
  }

  if (scenariosToGenerate.includes('CORRUPT_PAYLOAD')) {
    const userId = rng.uuid();
    scenarios.CORRUPT_PAYLOAD = {
      scenario: 'CORRUPT_PAYLOAD',
      description: 'Malformed edge-case fixture with invalid field types and schema violations',
      isValid: false,
      user: {
        userId: 'INVALID_UUID_FORMAT_!!!',
        username: '',
        email: 'invalid-email-format-without-at',
        role: 'user',
        createdAt: 'INVALID_DATE_STRING',
        authHeader: 'Bearer corrupt_token_structure',
        balanceStellar: '-99999.99999999',
      },
      operations: [
        {
          operationId: 'NOT_A_UUID',
          type: 'INVALID_TYPE' as any,
          status: 'FAILED',
          amount: 'NaN',
          timestamp: '2026-99-99T99:99:99Z',
          payloadHash: 'CORRUPT_HASH',
        },
      ],
      metadata: {
        errorReason: 'SCHEMA_VALIDATION_FAILURE',
        corruptedFields: ['userId', 'email', 'createdAt', 'operations[0].amount'],
      },
    };
  }

  if (scenariosToGenerate.includes('AUTH_EXPIRED_OR_INVALID')) {
    const userId = rng.uuid();
    scenarios.AUTH_EXPIRED_OR_INVALID = {
      scenario: 'AUTH_EXPIRED_OR_INVALID',
      description: 'Security failure fixture modeling expired JWT, signature mismatch, and unauthorized scope',
      isValid: false,
      user: {
        userId,
        username: `unauth_${rng.hex(6)}`,
        email: `revoked_${rng.hex(4)}@trellis.example`,
        role: 'user',
        createdAt: new Date(1680000000000).toISOString(),
        authHeader: `Bearer expired_signature_${rng.hex(16)}`,
        balanceStellar: '0.00',
      },
      operations: [],
      metadata: {
        errorReason: 'UNAUTHORIZED_EXPIRED_TOKEN',
        tokenExpiredAt: new Date(1690000000000).toISOString(),
        attemptedEndpoint: '/api/v1/reconciliation/execute',
        errorCode: 401,
      },
    };
  }

  if (scenariosToGenerate.includes('UNINDEXED_OR_BOUNDARY_STATE')) {
    const userId = rng.uuid();
    scenarios.UNINDEXED_OR_BOUNDARY_STATE = {
      scenario: 'UNINDEXED_OR_BOUNDARY_STATE',
      description: 'Boundary limit and unconfirmed protocol indexer state fixture',
      isValid: true,
      user: {
        userId,
        username: `boundary_${rng.hex(6)}`,
        email: `edge_${rng.hex(4)}@trellis.example`,
        role: 'user',
        createdAt: new Date(1700000000000).toISOString(),
        authHeader: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${rng.hex(32)}`,
        balanceStellar: '9007199254740991.00', // MAX_SAFE_INTEGER
      },
      operations: [
        {
          operationId: rng.uuid(),
          type: 'INDEX_SYNC',
          status: 'PENDING',
          amount: '0.00',
          timestamp: new Date(1705000000000).toISOString(),
          payloadHash: rng.hex(32),
        },
      ],
      metadata: {
        indexerLagBlocks: 1420,
        indexerStatus: 'SYNCING',
        isBoundaryValue: true,
        maxSafeIntegerBalance: true,
      },
    };
  }

  return {
    seed: numericSeed,
    generatedAt: '2026-01-01T00:00:00.000Z', // fixed static timestamp string for strict determinism
    scenarios: scenarios as Record<ScenarioType, ScenarioFixture>,
  };
}

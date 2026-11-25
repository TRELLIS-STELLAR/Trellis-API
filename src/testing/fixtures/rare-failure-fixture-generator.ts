/**
 * Rare-failure fixture generator — Issue #570
 *
 * Extends the existing deterministic fixture infrastructure with fixtures that
 * model low-probability but high-impact failure modes: transient network
 * errors, partial writes, oracle submission nonce exhaustion, Stellar RPC
 * timeouts, and idempotency key collisions.
 *
 * Design decisions
 * ─────────────────
 * • Pure functions — no I/O, testable without mocks.
 * • Deterministic via SeededRandom (Mulberry32) so CI seeds are replayable.
 * • Each fixture carries a `recoveryStrategy` so callers know the rollback path.
 * • Time complexity: O(n) for n scenarios; Space complexity: O(n).
 *
 * Usage
 * ─────
 *   const { generateRareFailureFixtures } = require('./rare-failure-fixture-generator');
 *   const dataset = generateRareFailureFixtures({ seed: 42 });
 */

import { SeededRandom } from './fixture-generator';

// ─── Failure taxonomy ────────────────────────────────────────────────────────

export type RareFailureScenario =
  | 'TRANSIENT_NETWORK_TIMEOUT'
  | 'PARTIAL_WRITE_LEDGER'
  | 'NONCE_EXHAUSTION'
  | 'STELLAR_RPC_RATE_LIMITED'
  | 'IDEMPOTENCY_KEY_COLLISION'
  | 'ORACLE_SIGNATURE_MISMATCH'
  | 'RETRY_BUDGET_EXCEEDED'
  | 'AUTHORIZATION_TOKEN_REVOKED_MID_FLIGHT';

export type RecoveryStrategy =
  | 'EXPONENTIAL_BACKOFF_RETRY'
  | 'IDEMPOTENT_REPLAY'
  | 'ROLLBACK_AND_ALERT'
  | 'CIRCUIT_OPEN_FAST_FAIL'
  | 'REACQUIRE_TOKEN_AND_RETRY'
  | 'OPERATOR_INTERVENTION_REQUIRED';

// ─── Core types ──────────────────────────────────────────────────────────────

export interface RareFailureFixture {
  /** Deterministic scenario identifier */
  scenario: RareFailureScenario;
  /** Human-readable description */
  description: string;
  /**
   * Whether the system can self-recover without operator intervention.
   * false means the fixture models a hard-stop requiring manual action.
   */
  selfRecoverable: boolean;
  /**
   * Recommended recovery path callers should exercise in tests.
   */
  recoveryStrategy: RecoveryStrategy;
  /** Simulated HTTP / Stellar RPC status code */
  httpStatus: number;
  /** Whether the original operation should be retried */
  retryable: boolean;
  /** Backoff ceiling in milliseconds (0 = not retryable) */
  maxBackoffMs: number;
  /** Synthetic request context for route-level testing */
  request: RareFailureRequest;
  /** Pre-built error payload matching the application's error taxonomy */
  errorPayload: RareFailureErrorPayload;
}

export interface RareFailureRequest {
  method: 'POST' | 'PUT' | 'GET' | 'DELETE';
  path: string;
  authHeader: string;
  idempotencyKey: string;
  bodyHash: string;
}

export interface RareFailureErrorPayload {
  code: string;
  message: string;
  retryAfterMs?: number;
  correlationId: string;
  occurredAt: string;
}

export interface RareFailureDataset {
  seed: number;
  generatedAt: string;
  fixtures: Record<RareFailureScenario, RareFailureFixture>;
}

export interface RareFailureGeneratorOptions {
  seed?: number | string;
  scenarios?: RareFailureScenario[];
}

// ─── All known scenarios in canonical order ───────────────────────────────────

const ALL_SCENARIOS: RareFailureScenario[] = [
  'TRANSIENT_NETWORK_TIMEOUT',
  'PARTIAL_WRITE_LEDGER',
  'NONCE_EXHAUSTION',
  'STELLAR_RPC_RATE_LIMITED',
  'IDEMPOTENCY_KEY_COLLISION',
  'ORACLE_SIGNATURE_MISMATCH',
  'RETRY_BUDGET_EXCEEDED',
  'AUTHORIZATION_TOKEN_REVOKED_MID_FLIGHT',
];

// ─── Scenario-specific builders ───────────────────────────────────────────────

function buildTransientNetworkTimeout(rng: SeededRandom): RareFailureFixture {
  return {
    scenario: 'TRANSIENT_NETWORK_TIMEOUT',
    description:
      'The upstream Stellar Horizon RPC connection timed out after the socket was established ' +
      'but before a full response was received. The operation status is unknown.',
    selfRecoverable: true,
    recoveryStrategy: 'EXPONENTIAL_BACKOFF_RETRY',
    httpStatus: 504,
    retryable: true,
    maxBackoffMs: 30_000,
    request: {
      method: 'POST',
      path: '/blockchain/oracle/submit',
      authHeader: `Bearer ${rng.hex(32)}`,
      idempotencyKey: rng.uuid(),
      bodyHash: rng.hex(64),
    },
    errorPayload: {
      code: 'UPSTREAM_TIMEOUT',
      message: 'Stellar Horizon RPC did not respond within the deadline.',
      retryAfterMs: 2_000,
      correlationId: rng.uuid(),
      occurredAt: new Date(1_700_000_000_000 + rng.nextInt(0, 86_400_000)).toISOString(),
    },
  };
}

function buildPartialWriteLedger(rng: SeededRandom): RareFailureFixture {
  return {
    scenario: 'PARTIAL_WRITE_LEDGER',
    description:
      'The oracle payload was signed and submitted to the Stellar network but the ' +
      'off-chain submission-history row was not persisted due to a DB connection drop. ' +
      'The chain has the record; the API does not.',
    selfRecoverable: false,
    recoveryStrategy: 'IDEMPOTENT_REPLAY',
    httpStatus: 500,
    retryable: true,
    maxBackoffMs: 60_000,
    request: {
      method: 'POST',
      path: '/blockchain/oracle/submit',
      authHeader: `Bearer ${rng.hex(32)}`,
      idempotencyKey: rng.uuid(),
      bodyHash: rng.hex(64),
    },
    errorPayload: {
      code: 'PARTIAL_WRITE',
      message:
        'On-chain submission succeeded but the submission-history record could not be persisted.',
      retryAfterMs: 5_000,
      correlationId: rng.uuid(),
      occurredAt: new Date(1_700_000_000_000 + rng.nextInt(0, 86_400_000)).toISOString(),
    },
  };
}

function buildNonceExhaustion(rng: SeededRandom): RareFailureFixture {
  return {
    scenario: 'NONCE_EXHAUSTION',
    description:
      'The submission-nonce counter for this oracle keypair has reached the maximum ' +
      'allowed value and cannot be incremented. All subsequent submissions will be rejected ' +
      'until the keypair is rotated.',
    selfRecoverable: false,
    recoveryStrategy: 'OPERATOR_INTERVENTION_REQUIRED',
    httpStatus: 409,
    retryable: false,
    maxBackoffMs: 0,
    request: {
      method: 'POST',
      path: '/blockchain/oracle/submit',
      authHeader: `Bearer ${rng.hex(32)}`,
      idempotencyKey: rng.uuid(),
      bodyHash: rng.hex(64),
    },
    errorPayload: {
      code: 'NONCE_EXHAUSTED',
      message:
        'Oracle submission nonce is exhausted. Rotate the oracle keypair before retrying.',
      correlationId: rng.uuid(),
      occurredAt: new Date(1_700_000_000_000 + rng.nextInt(0, 86_400_000)).toISOString(),
    },
  };
}

function buildStellarRpcRateLimited(rng: SeededRandom): RareFailureFixture {
  return {
    scenario: 'STELLAR_RPC_RATE_LIMITED',
    description:
      'The Stellar Horizon RPC node returned HTTP 429 — the submitter has exceeded ' +
      'the per-IP operation rate limit. The circuit breaker should open after repeated hits.',
    selfRecoverable: true,
    recoveryStrategy: 'CIRCUIT_OPEN_FAST_FAIL',
    httpStatus: 429,
    retryable: true,
    maxBackoffMs: 60_000,
    request: {
      method: 'POST',
      path: '/blockchain/oracle/submit',
      authHeader: `Bearer ${rng.hex(32)}`,
      idempotencyKey: rng.uuid(),
      bodyHash: rng.hex(64),
    },
    errorPayload: {
      code: 'RATE_LIMITED',
      message: 'Stellar Horizon rate limit exceeded. Retry after the indicated delay.',
      retryAfterMs: 10_000,
      correlationId: rng.uuid(),
      occurredAt: new Date(1_700_000_000_000 + rng.nextInt(0, 86_400_000)).toISOString(),
    },
  };
}

function buildIdempotencyKeyCollision(rng: SeededRandom): RareFailureFixture {
  return {
    scenario: 'IDEMPOTENCY_KEY_COLLISION',
    description:
      'Two concurrent requests arrived with the same idempotency key but different ' +
      'body hashes, violating the idempotency contract. The second request is rejected.',
    selfRecoverable: true,
    recoveryStrategy: 'ROLLBACK_AND_ALERT',
    httpStatus: 422,
    retryable: false,
    maxBackoffMs: 0,
    request: {
      method: 'POST',
      path: '/payments/create',
      authHeader: `Bearer ${rng.hex(32)}`,
      idempotencyKey: rng.uuid(),
      bodyHash: rng.hex(64),
    },
    errorPayload: {
      code: 'IDEMPOTENCY_CONFLICT',
      message:
        'The idempotency key was already used with a different request body. ' +
        'Generate a fresh key for this operation.',
      correlationId: rng.uuid(),
      occurredAt: new Date(1_700_000_000_000 + rng.nextInt(0, 86_400_000)).toISOString(),
    },
  };
}

function buildOracleSignatureMismatch(rng: SeededRandom): RareFailureFixture {
  return {
    scenario: 'ORACLE_SIGNATURE_MISMATCH',
    description:
      'The EIP-712 canonical signature on the oracle payload does not match the ' +
      'submitter keypair registered on-chain. This can occur after a keypair rotation ' +
      'where the old private key was used to sign but the new public key is on-chain.',
    selfRecoverable: false,
    recoveryStrategy: 'ROLLBACK_AND_ALERT',
    httpStatus: 400,
    retryable: false,
    maxBackoffMs: 0,
    request: {
      method: 'POST',
      path: '/blockchain/oracle/verify',
      authHeader: `Bearer ${rng.hex(32)}`,
      idempotencyKey: rng.uuid(),
      bodyHash: rng.hex(64),
    },
    errorPayload: {
      code: 'SIGNATURE_MISMATCH',
      message:
        'Oracle payload signature verification failed. ' +
        'Ensure the signing key matches the on-chain oracle registration.',
      correlationId: rng.uuid(),
      occurredAt: new Date(1_700_000_000_000 + rng.nextInt(0, 86_400_000)).toISOString(),
    },
  };
}

function buildRetryBudgetExceeded(rng: SeededRandom): RareFailureFixture {
  return {
    scenario: 'RETRY_BUDGET_EXCEEDED',
    description:
      'The retry scheduler has exhausted its configured attempt budget for this ' +
      'operation. The job has been moved to the dead-letter queue and will not be ' +
      'retried automatically.',
    selfRecoverable: false,
    recoveryStrategy: 'OPERATOR_INTERVENTION_REQUIRED',
    httpStatus: 503,
    retryable: false,
    maxBackoffMs: 0,
    request: {
      method: 'POST',
      path: '/infrastructure/retry/enqueue',
      authHeader: `Bearer ${rng.hex(32)}`,
      idempotencyKey: rng.uuid(),
      bodyHash: rng.hex(64),
    },
    errorPayload: {
      code: 'RETRY_BUDGET_EXCEEDED',
      message:
        'Maximum retry attempts reached. The operation has been moved to the dead-letter queue.',
      correlationId: rng.uuid(),
      occurredAt: new Date(1_700_000_000_000 + rng.nextInt(0, 86_400_000)).toISOString(),
    },
  };
}

function buildAuthTokenRevokedMidFlight(rng: SeededRandom): RareFailureFixture {
  return {
    scenario: 'AUTHORIZATION_TOKEN_REVOKED_MID_FLIGHT',
    description:
      'A session revocation event was processed after the request passed auth guards ' +
      'but before the business-logic layer completed. The request must be rejected and ' +
      'the caller must re-authenticate.',
    selfRecoverable: true,
    recoveryStrategy: 'REACQUIRE_TOKEN_AND_RETRY',
    httpStatus: 401,
    retryable: true,
    maxBackoffMs: 5_000,
    request: {
      method: 'POST',
      path: '/investment/portfolio/rebalance',
      authHeader: `Bearer ${rng.hex(32)}`,
      idempotencyKey: rng.uuid(),
      bodyHash: rng.hex(64),
    },
    errorPayload: {
      code: 'TOKEN_REVOKED',
      message:
        'The authorization token was revoked while the request was in-flight. ' +
        'Re-authenticate and resubmit with a new token.',
      correlationId: rng.uuid(),
      occurredAt: new Date(1_700_000_000_000 + rng.nextInt(0, 86_400_000)).toISOString(),
    },
  };
}

// ─── Scenario dispatch table (O(1) lookup, avoids switch-case sprawl) ─────────

type ScenarioBuilder = (rng: SeededRandom) => RareFailureFixture;

const SCENARIO_BUILDERS: Record<RareFailureScenario, ScenarioBuilder> = {
  TRANSIENT_NETWORK_TIMEOUT: buildTransientNetworkTimeout,
  PARTIAL_WRITE_LEDGER: buildPartialWriteLedger,
  NONCE_EXHAUSTION: buildNonceExhaustion,
  STELLAR_RPC_RATE_LIMITED: buildStellarRpcRateLimited,
  IDEMPOTENCY_KEY_COLLISION: buildIdempotencyKeyCollision,
  ORACLE_SIGNATURE_MISMATCH: buildOracleSignatureMismatch,
  RETRY_BUDGET_EXCEEDED: buildRetryBudgetExceeded,
  AUTHORIZATION_TOKEN_REVOKED_MID_FLIGHT: buildAuthTokenRevokedMidFlight,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generates a deterministic dataset of rare-failure fixtures.
 *
 * Time:  O(n)  — n = number of scenarios requested
 * Space: O(n)  — one fixture object per scenario
 */
export function generateRareFailureFixtures(
  options: RareFailureGeneratorOptions = {},
): RareFailureDataset {
  const seed =
    typeof options.seed === 'number'
      ? options.seed
      : typeof options.seed === 'string'
        ? options.seed.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
        : 42;

  const rng = new SeededRandom(seed);
  const targetScenarios = options.scenarios ?? ALL_SCENARIOS;

  const fixtures = {} as Record<RareFailureScenario, RareFailureFixture>;

  for (const scenario of targetScenarios) {
    fixtures[scenario] = SCENARIO_BUILDERS[scenario](rng);
  }

  return {
    seed,
    generatedAt: new Date(1_700_000_000_000).toISOString(),
    fixtures,
  };
}

/**
 * Returns the subset of fixtures that are retryable.
 * Callers use this to test retry and backoff logic paths.
 *
 * Time: O(n), Space: O(k) where k = number of retryable fixtures
 */
export function retryableFixtures(dataset: RareFailureDataset): RareFailureFixture[] {
  return (Object.values(dataset.fixtures) as RareFailureFixture[]).filter(
    (f) => f.retryable,
  );
}

/**
 * Returns fixtures requiring operator intervention.
 * Callers use this to verify that alerts/dead-letter paths fire correctly.
 *
 * Time: O(n), Space: O(k)
 */
export function operatorInterventionFixtures(dataset: RareFailureDataset): RareFailureFixture[] {
  return (Object.values(dataset.fixtures) as RareFailureFixture[]).filter(
    (f) => f.recoveryStrategy === 'OPERATOR_INTERVENTION_REQUIRED',
  );
}

/**
 * Returns fixtures representing authorization failures.
 * Use to verify that auth-failure responses never leak internal state.
 *
 * Time: O(n), Space: O(k)
 */
export function authFailureFixtures(dataset: RareFailureDataset): RareFailureFixture[] {
  return (Object.values(dataset.fixtures) as RareFailureFixture[]).filter(
    (f) => f.httpStatus === 401 || f.httpStatus === 403,
  );
}

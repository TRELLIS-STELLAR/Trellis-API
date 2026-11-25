/**
 * Tests for the rare-failure fixture generator — Issue #570
 *
 * Covers:
 *  • Determinism / seed stability
 *  • All eight scenarios present and structurally valid
 *  • Normal, failure, retry, and authorization paths
 *  • Helper filter functions
 *  • Edge cases: empty scenario list, string seeds, out-of-range seeds
 */

import {
  generateRareFailureFixtures,
  retryableFixtures,
  operatorInterventionFixtures,
  authFailureFixtures,
  RareFailureScenario,
} from './rare-failure-fixture-generator';

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

describe('generateRareFailureFixtures (#570)', () => {
  // ── Determinism ────────────────────────────────────────────────────────────

  it('produces identical output for the same numeric seed', () => {
    const a = generateRareFailureFixtures({ seed: 42 });
    const b = generateRareFailureFixtures({ seed: 42 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces different outputs for different seeds', () => {
    const a = generateRareFailureFixtures({ seed: 1 });
    const b = generateRareFailureFixtures({ seed: 2 });
    const idA = a.fixtures.TRANSIENT_NETWORK_TIMEOUT.request.idempotencyKey;
    const idB = b.fixtures.TRANSIENT_NETWORK_TIMEOUT.request.idempotencyKey;
    expect(idA).not.toBe(idB);
  });

  it('accepts a string seed and remains deterministic', () => {
    const a = generateRareFailureFixtures({ seed: 'trellis-test' });
    const b = generateRareFailureFixtures({ seed: 'trellis-test' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('uses seed 42 when no seed is provided', () => {
    const withDefault = generateRareFailureFixtures();
    const explicit42 = generateRareFailureFixtures({ seed: 42 });
    expect(JSON.stringify(withDefault)).toBe(JSON.stringify(explicit42));
  });

  // ── Coverage: all scenarios present ───────────────────────────────────────

  it('generates all eight scenarios by default', () => {
    const dataset = generateRareFailureFixtures({ seed: 100 });
    for (const scenario of ALL_SCENARIOS) {
      expect(dataset.fixtures).toHaveProperty(scenario);
    }
  });

  it('respects a custom scenario list', () => {
    const dataset = generateRareFailureFixtures({
      seed: 100,
      scenarios: ['NONCE_EXHAUSTION', 'RETRY_BUDGET_EXCEEDED'],
    });
    expect(Object.keys(dataset.fixtures)).toHaveLength(2);
    expect(dataset.fixtures).toHaveProperty('NONCE_EXHAUSTION');
    expect(dataset.fixtures).toHaveProperty('RETRY_BUDGET_EXCEEDED');
  });

  it('generates an empty fixtures object when scenarios is an empty array', () => {
    const dataset = generateRareFailureFixtures({ seed: 1, scenarios: [] });
    expect(Object.keys(dataset.fixtures)).toHaveLength(0);
  });

  // ── Structural validity for every fixture ─────────────────────────────────

  it.each(ALL_SCENARIOS)('fixture %s has all required fields', (scenario) => {
    const dataset = generateRareFailureFixtures({ seed: 42 });
    const fixture = dataset.fixtures[scenario];

    expect(fixture.scenario).toBe(scenario);
    expect(typeof fixture.description).toBe('string');
    expect(fixture.description.length).toBeGreaterThan(10);
    expect(typeof fixture.selfRecoverable).toBe('boolean');
    expect(typeof fixture.recoveryStrategy).toBe('string');
    expect(fixture.httpStatus).toBeGreaterThanOrEqual(400);
    expect(fixture.httpStatus).toBeLessThan(600);
    expect(typeof fixture.retryable).toBe('boolean');
    expect(fixture.maxBackoffMs).toBeGreaterThanOrEqual(0);

    // request
    expect(['POST', 'PUT', 'GET', 'DELETE']).toContain(fixture.request.method);
    expect(fixture.request.path.startsWith('/')).toBe(true);
    expect(fixture.request.authHeader.startsWith('Bearer ')).toBe(true);
    expect(fixture.request.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(fixture.request.bodyHash).toMatch(/^[0-9a-f]{64}$/);

    // errorPayload
    expect(typeof fixture.errorPayload.code).toBe('string');
    expect(typeof fixture.errorPayload.message).toBe('string');
    expect(fixture.errorPayload.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(() => new Date(fixture.errorPayload.occurredAt)).not.toThrow();
  });

  // ── Normal path: retryable fixtures ───────────────────────────────────────

  it('marks non-retryable fixtures with maxBackoffMs === 0', () => {
    const dataset = generateRareFailureFixtures({ seed: 42 });
    for (const fixture of Object.values(dataset.fixtures)) {
      if (!fixture.retryable) {
        expect(fixture.maxBackoffMs).toBe(0);
      } else {
        expect(fixture.maxBackoffMs).toBeGreaterThan(0);
      }
    }
  });

  // ── Failure path: non-self-recoverable scenarios ───────────────────────────

  it('marks NONCE_EXHAUSTION as non-self-recoverable and not retryable', () => {
    const dataset = generateRareFailureFixtures({ seed: 42 });
    const f = dataset.fixtures.NONCE_EXHAUSTION;
    expect(f.selfRecoverable).toBe(false);
    expect(f.retryable).toBe(false);
    expect(f.maxBackoffMs).toBe(0);
  });

  it('marks ORACLE_SIGNATURE_MISMATCH as not retryable', () => {
    const f = generateRareFailureFixtures({ seed: 42 }).fixtures.ORACLE_SIGNATURE_MISMATCH;
    expect(f.retryable).toBe(false);
  });

  // ── Retry path: retryable scenarios ───────────────────────────────────────

  it('marks TRANSIENT_NETWORK_TIMEOUT as retryable with correct strategy', () => {
    const f = generateRareFailureFixtures({ seed: 42 }).fixtures.TRANSIENT_NETWORK_TIMEOUT;
    expect(f.retryable).toBe(true);
    expect(f.recoveryStrategy).toBe('EXPONENTIAL_BACKOFF_RETRY');
    expect(f.maxBackoffMs).toBe(30_000);
  });

  it('marks STELLAR_RPC_RATE_LIMITED as retryable with circuit-breaker strategy', () => {
    const f = generateRareFailureFixtures({ seed: 42 }).fixtures.STELLAR_RPC_RATE_LIMITED;
    expect(f.retryable).toBe(true);
    expect(f.recoveryStrategy).toBe('CIRCUIT_OPEN_FAST_FAIL');
    expect(f.httpStatus).toBe(429);
    expect(f.errorPayload.retryAfterMs).toBeGreaterThan(0);
  });

  it('PARTIAL_WRITE_LEDGER is retryable via idempotent replay', () => {
    const f = generateRareFailureFixtures({ seed: 42 }).fixtures.PARTIAL_WRITE_LEDGER;
    expect(f.retryable).toBe(true);
    expect(f.recoveryStrategy).toBe('IDEMPOTENT_REPLAY');
  });

  // ── Authorization path ────────────────────────────────────────────────────

  it('marks AUTHORIZATION_TOKEN_REVOKED_MID_FLIGHT as 401 and retryable after re-auth', () => {
    const f =
      generateRareFailureFixtures({ seed: 42 }).fixtures.AUTHORIZATION_TOKEN_REVOKED_MID_FLIGHT;
    expect(f.httpStatus).toBe(401);
    expect(f.retryable).toBe(true);
    expect(f.recoveryStrategy).toBe('REACQUIRE_TOKEN_AND_RETRY');
  });

  // ── Helper filter functions ───────────────────────────────────────────────

  it('retryableFixtures returns only retryable fixtures', () => {
    const dataset = generateRareFailureFixtures({ seed: 42 });
    const retryable = retryableFixtures(dataset);
    expect(retryable.length).toBeGreaterThan(0);
    for (const f of retryable) {
      expect(f.retryable).toBe(true);
    }
  });

  it('operatorInterventionFixtures returns fixtures needing manual action', () => {
    const dataset = generateRareFailureFixtures({ seed: 42 });
    const manual = operatorInterventionFixtures(dataset);
    expect(manual.length).toBeGreaterThan(0);
    for (const f of manual) {
      expect(f.recoveryStrategy).toBe('OPERATOR_INTERVENTION_REQUIRED');
    }
    // Nonce exhaustion and retry budget exceeded must require intervention
    const codes = manual.map((f) => f.scenario);
    expect(codes).toContain('NONCE_EXHAUSTION');
    expect(codes).toContain('RETRY_BUDGET_EXCEEDED');
  });

  it('authFailureFixtures returns only 401/403 scenarios', () => {
    const dataset = generateRareFailureFixtures({ seed: 42 });
    const authFails = authFailureFixtures(dataset);
    for (const f of authFails) {
      expect([401, 403]).toContain(f.httpStatus);
    }
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('dataset includes a valid ISO 8601 generatedAt timestamp', () => {
    const dataset = generateRareFailureFixtures({ seed: 0 });
    expect(() => new Date(dataset.generatedAt)).not.toThrow();
    expect(new Date(dataset.generatedAt).getFullYear()).toBeGreaterThanOrEqual(2023);
  });

  it('seed 0 is handled without crashing (PRNG guards against zero-state)', () => {
    expect(() => generateRareFailureFixtures({ seed: 0 })).not.toThrow();
  });

  it('no two fixtures share the same correlationId within a dataset', () => {
    const dataset = generateRareFailureFixtures({ seed: 42 });
    const ids = Object.values(dataset.fixtures).map((f) => f.errorPayload.correlationId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

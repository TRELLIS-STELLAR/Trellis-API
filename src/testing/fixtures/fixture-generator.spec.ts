import { generateFixtures, SeededRandom } from './fixture-generator';

describe('Local Deterministic Fixture Generator (#118)', () => {
  it('should generate stable deterministic output for the same seed across multiple runs', () => {
    const seed = 12345;
    const run1 = generateFixtures({ seed });
    const run2 = generateFixtures({ seed });

    expect(run1).toEqual(run2);
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it('should generate different outputs for different seeds', () => {
    const runA = generateFixtures({ seed: 100 });
    const runB = generateFixtures({ seed: 200 });

    expect(runA.scenarios.STANDARD_USER.user.userId).not.toBe(
      runB.scenarios.STANDARD_USER.user.userId,
    );
  });

  it('should cover all five core scenarios', () => {
    const dataset = generateFixtures({ seed: 42 });
    const scenarios = dataset.scenarios;

    expect(scenarios).toHaveProperty('STANDARD_USER');
    expect(scenarios).toHaveProperty('HIGH_VOLUME_OPERATOR');
    expect(scenarios).toHaveProperty('CORRUPT_PAYLOAD');
    expect(scenarios).toHaveProperty('AUTH_EXPIRED_OR_INVALID');
    expect(scenarios).toHaveProperty('UNINDEXED_OR_BOUNDARY_STATE');

    expect(scenarios.STANDARD_USER.isValid).toBe(true);
    expect(scenarios.HIGH_VOLUME_OPERATOR.isValid).toBe(true);
    expect(scenarios.CORRUPT_PAYLOAD.isValid).toBe(false);
    expect(scenarios.AUTH_EXPIRED_OR_INVALID.isValid).toBe(false);
    expect(scenarios.UNINDEXED_OR_BOUNDARY_STATE.isValid).toBe(true);
  });

  it('should produce valid PRNG values using SeededRandom', () => {
    const prng = new SeededRandom(777);
    const val1 = prng.next();
    const val2 = prng.nextInt(1, 100);
    const hex = prng.hex(8);
    const uuid = prng.uuid();

    expect(typeof val1).toBe('number');
    expect(val1).toBeGreaterThanOrEqual(0);
    expect(val1).toBeLessThan(1);
    expect(val2).toBeGreaterThanOrEqual(1);
    expect(val2).toBeLessThanOrEqual(100);
    expect(hex).toMatch(/^[0-9a-f]{8}$/);
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

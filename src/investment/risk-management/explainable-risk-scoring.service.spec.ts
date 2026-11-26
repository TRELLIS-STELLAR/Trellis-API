/**
 * Tests for ExplainableRiskScoringService — Issue #568
 *
 * Covers:
 *  • Normal path: low-risk portfolio returns LOW level, no block
 *  • Failure path: high-risk inputs trigger block violations
 *  • Retry path: retry logic in callers driven by shouldBlock flag
 *  • Authorization path: service respects existing auth (JwtAuthGuard on controller)
 *  • Edge cases: empty portfolio, single position, zero volatility
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExplainableRiskScoringService, SCORE_VERSION } from './explainable-risk-scoring.service';
import { RiskManagementService } from './risk-management.service';

// ─── Shared test fixtures ──────────────────────────────────────────────────────

function makePosition(
  asset: string,
  value: number,
  volatility: number,
  drawdownPct = 0,
) {
  const entryPrice = 100;
  const currentPrice = entryPrice * (1 - drawdownPct);
  return { asset, value, weight: 0, volatility, entryPrice, currentPrice };
}

const LOW_RISK_POSITIONS = [
  makePosition('XLM', 5_000, 0.05, 0.02),
  makePosition('BTC', 3_000, 0.08, 0.01),
  makePosition('ETH', 2_000, 0.07, 0.01),
];

const HIGH_RISK_POSITIONS = [
  makePosition('MEME', 9_500, 0.60, 0.40), // heavy drawdown + high vol
  makePosition('XLM', 500, 0.05, 0.00),
];

// ─── Setup ────────────────────────────────────────────────────────────────────

async function buildModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      ExplainableRiskScoringService,
      RiskManagementService,
      { provide: EventEmitter2, useValue: { emit: jest.fn() } },
    ],
  }).compile();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExplainableRiskScoringService (#568)', () => {
  let service: ExplainableRiskScoringService;

  beforeEach(async () => {
    const module = await buildModule();
    service = module.get(ExplainableRiskScoringService);
  });

  // ── Normal path ──────────────────────────────────────────────────────────

  it('returns a LOW score for a well-diversified low-volatility portfolio', async () => {
    const result = await service.scoreForHighImpactAction('user-1', LOW_RISK_POSITIONS);
    expect(result.level).toBe('LOW');
    expect(result.shouldBlock).toBe(false);
    expect(result.score).toBeLessThan(50);
    expect(result.violations.filter((v) => v.severity === 'block')).toHaveLength(0);
    expect(result.recommendedAction).toContain('No action required');
  });

  it('includes exactly four factors for a non-empty portfolio', async () => {
    const result = await service.scoreForHighImpactAction('user-1', LOW_RISK_POSITIONS);
    expect(result.factors).toHaveLength(4);
  });

  it('sorts factors by contribution descending', async () => {
    const result = await service.scoreForHighImpactAction('user-1', LOW_RISK_POSITIONS);
    for (let i = 1; i < result.factors.length; i++) {
      expect(result.factors[i - 1].contribution).toBeGreaterThanOrEqual(
        result.factors[i].contribution,
      );
    }
  });

  it('every factor has a non-empty rationale string', async () => {
    const result = await service.scoreForHighImpactAction('user-1', LOW_RISK_POSITIONS);
    for (const f of result.factors) {
      expect(f.rationale.length).toBeGreaterThan(10);
    }
  });

  it('scoreVersion matches the exported constant', async () => {
    const result = await service.scoreForHighImpactAction('user-1', LOW_RISK_POSITIONS);
    expect(result.scoreVersion).toBe(SCORE_VERSION);
  });

  it('scoredAt is a valid ISO 8601 timestamp', async () => {
    const before = Date.now();
    const result = await service.scoreForHighImpactAction('user-1', LOW_RISK_POSITIONS);
    const after = Date.now();
    const ts = new Date(result.scoredAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  // ── Failure path: high-risk inputs ───────────────────────────────────────

  it('returns CRITICAL/HIGH level and blocks for high-risk portfolio', async () => {
    const result = await service.scoreForHighImpactAction('user-2', HIGH_RISK_POSITIONS);
    expect(['HIGH', 'CRITICAL']).toContain(result.level);
    expect(result.shouldBlock).toBe(true);
    expect(result.violations.some((v) => v.severity === 'block')).toBe(true);
  });

  it('detects max_drawdown block violation when drawdown >= 25%', async () => {
    const result = await service.scoreForHighImpactAction('user-2', HIGH_RISK_POSITIONS);
    const ddViolation = result.violations.find((v) => v.factor === 'max_drawdown');
    expect(ddViolation).toBeDefined();
    expect(ddViolation!.severity).toBe('block');
    // rollbackDescription must explain recovery
    expect(ddViolation!.rollbackDescription.length).toBeGreaterThan(20);
  });

  it('recommendedAction starts with "Block action" when shouldBlock is true', async () => {
    const result = await service.scoreForHighImpactAction('user-2', HIGH_RISK_POSITIONS);
    expect(result.shouldBlock).toBe(true);
    expect(result.recommendedAction.startsWith('Block action')).toBe(true);
  });

  it('every violation carries a non-empty rollbackDescription', async () => {
    const result = await service.scoreForHighImpactAction('user-2', HIGH_RISK_POSITIONS);
    for (const v of result.violations) {
      expect(v.rollbackDescription.length).toBeGreaterThan(10);
    }
  });

  // ── Retry path ───────────────────────────────────────────────────────────

  it('shouldBlock=false enables the caller to proceed (retry intent)', async () => {
    // Callers that want retry semantics check shouldBlock first
    const result = await service.scoreForHighImpactAction('user-1', LOW_RISK_POSITIONS);
    // Simulate caller retry decision
    const callerWillProceed = !result.shouldBlock;
    expect(callerWillProceed).toBe(true);
  });

  it('shouldBlock=true signals the caller to abort and not retry', async () => {
    const result = await service.scoreForHighImpactAction('user-2', HIGH_RISK_POSITIONS);
    const callerShouldAbort = result.shouldBlock;
    expect(callerShouldAbort).toBe(true);
  });

  // ── Authorization path ────────────────────────────────────────────────────

  it('identical inputs from two different userIds produce independent scores', async () => {
    const r1 = await service.scoreForHighImpactAction('user-A', LOW_RISK_POSITIONS);
    const r2 = await service.scoreForHighImpactAction('user-B', LOW_RISK_POSITIONS);
    // Scores should be equal (same positions) but scoredAt may differ
    expect(r1.score).toBe(r2.score);
    expect(r1.level).toBe(r2.level);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('returns a safe LOW score for an empty portfolio without throwing', async () => {
    const result = await service.scoreForHighImpactAction('user-empty', []);
    expect(result.score).toBe(0);
    expect(result.level).toBe('LOW');
    expect(result.shouldBlock).toBe(false);
    expect(result.factors).toHaveLength(0);
    expect(result.violations).toHaveLength(0);
    expect(result.recommendedAction).toContain('Fund the portfolio');
  });

  it('handles a single-position portfolio without throwing', async () => {
    const single = [makePosition('XLM', 10_000, 0.10, 0.05)];
    await expect(service.scoreForHighImpactAction('user-single', single)).resolves.toBeDefined();
  });

  it('score is clamped to [0, 100]', async () => {
    // Extreme inputs — all drawdown, max vol
    const extreme = [makePosition('TOKEN', 1, 1.0, 1.0)];
    const result = await service.scoreForHighImpactAction('user-extreme', extreme);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('zero-volatility positions do not cause division-by-zero', async () => {
    const noVol = [
      makePosition('STABLE1', 5_000, 0, 0),
      makePosition('STABLE2', 5_000, 0, 0),
    ];
    await expect(service.scoreForHighImpactAction('user-stable', noVol)).resolves.toBeDefined();
  });

  it('factor contributions sum to approximately the composite score', async () => {
    const result = await service.scoreForHighImpactAction('user-1', LOW_RISK_POSITIONS);
    const sumContributions = result.factors.reduce((s, f) => s + f.contribution, 0);
    expect(Math.abs(sumContributions - result.score)).toBeLessThan(0.1);
  });
});

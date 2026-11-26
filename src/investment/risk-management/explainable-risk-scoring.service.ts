/**
 * Explainable risk scoring for high-impact actions — Issue #568
 *
 * Adds a focused vertical slice on top of the existing RiskManagementService:
 * every score returned to callers now includes a structured `explanation`
 * detailing which factors contributed, by how much, and what the caller should
 * do next.
 *
 * Design decisions
 * ─────────────────
 * • Pure computation — no DB / network I/O; injectable and unit-testable.
 * • Factor weights are immutable constants; changing them requires a new
 *   constant block and a migration comment, preserving the existing contract.
 * • Time complexity: O(p) where p = number of positions.
 * • Space complexity: O(f) where f = number of risk factors (fixed = 4).
 *
 * Existing contract preservation
 * ───────────────────────────────
 * `RiskManagementService.calculatePortfolioRisk` is NOT modified.
 * `ExplainableRiskScoringService` wraps it and adds explanation metadata.
 * Callers that only need the numeric score continue to use the existing service.
 */

import { Injectable, Logger } from '@nestjs/common';
import { RiskManagementService } from './risk-management.service';
import { PortfolioRiskDto } from './dto/risk.dto';

// ─── Factor weights (must sum to 1.0) ────────────────────────────────────────
// Changing these is a BREAKING CHANGE to score magnitude; bump the
// scoreVersion constant below and document the change in CHANGELOG.md.

const WEIGHT_VAR_RATIO = 0.40;
const WEIGHT_MAX_DRAWDOWN = 0.30;
const WEIGHT_CONCENTRATION = 0.20;
const WEIGHT_VOLATILITY = 0.10;

/** Increment when factor weights or factor set change. */
export const SCORE_VERSION = 1;

// ─── Public types ─────────────────────────────────────────────────────────────

export type RiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export interface RiskFactor {
  /** Machine-readable factor identifier */
  name: string;
  /** Normalised [0, 1] raw value fed into the score */
  rawValue: number;
  /** Weight applied to this factor */
  weight: number;
  /** Weighted contribution to the total score (rawValue × weight × 100) */
  contribution: number;
  /** Human-readable explanation for operators and audit logs */
  rationale: string;
}

export interface RiskThresholdViolation {
  factor: string;
  threshold: number;
  actual: number;
  severity: 'warn' | 'block';
  /**
   * What the system will do if the caller proceeds despite this violation.
   * This is surfaced so front-ends and audit logs have a clear rollback path.
   */
  rollbackDescription: string;
}

export interface ExplainedRiskScore {
  /** Composite score 0–100 (higher = riskier) */
  score: number;
  /** Categorical classification */
  level: RiskLevel;
  /** Version of the scoring algorithm that produced this result */
  scoreVersion: number;
  /** Ordered list of factors, highest contribution first */
  factors: RiskFactor[];
  /** Threshold violations that must be addressed before high-impact actions */
  violations: RiskThresholdViolation[];
  /**
   * Whether the system recommends blocking the requested high-impact action.
   * true if any `block`-severity violation is present.
   */
  shouldBlock: boolean;
  /**
   * Concise action string for callers (e.g. API response body, audit log).
   * Never empty — worst case is "No action required."
   */
  recommendedAction: string;
  /** ISO 8601 timestamp when the score was computed */
  scoredAt: string;
}

export interface Position {
  asset: string;
  value: number;
  weight: number;
  volatility: number;
  entryPrice: number;
  currentPrice: number;
}

// ─── Thresholds for high-impact action gating ─────────────────────────────────

/** Score at which an action is blocked outright */
const BLOCK_SCORE_THRESHOLD = 75;
/** Score at which a warning is issued but action is allowed */
const WARN_SCORE_THRESHOLD = 50;
/** Drawdown fraction above which we always issue a block violation */
const BLOCK_DRAWDOWN_THRESHOLD = 0.25;
/** Concentration HHI complement below which we warn */
const WARN_CONCENTRATION_THRESHOLD = 0.3;

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ExplainableRiskScoringService {
  private readonly logger = new Logger(ExplainableRiskScoringService.name);

  constructor(private readonly riskManagementService: RiskManagementService) {}

  /**
   * Computes an explainable risk score for a user's current portfolio before
   * allowing a high-impact action (rebalance, large withdrawal, stake, etc.).
   *
   * @param userId   - Owner of the portfolio.
   * @param positions - Current open positions.
   * @returns        ExplainedRiskScore with factors, violations, and a block decision.
   *
   * Time:  O(p)  where p = positions.length (dominated by portfolio risk calc)
   * Space: O(f)  where f = 4 fixed factors
   */
  async scoreForHighImpactAction(
    userId: string,
    positions: Position[],
  ): Promise<ExplainedRiskScore> {
    if (positions.length === 0) {
      return this.buildEmptyPortfolioScore(userId);
    }

    const risk: PortfolioRiskDto = await this.riskManagementService.calculatePortfolioRisk(
      userId,
      positions,
    );

    const factors = this.buildFactors(risk, positions);
    const score = this.computeScore(factors);
    const level = this.classifyLevel(score);
    const violations = this.detectViolations(risk, score);
    const shouldBlock = violations.some((v) => v.severity === 'block');
    const recommendedAction = this.deriveRecommendedAction(level, violations);

    this.logger.log(
      `Explainable risk score for user=${userId}: score=${score} level=${level} block=${shouldBlock}`,
    );

    return {
      score,
      level,
      scoreVersion: SCORE_VERSION,
      factors,
      violations,
      shouldBlock,
      recommendedAction,
      scoredAt: new Date().toISOString(),
    };
  }

  // ─── Factor builders ───────────────────────────────────────────────────────

  /**
   * Builds the four risk factors from an already-computed PortfolioRiskDto.
   * Each factor is normalised to [0, 1] before weighting.
   *
   * Time: O(1) — PortfolioRiskDto carries pre-computed values.
   */
  private buildFactors(risk: PortfolioRiskDto, positions: Position[]): RiskFactor[] {
    // Factor 1: VaR ratio (VaR-95 / totalValue), clamped to [0, 1]
    const varRatio = risk.totalValue > 0
      ? Math.min(1, risk.var95 / risk.totalValue)
      : 0;

    // Factor 2: Max drawdown, already in [0, 1]
    const drawdown = Math.min(1, risk.maxDrawdown);

    // Factor 3: Concentration (1 - diversification), in [0, 1]
    const concentration = Math.min(1, 1 - risk.diversificationScore);

    // Factor 4: Weighted-average volatility, normalised to a 50% vol ceiling
    const weightedVol = positions.reduce(
      (sum, p) => sum + (p.value / risk.totalValue) * p.volatility,
      0,
    );
    const normalisedVol = Math.min(1, weightedVol / 0.5);

    const rawFactors: Array<{
      name: string;
      raw: number;
      weight: number;
      rationale: string;
    }> = [
      {
        name: 'var_ratio',
        raw: varRatio,
        weight: WEIGHT_VAR_RATIO,
        rationale:
          `VaR-95 represents ${(varRatio * 100).toFixed(1)}% of total portfolio value. ` +
          `A ratio above 10% is considered elevated.`,
      },
      {
        name: 'max_drawdown',
        raw: drawdown,
        weight: WEIGHT_MAX_DRAWDOWN,
        rationale:
          `Maximum drawdown is ${(drawdown * 100).toFixed(1)}%. ` +
          `Values above 25% trigger a block on high-impact actions.`,
      },
      {
        name: 'concentration',
        raw: concentration,
        weight: WEIGHT_CONCENTRATION,
        rationale:
          `Portfolio concentration (1 − HHI) is ${(concentration * 100).toFixed(1)}%. ` +
          `High concentration increases single-asset exposure.`,
      },
      {
        name: 'weighted_volatility',
        raw: normalisedVol,
        weight: WEIGHT_VOLATILITY,
        rationale:
          `Weighted-average volatility is ${(weightedVol * 100).toFixed(1)}%, ` +
          `normalised against a 50% ceiling.`,
      },
    ];

    // Sort descending by weighted contribution for readability
    return rawFactors
      .map<RiskFactor>((f) => ({
        name: f.name,
        rawValue: f.raw,
        weight: f.weight,
        contribution: parseFloat((f.raw * f.weight * 100).toFixed(2)),
        rationale: f.rationale,
      }))
      .sort((a, b) => b.contribution - a.contribution);
  }

  /**
   * Sums factor contributions into a composite score [0, 100].
   * Time: O(f), Space: O(1)
   */
  private computeScore(factors: RiskFactor[]): number {
    const raw = factors.reduce((sum, f) => sum + f.contribution, 0);
    return parseFloat(Math.min(100, raw).toFixed(2));
  }

  /**
   * Maps numeric score to a categorical risk level.
   * Thresholds are fixed constants, not configurable at runtime, to prevent
   * callers from down-grading their own risk rating.
   */
  private classifyLevel(score: number): RiskLevel {
    if (score >= BLOCK_SCORE_THRESHOLD) return 'CRITICAL';
    if (score >= WARN_SCORE_THRESHOLD) return 'HIGH';
    if (score >= 25) return 'MODERATE';
    return 'LOW';
  }

  /**
   * Detects threshold violations.
   * Each violation carries a `rollbackDescription` so audit logs and UIs have
   * a concrete recovery/rollback instruction without further computation.
   *
   * Time: O(1) — fixed number of threshold checks.
   */
  private detectViolations(risk: PortfolioRiskDto, score: number): RiskThresholdViolation[] {
    const violations: RiskThresholdViolation[] = [];

    // 1. Score-level block
    if (score >= BLOCK_SCORE_THRESHOLD) {
      violations.push({
        factor: 'composite_score',
        threshold: BLOCK_SCORE_THRESHOLD,
        actual: score,
        severity: 'block',
        rollbackDescription:
          'Reject the high-impact action. Notify the user to reduce exposure ' +
          'before retrying. No state has been mutated; no rollback is required.',
      });
    }

    // 2. Drawdown hard-stop
    if (risk.maxDrawdown >= BLOCK_DRAWDOWN_THRESHOLD) {
      violations.push({
        factor: 'max_drawdown',
        threshold: BLOCK_DRAWDOWN_THRESHOLD,
        actual: risk.maxDrawdown,
        severity: 'block',
        rollbackDescription:
          `Drawdown of ${(risk.maxDrawdown * 100).toFixed(1)}% exceeds the ${(BLOCK_DRAWDOWN_THRESHOLD * 100).toFixed(0)}% hard limit. ` +
          'Block the action and surface the drawdown alert to the operator. ' +
          'Recovery: close losing positions or top up capital before proceeding.',
      });
    }

    // 3. Concentration warning
    if (risk.diversificationScore < WARN_CONCENTRATION_THRESHOLD) {
      violations.push({
        factor: 'concentration',
        threshold: WARN_CONCENTRATION_THRESHOLD,
        actual: risk.diversificationScore,
        severity: score >= BLOCK_SCORE_THRESHOLD ? 'block' : 'warn',
        rollbackDescription:
          'Portfolio is highly concentrated. Recommend diversification before high-impact actions. ' +
          'If the action is allowed despite this warning, record the user acknowledgement in the audit log.',
      });
    }

    // 4. Score-level warn (below block, still elevated)
    if (score >= WARN_SCORE_THRESHOLD && score < BLOCK_SCORE_THRESHOLD) {
      violations.push({
        factor: 'composite_score',
        threshold: WARN_SCORE_THRESHOLD,
        actual: score,
        severity: 'warn',
        rollbackDescription:
          'Score is elevated. Surface a risk acknowledgement dialog to the user. ' +
          'If the user confirms, proceed and append a RiskAcknowledgement audit record.',
      });
    }

    return violations;
  }

  /**
   * Derives a single, concise recommended action string from the risk level
   * and violation set.
   */
  private deriveRecommendedAction(
    level: RiskLevel,
    violations: RiskThresholdViolation[],
  ): string {
    const blockViolations = violations.filter((v) => v.severity === 'block');
    if (blockViolations.length > 0) {
      return (
        `Block action. Address ${blockViolations.length} critical violation(s): ` +
        blockViolations.map((v) => v.factor).join(', ') +
        '.'
      );
    }
    if (level === 'HIGH') {
      return 'Warn user and require explicit acknowledgement before proceeding.';
    }
    if (level === 'MODERATE') {
      return 'Proceed with standard risk disclosure.';
    }
    return 'No action required. Portfolio risk is within acceptable bounds.';
  }

  /**
   * Returns a minimal safe score for an empty portfolio.
   * An empty portfolio carries no measurable risk but should still not allow
   * actions that require a funded portfolio.
   */
  private buildEmptyPortfolioScore(userId: string): ExplainedRiskScore {
    this.logger.warn(`Explainable risk score requested for empty portfolio userId=${userId}`);
    return {
      score: 0,
      level: 'LOW',
      scoreVersion: SCORE_VERSION,
      factors: [],
      violations: [],
      shouldBlock: false,
      recommendedAction: 'Portfolio has no positions. Fund the portfolio before proceeding.',
      scoredAt: new Date().toISOString(),
    };
  }
}

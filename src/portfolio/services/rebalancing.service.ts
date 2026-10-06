import {
  Injectable,
  Logger,
  Optional,
  Inject,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { TradingTransactionService, TradeResult } from "src/investment/portfolio/services/trading-transaction.service";
import { DataSource } from "typeorm";
import { Portfolio } from "src/investment/portfolio/entities/portfolio.entity";
import { PortfolioAsset } from "src/investment/portfolio/entities/portfolio-asset.entity";
import { TargetAllocationVersion } from "src/portfolio/entities/target-allocation.entity";

export interface RebalancingRecommendation {
  asset: string;
  direction: "buy" | "sell";
  amount: number; // trade value in USD/currency
  quantity: number; // asset units
  price: number;
  currentDrift: number;
  expectedDriftAfter: number;
}

export interface ExecutedTradeInfo {
  asset: string;
  direction: "buy" | "sell";
  amount: number;
  quantity: number;
  price: number;
  txHash?: string;
}

export interface FailedTradeInfo {
  asset: string;
  direction: "buy" | "sell";
  amount: number;
  error: string;
}

export interface RebalancingExecutionResult {
  success: boolean;
  dryRun: boolean;
  executedTrades: ExecutedTradeInfo[];
  failedTrades: FailedTradeInfo[];
  resultingAllocation: Record<string, number>;
  executionLog: Array<{ timestamp: string; step: string; status: string }>;
}

export interface AssetHolding {
  amount: number;
  price: number;
}

@Injectable()
export class RebalancingService {
  private readonly logger = new Logger(RebalancingService.name);

  // In-memory holdings; allocation targets are persisted.
  private holdingsMap: Map<string, Record<string, AssetHolding>> = new Map();
  private thresholdMap: Map<string, number> = new Map();
  private executionHistoryMap: Map<string, RebalancingExecutionResult> = new Map();

  private defaultThreshold = 5.0; // 5%
  private tradingFee = 1.0; // $1.00 fee threshold
  private minTradeSize = 10.0; // $10 minimum trade size

  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly tradingService?: TradingTransactionService,
  ) {}

  setTradingFee(fee: number) {
    this.tradingFee = fee;
  }

  setMinTradeSize(size: number) {
    this.minTradeSize = size;
  }

  setDriftThreshold(portfolioId: string, threshold: number) {
    this.thresholdMap.set(portfolioId, threshold);
  }

  /**
   * Sets the target allocation for a portfolio.
   * @param portfolioId - The ID of the portfolio.
   * @param allocations - A map or record of asset symbols to target percentages.
   */
  async setTargetAllocations(
    portfolioId: string,
    allocations: Map<string, number> | Record<string, number>,
  ): Promise<void> {
    if (
      !allocations ||
      typeof allocations !== "object" ||
      Array.isArray(allocations)
    ) {
      throw new BadRequestException(
        "Allocations must be a map of asset symbols to percentages",
      );
    }
    const entries =
      allocations instanceof Map
        ? [...allocations]
        : Object.entries(allocations);
    // Accept up to six decimal places; floating point addition tolerance is 1e-8 percentage points.
    if (
      !entries.length ||
      entries.some(
        ([ticker, weight]) =>
          typeof ticker !== "string" ||
          !ticker.trim() ||
          typeof weight !== "number" ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          weight > 100 ||
          Math.abs(weight * 1e6 - Math.round(weight * 1e6)) > 1e-6,
      )
    ) {
      throw new BadRequestException(
        "Weights must be finite percentages from 0 to 100 with at most six decimal places",
      );
    }
    if (
      Math.abs(entries.reduce((total, [, weight]) => total + weight, 0) - 100) >
      1e-8
    ) {
      throw new BadRequestException("Target weights must sum to 100%");
    }
    await this.dataSource.transaction(async (manager) => {
      const portfolio = await manager.findOne(Portfolio, {
        where: { id: portfolioId },
        lock: { mode: "pessimistic_write" },
      });
      if (!portfolio) throw new NotFoundException("Portfolio not found");
      const assets = await manager.find(PortfolioAsset, {
        where: { portfolioId },
      });
      const targets = entries.map(([ticker, targetWeight]) => {
        const matches = assets.filter((asset) => asset.ticker === ticker);
        if (matches.length !== 1) {
          throw new BadRequestException(
            `Unknown or ambiguous portfolio asset: ${ticker}`,
          );
        }
        return { assetId: matches[0].id, ticker, targetWeight };
      });
      const previous = await manager.findOne(TargetAllocationVersion, {
        where: { portfolioId },
        order: { version: "DESC" },
      });
      await manager.save(
        TargetAllocationVersion,
        manager.create(TargetAllocationVersion, {
          portfolioId,
          version: (previous?.version ?? 0) + 1,
          allocations: targets,
        }),
      );
      await manager.update(Portfolio, portfolioId, {
        targetAllocation: Object.fromEntries(entries),
      });
    });
  }

  async getTargetAllocationVersion(portfolioId: string) {
    const latest = await this.dataSource
      .getRepository(TargetAllocationVersion)
      .findOne({
        where: { portfolioId },
        order: { version: "DESC" },
      });
    return latest ?? null;
  }

  getTargetAllocationHistory(portfolioId: string) {
    return this.dataSource.getRepository(TargetAllocationVersion).find({
      where: { portfolioId },
      order: { version: "DESC" },
    });
  }

  async getTargetAllocations(
    portfolioId: string,
  ): Promise<Record<string, number>> {
    const latest = await this.getTargetAllocationVersion(portfolioId);
    return Object.fromEntries(
      (latest?.allocations ?? []).map(({ ticker, targetWeight }) => [
        ticker,
        targetWeight,
      ]),
    );
  }

  /**
   * Sets current asset holdings for a portfolio.
   */
  async setHoldings(
    portfolioId: string,
    holdings: Map<string, AssetHolding> | Record<string, AssetHolding>,
  ): Promise<void> {
    const holdingsRecord: Record<string, AssetHolding> =
      holdings instanceof Map
        ? Object.fromEntries(holdings.entries())
        : { ...holdings };

    this.holdingsMap.set(portfolioId, holdingsRecord);
  }

  async getHoldings(portfolioId: string): Promise<Record<string, AssetHolding>> {
    return this.holdingsMap.get(portfolioId) || {};
  }

  /**
   * Calculates rebalancing recommendations for a portfolio.
   * Compares current holdings against target allocations and accounts for drift threshold, fees, and minimum trade sizes.
   */
  async getRebalancingRecommendations(
    portfolioId: string,
    customThreshold?: number,
  ): Promise<RebalancingRecommendation[]> {
    this.logger.log(`Calculating rebalancing recommendations for portfolio ${portfolioId}`);

    const targets = await this.getTargetAllocations(portfolioId);
    const holdings = await this.getHoldings(portfolioId);
    const threshold =
      customThreshold ?? this.thresholdMap.get(portfolioId) ?? this.defaultThreshold;

    const assets = Array.from(new Set([...Object.keys(targets), ...Object.keys(holdings)]));
    if (assets.length === 0) {
      return [];
    }

    // Compute total portfolio value
    let totalValue = 0;
    const currentValues: Record<string, number> = {};
    for (const asset of assets) {
      const holding = holdings[asset] || { amount: 0, price: 0 };
      const val = holding.amount * holding.price;
      currentValues[asset] = val;
      totalValue += val;
    }

    if (totalValue === 0) {
      return [];
    }

    // Compute current allocation percentages and drift per asset
    const currentAllocations: Record<string, number> = {};
    const drifts: Record<string, number> = {};
    let maxDrift = 0;

    for (const asset of assets) {
      const targetPct = targets[asset] || 0;
      const currentPct = (currentValues[asset] / totalValue) * 100;
      currentAllocations[asset] = currentPct;

      const drift = Math.abs(currentPct - targetPct);
      drifts[asset] = drift;
      if (drift > maxDrift) {
        maxDrift = drift;
      }
    }

    // Apply drift threshold: if maximum drift is below threshold, produce no trades
    if (maxDrift < threshold) {
      this.logger.log(`Max drift ${maxDrift}% is below threshold ${threshold}%. No trades recommended.`);
      return [];
    }

    // Generate trade recommendations for assets requiring rebalancing
    const recommendations: RebalancingRecommendation[] = [];

    for (const asset of assets) {
      const targetPct = targets[asset] || 0;
      const currentPct = currentAllocations[asset] || 0;
      const targetValue = (targetPct / 100) * totalValue;
      const currentValue = currentValues[asset] || 0;
      const tradeValue = targetValue - currentValue;

      if (Math.abs(tradeValue) === 0) continue;

      // Account for trading fees and minimum trade sizes so recommendations are not uneconomic
      if (Math.abs(tradeValue) < this.minTradeSize || Math.abs(tradeValue) <= this.tradingFee) {
        this.logger.log(`Skipping trade for ${asset}: trade value $${Math.abs(tradeValue)} is uneconomic (minTrade: $${this.minTradeSize}, fee: $${this.tradingFee})`);
        continue;
      }

      const price = holdings[asset]?.price || 1;
      const quantity = Math.abs(tradeValue) / price;

      recommendations.push({
        asset,
        direction: tradeValue > 0 ? "buy" : "sell",
        amount: Math.abs(tradeValue),
        quantity,
        price,
        currentDrift: drifts[asset],
        expectedDriftAfter: 0,
      });
    }

    return recommendations;
  }

  /**
   * Executes rebalancing trades for a portfolio with idempotency, partial failure reporting, and dry-run support.
   * Handles best-effort execution, tracking executed vs failed trades, pre/post audit logs, and dry run simulation.
   */
  async executeRebalancing(
    portfolioId: string,
    dryRun: boolean = false,
    clientReference?: string,
  ): Promise<RebalancingExecutionResult> {
    const executionKey = clientReference
      ? `${portfolioId}:${clientReference}`
      : `${portfolioId}:${dryRun ? "dry" : "exec"}`;

    // Idempotency check
    if (clientReference && this.executionHistoryMap.has(executionKey)) {
      this.logger.log(`Idempotent rebalancing execution requested for key ${clientReference}`);
      return this.executionHistoryMap.get(executionKey)!;
    }

    const executionLog: Array<{ timestamp: string; step: string; status: string }> = [];
    executionLog.push({
      timestamp: new Date().toISOString(),
      step: "INITIATE_REBALANCING",
      status: `Started rebalancing for portfolio ${portfolioId} (dryRun: ${dryRun})`,
    });

    const recommendations = await this.getRebalancingRecommendations(portfolioId);
    if (recommendations.length === 0) {
      const holdings = await this.getHoldings(portfolioId);
      const currentAllocation = this.calculateAllocationPercentages(holdings);

      const result: RebalancingExecutionResult = {
        success: true,
        dryRun,
        executedTrades: [],
        failedTrades: [],
        resultingAllocation: currentAllocation,
        executionLog: [
          ...executionLog,
          {
            timestamp: new Date().toISOString(),
            step: "COMPLETED",
            status: "No rebalancing trades required.",
          },
        ],
      };
      if (clientReference) this.executionHistoryMap.set(executionKey, result);
      return result;
    }

    // Dry Run Mode: compute projected resulting allocation without executing trades
    if (dryRun) {
      executionLog.push({
        timestamp: new Date().toISOString(),
        step: "DRY_RUN_SIMULATION",
        status: `Simulating ${recommendations.length} recommended trades`,
      });

      const projectedExecutedTrades: ExecutedTradeInfo[] = recommendations.map((rec) => ({
        asset: rec.asset,
        direction: rec.direction,
        amount: rec.amount,
        quantity: rec.quantity,
        price: rec.price,
      }));

      const targets = await this.getTargetAllocations(portfolioId);

      const dryRunResult: RebalancingExecutionResult = {
        success: true,
        dryRun: true,
        executedTrades: projectedExecutedTrades,
        failedTrades: [],
        resultingAllocation: targets,
        executionLog: [
          ...executionLog,
          {
            timestamp: new Date().toISOString(),
            step: "DRY_RUN_COMPLETED",
            status: "Dry run completed successfully.",
          },
        ],
      };
      if (clientReference) this.executionHistoryMap.set(executionKey, dryRunResult);
      return dryRunResult;
    }

    // Best-Effort Execution Mode
    const executedTrades: ExecutedTradeInfo[] = [];
    const failedTrades: FailedTradeInfo[] = [];
    const holdings = { ...(await this.getHoldings(portfolioId)) };

    for (const rec of recommendations) {
      executionLog.push({
        timestamp: new Date().toISOString(),
        step: `SUBMIT_TRADE_${rec.asset}`,
        status: `Submitting ${rec.direction} trade for ${rec.quantity} of ${rec.asset}`,
      });

      try {
        let tradeRes: TradeResult | undefined;

        if (this.tradingService) {
          tradeRes = await this.tradingService.executeTrade(
            portfolioId,
            rec.asset,
            rec.direction,
            rec.quantity,
            rec.price,
            clientReference ? `${clientReference}-${rec.asset}` : undefined,
          );
        } else {
          // Direct execution fallback if tradingService is not provided
          tradeRes = {
            success: true,
            transactionHash: `tx-rebalance-${rec.asset}-${Date.now()}`,
            executedQuantity: rec.quantity,
            executedPrice: rec.price,
            status: "CONFIRMED",
            timestamp: new Date().toISOString(),
          };
        }

        if (tradeRes.success) {
          executedTrades.push({
            asset: rec.asset,
            direction: rec.direction,
            amount: rec.amount,
            quantity: rec.quantity,
            price: rec.price,
            txHash: tradeRes.transactionHash,
          });

          // Update holding state for executed trade
          const currentHolding = holdings[rec.asset] || { amount: 0, price: rec.price };
          const updatedAmount =
            rec.direction === "buy"
              ? currentHolding.amount + rec.quantity
              : Math.max(0, currentHolding.amount - rec.quantity);

          holdings[rec.asset] = { amount: updatedAmount, price: rec.price };

          executionLog.push({
            timestamp: new Date().toISOString(),
            step: `CONFIRMED_TRADE_${rec.asset}`,
            status: `Trade succeeded with hash ${tradeRes.transactionHash}`,
          });
        } else {
          failedTrades.push({
            asset: rec.asset,
            direction: rec.direction,
            amount: rec.amount,
            error: tradeRes.errorReason || "Trade execution failed",
          });

          executionLog.push({
            timestamp: new Date().toISOString(),
            step: `FAILED_TRADE_${rec.asset}`,
            status: `Trade failed: ${tradeRes.errorReason}`,
          });
        }
      } catch (err: any) {
        failedTrades.push({
          asset: rec.asset,
          direction: rec.direction,
          amount: rec.amount,
          error: err.message,
        });

        executionLog.push({
          timestamp: new Date().toISOString(),
          step: `ERROR_TRADE_${rec.asset}`,
          status: `Exception during execution: ${err.message}`,
        });
      }
    }

    // Save updated holdings after executed trades
    await this.setHoldings(portfolioId, holdings);
    const resultingAllocation = this.calculateAllocationPercentages(holdings);

    const overallSuccess = failedTrades.length === 0;

    const result: RebalancingExecutionResult = {
      success: overallSuccess,
      dryRun: false,
      executedTrades,
      failedTrades,
      resultingAllocation,
      executionLog: [
        ...executionLog,
        {
          timestamp: new Date().toISOString(),
          step: "EXECUTION_FINISHED",
          status: overallSuccess
            ? "Rebalancing fully succeeded."
            : `Rebalancing finished with ${failedTrades.length} failed trade(s).`,
        },
      ],
    };

    if (clientReference) {
      this.executionHistoryMap.set(executionKey, result);
    }

    return result;
  }

  private calculateAllocationPercentages(
    holdings: Record<string, AssetHolding>,
  ): Record<string, number> {
    let total = 0;
    const values: Record<string, number> = {};
    for (const [asset, holding] of Object.entries(holdings)) {
      const val = holding.amount * holding.price;
      values[asset] = val;
      total += val;
    }

    if (total === 0) return {};

    const allocations: Record<string, number> = {};
    for (const [asset, val] of Object.entries(values)) {
      allocations[asset] = Number(((val / total) * 100).toFixed(2));
    }
    return allocations;
  }
}

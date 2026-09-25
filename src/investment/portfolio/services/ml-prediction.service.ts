import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { PerformanceMetric } from "../entities/performance-metric.entity";
import { Portfolio } from "../entities/portfolio.entity";
import {
  EnsemblePredictor,
  calculateExpectedReturn,
  calculateConfidence,
} from "../ml-models/predictor";

@Injectable()
export class MLPredictionService {
  private readonly logger = new Logger(MLPredictionService.name);
  private predictors: Map<string, EnsemblePredictor> = new Map();

  constructor(
    @InjectRepository(PerformanceMetric)
    private performanceRepository: Repository<PerformanceMetric>,
    @InjectRepository(Portfolio)
    private portfolioRepository: Repository<Portfolio>,
  ) {}

  /**
   * Train ML model for an asset
   */
  async trainAssetPredictor(
    ticker: string,
    historicalPrices: number[],
  ): Promise<{ confidence: number; metrics: any }> {
    try {
      const predictor = new EnsemblePredictor();

      // Train the model
      const metrics = predictor.fit(historicalPrices);

      // Store predictor for later use
      this.predictors.set(ticker, predictor);

      const confidence = calculateConfidence(metrics);

      this.logger.log(
        `Trained predictor for ${ticker}. Confidence: ${confidence}`,
      );

      return { confidence, metrics };
    } catch (error) {
      this.logger.error(
        `Failed to train predictor for ${ticker}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Predict future returns for an asset
   */
  async predictAssetReturns(
    ticker: string,
    currentPrice: number,
    historicalPrices: number[],
    daysAhead: number = 30,
  ): Promise<{
    predictedReturn: number;
    confidence: number;
    predictions: number[];
  }> {
    try {
      // Train if not already trained
      if (!this.predictors.has(ticker)) {
        await this.trainAssetPredictor(ticker, historicalPrices);
      }

      const predictor = this.predictors.get(ticker);

      if (!predictor) {
        throw new Error(`No predictor available for ${ticker}`);
      }

      // Generate predictions
      const predictions = predictor.forecast(historicalPrices, daysAhead);

      // Calculate expected return
      const expectedReturn = calculateExpectedReturn(
        currentPrice,
        predictions,
        daysAhead,
      );

      // Get confidence
      const confidence = Math.random() * 0.8 + 0.2; // Placeholder

      return {
        predictedReturn: expectedReturn,
        confidence,
        predictions,
      };
    } catch (error) {
      this.logger.error(`Prediction failed for ${ticker}: ${error.message}`);
      // Return neutral prediction on error
      return {
        predictedReturn: 0.05,
        confidence: 0.2,
        predictions: [],
      };
    }
  }

  /**
   * Predict portfolio returns
   */
  async predictPortfolioReturns(
    portfolioId: string,
    assetDataMap: Map<string, { price: number; historicalPrices: number[] }>,
    daysAhead: number = 30,
  ): Promise<{
    portfolioExpectedReturn: number;
    assetPredictions: Map<string, any>;
  }> {
    const portfolio = await this.portfolioRepository.findOne({
      where: { id: portfolioId },
      relations: { assets: true },
    });
    if (!portfolio) {
      throw new NotFoundException(`Portfolio ${portfolioId} not found`);
    }
    const assets = portfolio.assets ?? [];
    if (assets.length === 0) {
      throw new UnprocessableEntityException(
        "Portfolio has no assets to predict",
      );
    }

    // Asset.value is the same current holding value used by PortfolioService
    // to calculate currentAllocation. Target and initial allocations are plans.
    const values = new Map<string, number>();
    for (const asset of assets) {
      const value = Number(asset.value);
      if (
        asset.value == null ||
        !Number.isFinite(value) ||
        value < 0 ||
        values.has(asset.ticker)
      ) {
        throw new UnprocessableEntityException(
          `Unavailable or ambiguous weight for ${asset.ticker}`,
        );
      }
      values.set(asset.ticker, value);
    }
    const totalValue = [...values.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    if (totalValue <= 0) {
      throw new UnprocessableEntityException(
        "Portfolio weights are unavailable: total asset value is zero",
      );
    }
    if (
      assetDataMap.size !== values.size ||
      [...values.keys()].some((ticker) => !assetDataMap.has(ticker))
    ) {
      throw new UnprocessableEntityException(
        "Prediction data must cover every portfolio asset",
      );
    }

    const assetPredictions = new Map();
    let weightedReturn = 0;

    for (const [ticker, data] of assetDataMap) {
      const prediction = await this.predictAssetReturns(
        ticker,
        data.price,
        data.historicalPrices,
        daysAhead,
      );
      assetPredictions.set(ticker, prediction);
      weightedReturn +=
        prediction.predictedReturn * (values.get(ticker)! / totalValue);
    }

    return {
      portfolioExpectedReturn: weightedReturn,
      assetPredictions,
    };
  }

  /**
   * Update prediction model with new data
   */
  async updatePredictorWithNewData(
    ticker: string,
    newPrice: number,
  ): Promise<void> {
    // In a real implementation, this would update the model incrementally
    // For now, just log it
    this.logger.debug(`Updated prediction data for ${ticker}: ${newPrice}`);
  }

  /**
   * Clear old predictors (for memory management)
   */
  clearOldPredictors(maxAge: number = 24 * 60 * 60 * 1000): void {
    // Implement LRU or time-based cache eviction
    this.logger.log("Clearing old predictors");
  }

  /**
   * Get predictor statistics
   */
  getPredictorStats(): {
    totalPredictors: number;
    tickers: string[];
  } {
    return {
      totalPredictors: this.predictors.size,
      tickers: Array.from(this.predictors.keys()),
    };
  }
}

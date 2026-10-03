import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PriceFeedService } from "../../blockchain/oracle/services/price-feed.service";
import { SupportedChain } from "../../blockchain/oracle/entities/price-record.entity";
import { YieldOptimizationService } from "../../defi/services/yield-optimization.service";
import { CacheWarmingService } from "./cache-warming.service";
import { CacheService } from "./cache.service";
import {
  AssetPriceTarget,
  DEFAULT_YIELD_CHAIN,
  DEFAULT_YIELD_TOKENS,
  MARKET_DATA_CACHE_TTL_SECONDS,
  PRICE_FEED_CACHE_NAMESPACE,
  YIELD_OPPORTUNITY_CACHE_NAMESPACE,
  yieldOpportunityCacheArgs,
} from "./market-cache.constants";

/** Top-traded assets warmed against the configured Ethereum oracle feeds. */
export const TOP_ASSET_PRICE_TARGETS: readonly AssetPriceTarget[] = [
  "BTC", "ETH", "USDC", "USDT", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX",
  "LINK", "AVAX", "DOT", "MATIC", "WBTC", "LTC", "DAI", "BCH", "UNI", "SHIB",
].map((asset) => ({ asset, chain: SupportedChain.ETHEREUM }));

@Injectable()
export class MarketCacheWarmersService implements OnModuleInit {
  private readonly logger = new Logger(MarketCacheWarmersService.name);

  constructor(
    private readonly cacheWarming: CacheWarmingService,
    private readonly priceFeed: PriceFeedService,
    private readonly yieldOptimization: YieldOptimizationService,
  ) {}

  onModuleInit(): void {
    this.cacheWarming.registerWarmer({
      name: "top-asset-prices",
      execute: (cache) => this.warmTopAssetPrices(cache),
    });
    this.cacheWarming.registerWarmer({
      name: "yield-opportunities",
      execute: (cache) => this.warmYieldOpportunities(cache),
    });
  }

  private async warmTopAssetPrices(cache: CacheService): Promise<number> {
    let nextTarget = 0;
    let warmed = 0;
    const worker = async () => {
      while (nextTarget < TOP_ASSET_PRICE_TARGETS.length) {
        const target = TOP_ASSET_PRICE_TARGETS[nextTarget++];
        try {
          const price = await this.priceFeed.getCurrentPrice(target.asset, target.chain);
          await cache.set(
            PRICE_FEED_CACHE_NAMESPACE,
            price,
            [target.chain, target.asset],
            MARKET_DATA_CACHE_TTL_SECONDS,
          );
          warmed++;
        } catch (err) {
          this.logger.warn(
            `Could not warm ${target.asset}/${target.chain}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(4, TOP_ASSET_PRICE_TARGETS.length) }, worker));
    return warmed;
  }

  private async warmYieldOpportunities(cache: CacheService): Promise<number> {
    const tokens = [...DEFAULT_YIELD_TOKENS];
    const opportunities = await this.yieldOptimization.findHighestYieldOpportunities(
      tokens,
      DEFAULT_YIELD_CHAIN,
    );
    await cache.set(
      YIELD_OPPORTUNITY_CACHE_NAMESPACE,
      Object.fromEntries(opportunities),
      yieldOpportunityCacheArgs(DEFAULT_YIELD_CHAIN, tokens),
      MARKET_DATA_CACHE_TTL_SECONDS,
    );
    return 1;
  }
}

import { CacheWarmingService } from "./cache-warming.service";
import { CacheService } from "./cache.service";
import { CacheWarmer } from "./cache-warming.service";
import {
  MarketCacheWarmersService,
  TOP_ASSET_PRICE_TARGETS,
} from "./market-cache-warmers.service";
import {
  DEFAULT_YIELD_CHAIN,
  DEFAULT_YIELD_TOKENS,
  MARKET_DATA_CACHE_TTL_SECONDS,
  PRICE_FEED_CACHE_NAMESPACE,
  YIELD_OPPORTUNITY_CACHE_NAMESPACE,
  yieldOpportunityCacheArgs,
} from "./market-cache.constants";

describe("MarketCacheWarmersService", () => {
  it("registers and warms top prices plus public yield opportunities", async () => {
    const registered: CacheWarmer[] = [];
    const cacheWarming = {
      registerWarmer: jest.fn((warmer: CacheWarmer) => {
        registered.push(warmer);
      }),
    } as unknown as CacheWarmingService;
    const priceFeed = {
      getCurrentPrice: jest.fn().mockResolvedValue({ price: 123 }),
    };
    const yieldOpportunities = new Map([
      ["USDC", [{ protocol: "Aave", apy: 4.2 }]],
    ]);
    const yieldOptimization = {
      findHighestYieldOpportunities: jest.fn().mockResolvedValue(yieldOpportunities),
    };
    const set = jest.fn().mockResolvedValue(undefined);
    const cache = { set } as unknown as CacheService;

    const service = new MarketCacheWarmersService(
      cacheWarming,
      priceFeed as any,
      yieldOptimization as any,
    );
    service.onModuleInit();

    expect(registered.map(({ name }) => name)).toEqual([
      "top-asset-prices",
      "yield-opportunities",
    ]);
    expect(await registered[0].execute(cache)).toBe(TOP_ASSET_PRICE_TARGETS.length);
    expect(priceFeed.getCurrentPrice).toHaveBeenCalledTimes(TOP_ASSET_PRICE_TARGETS.length);
    expect(set).toHaveBeenCalledWith(
      PRICE_FEED_CACHE_NAMESPACE,
      { price: 123 },
      [TOP_ASSET_PRICE_TARGETS[0].chain, TOP_ASSET_PRICE_TARGETS[0].asset],
      MARKET_DATA_CACHE_TTL_SECONDS,
    );

    expect(await registered[1].execute(cache)).toBe(1);
    expect(yieldOptimization.findHighestYieldOpportunities).toHaveBeenCalledWith(
      [...DEFAULT_YIELD_TOKENS],
      DEFAULT_YIELD_CHAIN,
    );
    expect(set).toHaveBeenLastCalledWith(
      YIELD_OPPORTUNITY_CACHE_NAMESPACE,
      Object.fromEntries(yieldOpportunities),
      yieldOpportunityCacheArgs(DEFAULT_YIELD_CHAIN, [...DEFAULT_YIELD_TOKENS]),
      MARKET_DATA_CACHE_TTL_SECONDS,
    );
  });
});

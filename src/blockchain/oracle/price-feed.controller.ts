import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  PriceFeedService,
  DEFAULT_MAX_FEED_AGE_SECONDS,
} from "./services/price-feed.service";
import {
  GetHistoricalPricesDto,
  OracleAggregateDto,
  PriceResponseDto,
} from "./dto/price-feed.dto";
import { SupportedChain } from "./entities/price-record.entity";
import { CacheService } from "../../common/cache/cache.service";
import {
  MARKET_DATA_CACHE_TTL_SECONDS,
  PRICE_FEED_CACHE_NAMESPACE,
} from "../../common/cache/market-cache.constants";

@ApiTags("Price Feed")
@Controller("price-feed")
export class PriceFeedController {
  constructor(
    private readonly priceFeedService: PriceFeedService,
    private readonly cache: CacheService,
  ) {}

  @Get(":chain/:asset")
  @ApiOperation({
    summary: "Get current aggregated price for an asset on a chain",
    description:
      "Median of every fresh oracle feed. Feeds older than the freshness " +
      "window are discarded, statistical outliers (>5% from the median) are " +
      "discarded, and the response flags the result when a feed was stale or " +
      "the last known valid price had to be reused.",
  })
  @ApiResponse({ status: 200, type: PriceResponseDto })
  async getCurrentPrice(
    @Param("chain") chain: SupportedChain,
    @Param("asset") asset: string,
  ): Promise<PriceResponseDto> {
    const cacheArgs = [chain, asset.toUpperCase()];
    const cached = await this.cache.get<PriceResponseDto>(
      PRICE_FEED_CACHE_NAMESPACE,
      ...cacheArgs,
    );
    if (cached !== null) return cached;

    const price = await this.priceFeedService.getCurrentPrice(asset, chain);
    await this.cache.set(
      PRICE_FEED_CACHE_NAMESPACE,
      price,
      cacheArgs,
      MARKET_DATA_CACHE_TTL_SECONDS,
    );
    return price;
  }

  /**
   * Breakdown of the medianizer: every oracle that answered, how old its
   * answer was, whether it was kept, and — when nothing fresh was available —
   * whether the last known valid price was reused instead.
   */
  @Get(":chain/:asset/oracles")
  @ApiOperation({
    summary: "Inspect the multi-oracle medianizer for an asset on a chain",
    description:
      "Aggregates the configured oracles (Chainlink, Band, Uniswap V3 TWAP), " +
      "rejects feeds older than the freshness window, rejects statistical " +
      "outliers and reports the median with the confidence it carries.",
  })
  @ApiQuery({
    name: "maxAgeSeconds",
    required: false,
    type: Number,
    description: `Freshness window for a feed in seconds (default ${DEFAULT_MAX_FEED_AGE_SECONDS})`,
  })
  @ApiOkResponse({ type: OracleAggregateDto })
  async getOracleAggregation(
    @Param("chain") chain: SupportedChain,
    @Param("asset") asset: string,
    @Query("maxAgeSeconds") maxAgeSeconds?: number,
  ): Promise<OracleAggregateDto> {
    const aggregation = await this.priceFeedService.getOracleAggregation(
      asset,
      chain,
      maxAgeSeconds ? Number(maxAgeSeconds) : undefined,
    );

    return {
      asset: asset.toUpperCase(),
      chain,
      price: aggregation.price,
      confidence: aggregation.confidence,
      stale: aggregation.stale,
      usedFallbackPrice: aggregation.usedFallbackPrice,
      maxDeviationPercent: aggregation.maxDeviationPercent,
      maxAgeSeconds: aggregation.maxAgeSeconds,
      quotes: aggregation.quotes,
    };
  }

  @Get(":chain/:asset/history")
  @ApiOperation({ summary: "Get historical prices for an asset on a chain" })
  @ApiResponse({ status: 200, type: [PriceResponseDto] })
  async getHistoricalPrices(
    @Param("chain") chain: SupportedChain,
    @Param("asset") asset: string,
    @Query() query: GetHistoricalPricesDto,
  ): Promise<PriceResponseDto[]> {
    return this.priceFeedService.getHistoricalPrices(asset, chain, query.limit);
  }
}

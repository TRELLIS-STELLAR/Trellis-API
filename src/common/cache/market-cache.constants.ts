import { SupportedChain } from "../../blockchain/oracle/entities/price-record.entity";

export const MARKET_DATA_CACHE_TTL_SECONDS = 15 * 60;
export const PRICE_FEED_CACHE_NAMESPACE = "price-feed-current";
export const YIELD_OPPORTUNITY_CACHE_NAMESPACE = "yield-opportunities";

export const DEFAULT_YIELD_TOKENS = ["USDC", "DAI", "USDT"] as const;
export const DEFAULT_YIELD_CHAIN = "ethereum";

export function yieldOpportunityCacheArgs(
  chain: string,
  tokens: string[],
): string[] {
  return [
    chain.trim().toLowerCase(),
    ...[...new Set(tokens.map((token) => token.trim().toUpperCase()).filter(Boolean))].sort(),
  ];
}

export interface AssetPriceTarget {
  asset: string;
  chain: SupportedChain;
}

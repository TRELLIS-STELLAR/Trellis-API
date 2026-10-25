export type TradeSide = "buy" | "sell";

export interface TradingPolicy {
  enabled: boolean;
  maxOrderAmount: number;
  allowedAssets?: string[];
  allowedSides: TradeSide[];
}

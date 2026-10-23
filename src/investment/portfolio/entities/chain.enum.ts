/**
 * Blockchain network of a portfolio asset or transaction. Kept in a leaf module
 * so transaction.entity can use it without importing portfolio-asset.entity,
 * whose import cycle (asset -> portfolio -> transaction -> asset) left `Chain`
 * undefined when the transaction entity's decorators ran.
 */
export enum Chain {
  ETHEREUM = "ethereum",
  POLYGON = "polygon",
  BINANCE = "binance",
  SOLANA = "solana",
  BITCOIN = "bitcoin",
  ARBITRUM = "arbitrum",
  OPTIMISM = "optimism",
  BASE = "base",
  OTHER = "other",
}

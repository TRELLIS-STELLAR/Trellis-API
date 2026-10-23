import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Portfolio } from "./portfolio.entity";
import { Chain } from "./chain.enum";

export enum AssetType {
  STOCK = "stock",
  BOND = "bond",
  CRYPTOCURRENCY = "cryptocurrency",
  COMMODITY = "commodity",
  ETF = "etf",
  MUTUAL_FUND = "mutual_fund",
  REAL_ESTATE = "real_estate",
  OTHER = "other",
}

export { Chain };

@Entity("portfolio_assets")
@Index(["portfolioId", "ticker", "chain"], { unique: true })
@Index(["portfolioId", "chain"])
export class PortfolioAsset {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ length: 20 })
  ticker: string;

  @Column()
  name: string;

  @Column({
    type: "enum",
    enum: Chain,
    default: Chain.OTHER,
  })
  chain: Chain;

  @Column({
    type: "enum",
    enum: AssetType,
    default: AssetType.CRYPTOCURRENCY,
  })
  type: AssetType;

  // Current holding quantity
  @Column({ type: "decimal", precision: 18, scale: 8, default: 0 })
  quantity: number;

  // Current price / value per unit
  @Column({ type: "decimal", precision: 18, scale: 8, nullable: true })
  currentPrice: number;

  // Current total value
  @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
  value: number;

  // Current allocation percentage
  @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
  allocationPercentage: number;

  // Optimization-suggested allocation percentage
  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  suggestedAllocation: number;

  // Asset metrics
  @Column({ type: "decimal", precision: 5, scale: 4, nullable: true })
  expectedReturn: number;

  @Column({ type: "decimal", precision: 5, scale: 4, nullable: true })
  volatility: number; // Standard deviation

  @Column({ type: "decimal", precision: 5, scale: 4, nullable: true })
  beta: number; // Market beta

  @Column({ type: "decimal", precision: 18, scale: 2, nullable: true })
  costBasis: number;

  @Column({ type: "decimal", precision: 18, scale: 2, nullable: true })
  unrealizedGain: number;

  @Column({ type: "decimal", precision: 18, scale: 8, nullable: true })
  costBasisPerShare: number;

  // Historical data for ML models
  @Column({ type: "jsonb", nullable: true })
  priceHistory: Array<{ date: string; price: number }>;

  @Column({ type: "jsonb", nullable: true })
  returnsHistory: number[];

  // Asset metadata
  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt: Date;

  @Column({ nullable: true })
  lastPriceUpdate: Date;

  // Relations
  @ManyToOne(() => Portfolio, (portfolio) => portfolio.assets, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "portfolioId" })
  portfolio: Portfolio;

  @Column("uuid")
  portfolioId: string;
}

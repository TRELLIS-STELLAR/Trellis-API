import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Portfolio } from "src/investment/portfolio/entities/portfolio.entity";

/** Immutable, complete allocation versions; omitted assets are removed on replacement. */
@Entity("target_allocation_versions")
@Index(["portfolioId", "version"], { unique: true })
export class TargetAllocationVersion {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column("uuid")
  portfolioId: string;

  @ManyToOne(() => Portfolio, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "portfolioId" })
  portfolio: Portfolio;

  @Column("integer")
  version: number;

  @Column("jsonb")
  allocations: Array<{ assetId: string; ticker: string; targetWeight: number }>;

  @CreateDateColumn({ type: "timestamp" })
  updatedAt: Date;
}

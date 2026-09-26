import { Entity, Column, PrimaryColumn, Index } from "typeorm";

@Entity("background_jobs")
@Index(["type", "status"])
@Index(["createdAt"])
export class BackgroundJob {
  @PrimaryColumn()
  id: string;

  @Column()
  type: string;

  @Column("jsonb")
  payload: any;

  @Column({ default: "normal" })
  priority: string;

  @Column({ default: 0 })
  attempts: number;

  @Column({ default: 3 })
  maxAttempts: number;

  @Column({ default: 1000 })
  backoffMs: number;

  @Column({ nullable: true })
  delayMs: number | null;

  @Column({ default: "pending" })
  status: string;

  @Column({ nullable: true })
  error: string | null;

  @Column("jsonb", { nullable: true })
  result: any;

  @Column({ nullable: true })
  correlationId: string | null;

  @Column({ default: "1.0.0" })
  schemaVersion: string;

  @Column({ type: "timestamp" })
  createdAt: Date;

  @Column({ type: "timestamp" })
  updatedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  completedAt: Date | null;

  @Column({ type: "timestamp", nullable: true })
  failedAt: Date | null;

  @Column({ type: "timestamp", nullable: true })
  deadLetteredAt: Date | null;
}

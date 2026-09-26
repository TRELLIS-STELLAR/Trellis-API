import { Entity, Column, PrimaryColumn, Index } from "typeorm";

export enum ExportStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  EXPIRED = "expired",
}

@Entity("data_exports")
@Index(["userId", "status"])
@Index(["expiresAt"])
export class DataExport {
  @PrimaryColumn()
  id: string;

  @Column()
  userId: string;

  @Column({ type: "enum", enum: ExportStatus, default: ExportStatus.PENDING })
  status: ExportStatus;

  @Column()
  scope: string;

  @Column({ default: "json" })
  format: string;

  @Column({ default: "1.0.0" })
  schemaVersion: string;

  @Column("jsonb", { nullable: true })
  filters: Record<string, any>;

  @Column({ nullable: true })
  downloadUrl: string | null;

  @Column({ type: "timestamp" })
  expiresAt: Date;

  @Column({ type: "timestamp" })
  createdAt: Date;

  @Column({ type: "timestamp", nullable: true })
  completedAt: Date | null;

  @Column({ nullable: true })
  error: string | null;
}

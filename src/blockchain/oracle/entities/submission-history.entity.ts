import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("oracle_submission_history")
@Index("UQ_oracle_history_payload", ["payloadHash"], { unique: true })
@Index("UQ_oracle_history_transaction", ["transactionHash"], { unique: true })
@Index("IDX_oracle_history_pending", ["verificationStatus", "updatedAt"])
export class SubmissionHistory {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 64 })
  payloadHash: string;

  @Column({ type: "varchar", length: 56 })
  submitter: string;

  @Column({ type: "varchar", length: 64 })
  transactionHash: string;

  @Column({ type: "varchar", length: 16, default: "pending" })
  verificationStatus: "pending" | "verified" | "rejected";

  @Column({ type: "text", nullable: true })
  verificationError: string | null;

  @CreateDateColumn({ type: "timestamp" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamp" })
  updatedAt: Date;
}

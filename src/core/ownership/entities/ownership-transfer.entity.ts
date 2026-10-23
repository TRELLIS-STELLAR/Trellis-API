import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export enum OwnershipTransferStatus {
  PENDING = "PENDING",
  ACCEPTED = "ACCEPTED",
  CANCELLED = "CANCELLED",
  EXPIRED = "EXPIRED",
  REJECTED = "REJECTED",
}

@Entity("ownership_transfers")
@Index(["resourceType", "resourceId", "status"])
@Index(["proposedOwnerId", "status"])
@Index(["currentOwnerId", "status"])
export class OwnershipTransfer {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  resourceType!: string;

  @Column({ type: "varchar", length: 128 })
  resourceId!: string;

  @Column({ type: "varchar", length: 128 })
  currentOwnerId!: string;

  @Column({ type: "varchar", length: 128 })
  proposedOwnerId!: string;

  @Column({
    type: "varchar",
    length: 32,
    default: OwnershipTransferStatus.PENDING,
  })
  status!: OwnershipTransferStatus;

  @Column({ type: "timestamptz" })
  expiresAt!: Date;

  @Column({ type: "timestamptz", nullable: true })
  acceptedAt?: Date;

  @Column({ type: "timestamptz", nullable: true })
  cancelledAt?: Date;

  @Column({ type: "varchar", length: 255, nullable: true })
  cancellationReason?: string;

  @Column({ type: "timestamptz", nullable: true })
  rejectedAt?: Date;

  @Column({ type: "varchar", length: 255, nullable: true })
  rejectionReason?: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}

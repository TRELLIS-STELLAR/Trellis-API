import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { User } from "src/core/user/entities/user.entity";

@Entity("api_keys")
@Index("UQ_api_keys_hash", ["keyHash"], { unique: true })
@Index("IDX_api_keys_owner", ["userId"])
export class ApiKey {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 64, select: false })
  keyHash: string;

  @Column("uuid")
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  @Column({ type: "varchar", length: 100 })
  name: string;

  @Column("jsonb")
  permissions: string[];

  @CreateDateColumn({ type: "timestamp" })
  createdAt: Date;

  @Column({ type: "timestamp", nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: "timestamp", nullable: true })
  expiresAt: Date | null;

  @Column({ type: "boolean", default: false })
  revoked: boolean;
}

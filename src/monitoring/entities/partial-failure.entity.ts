
import { Entity, Column, Index } from "typeorm";
import { BaseEntity } from "../../common/database/entities/base.entity";

export enum PartialFailureSeverity {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

export enum PartialFailureStatus {
  UNRESOLVED = "UNRESOLVED",
  RESOLVED = "RESOLVED",
  IGNORED = "IGNORED",
}

@Entity("partial_failures")
export class PartialFailure extends BaseEntity {
  @Index()
  @Column({ type: "varchar", length: 100 })
  operationType: string;

  @Index()
  @Column({ type: "varchar", length: 255, nullable: true })
  externalReferenceId: string;

  @Column({ type: "varchar", default: PartialFailureSeverity.MEDIUM })
  severity: PartialFailureSeverity;

  @Column({ type: "varchar", default: PartialFailureStatus.UNRESOLVED })
  status: PartialFailureStatus;

  @Column({ type: "boolean", default: false })
  retryable: boolean;

  @Column({ type: "varchar", length: 2048, nullable: true })
  retryUrl: string;

  @Column({ type: "varchar", length: 2048, nullable: true })
  inspectUrl: string;

  @Column({ type: "varchar", length: 2048, nullable: true })
  remediationDocsUrl: string;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, any>;
  
  @Column({ type: "timestamp", nullable: true })
  resolvedAt: Date;
}
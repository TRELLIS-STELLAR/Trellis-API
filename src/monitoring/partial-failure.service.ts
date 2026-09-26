
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { PartialFailure, PartialFailureStatus } from "./entities/partial-failure.entity";

@Injectable()
export class PartialFailureService {
  private readonly logger = new Logger(PartialFailureService.name);

  constructor(
    @InjectRepository(PartialFailure)
    private readonly failureRepo: Repository<PartialFailure>,
  ) {}

  async reportFailure(data: Partial<PartialFailure>): Promise<PartialFailure> {
    // Scrub secrets from metadata if provided
    if (data.metadata) {
      data.metadata = this.scrubSecrets(data.metadata);
    }
    const failure = this.failureRepo.create(data);
    return this.failureRepo.save(failure);
  }

  async resolveFailure(id: string): Promise<PartialFailure> {
    const failure = await this.failureRepo.findOne({ where: { id } });
    if (!failure) {
      throw new Error("Failure not found");
    }
    failure.status = PartialFailureStatus.RESOLVED;
    failure.resolvedAt = new Date();
    return this.failureRepo.save(failure);
  }
  
  async ignoreFailure(id: string): Promise<PartialFailure> {
    const failure = await this.failureRepo.findOne({ where: { id } });
    if (!failure) {
      throw new Error("Failure not found");
    }
    failure.status = PartialFailureStatus.IGNORED;
    failure.resolvedAt = new Date();
    return this.failureRepo.save(failure);
  }

  async getDashboardReport() {
    const unresolved = await this.failureRepo.find({
      where: { status: PartialFailureStatus.UNRESOLVED },
      order: { createdAt: "DESC" },
    });

    // Group failures by operation type, age, severity, and retryability
    const grouped = unresolved.reduce((acc, failure) => {
      const type = failure.operationType || "UNKNOWN";
      if (!acc[type]) acc[type] = [];
      acc[type].push(failure);
      return acc;
    }, {} as Record<string, PartialFailure[]>);
    
    const summary = unresolved.map(f => {
      const ageMs = Date.now() - new Date(f.createdAt).getTime();
      return {
        id: f.id,
        operationType: f.operationType,
        externalReferenceId: f.externalReferenceId,
        severity: f.severity,
        retryable: f.retryable,
        ageInHours: Math.floor(ageMs / (1000 * 60 * 60)),
        retryUrl: f.retryUrl,
        inspectUrl: f.inspectUrl,
        remediationDocsUrl: f.remediationDocsUrl,
        metadata: f.metadata
      };
    });

    return {
      totalUnresolved: unresolved.length,
      groupedByType: grouped,
      summary,
    };
  }

  private scrubSecrets(metadata: any): any {
    if (!metadata || typeof metadata !== "object") return metadata;
    const scrubbed = { ...metadata };
    const secretKeys = ["password", "secret", "token", "key", "authorization"];
    
    for (const key of Object.keys(scrubbed)) {
      if (secretKeys.some(sk => key.toLowerCase().includes(sk))) {
        scrubbed[key] = "[REDACTED]";
      } else if (typeof scrubbed[key] === "object") {
        scrubbed[key] = this.scrubSecrets(scrubbed[key]);
      }
    }
    return scrubbed;
  }
}
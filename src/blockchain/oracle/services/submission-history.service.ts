import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SubmissionHistory } from "src/blockchain/oracle/entities/submission-history.entity";

export interface SubmissionReference {
  payloadHash: string;
  submitter: string;
  transactionHash: string;
}

/** Retain these compact replay keys indefinitely; do not TTL or delete verified rows. */
@Injectable()
export class SubmissionHistoryService {
  constructor(
    @InjectRepository(SubmissionHistory)
    private readonly repository: Repository<SubmissionHistory>,
  ) {}

  async record(input: SubmissionReference): Promise<SubmissionHistory> {
    if (
      !input ||
      !/^[a-fA-F0-9]{64}$/.test(input.payloadHash) ||
      !/^[a-fA-F0-9]{64}$/.test(input.transactionHash) ||
      typeof input.submitter !== "string" ||
      !/^[GC][A-Z2-7]{55}$/.test(input.submitter)
    ) {
      throw new BadRequestException(
        "Expected 64-character payload/transaction hashes and a Stellar submitter address",
      );
    }
    const payloadHash = input.payloadHash.toLowerCase();
    const transactionHash = input.transactionHash.toLowerCase();
    if (
      await this.repository.exists({
        where: [{ payloadHash }, { transactionHash }],
      })
    ) {
      throw new ConflictException("Duplicate oracle submission");
    }
    try {
      return await this.repository.save(
        this.repository.create({
          payloadHash,
          transactionHash,
          submitter: input.submitter,
          verificationStatus: "pending",
        }),
      );
    } catch (error) {
      // Unique indexes enforce replay protection even across concurrent API instances.
      if (error.code === "23505" || error.driverError?.code === "23505") {
        throw new ConflictException("Duplicate oracle submission");
      }
      throw error;
    }
  }

  history(limit = 100, offset = 0) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      throw new BadRequestException(
        "History limit must be 1–100 and offset must be nonnegative",
      );
    }
    return this.repository.find({
      order: { createdAt: "DESC", id: "DESC" },
      take: limit,
      skip: offset,
    });
  }

  pending() {
    return this.repository.find({
      where: { verificationStatus: "pending" },
      order: { updatedAt: "ASC", id: "ASC" },
      take: 100,
    });
  }

  async defer(id: string, verificationError: string) {
    await this.repository.update(
      { id, verificationStatus: "pending" },
      { verificationError, updatedAt: new Date() },
    );
  }

  async setResult(
    id: string,
    verificationStatus: "verified" | "rejected",
    verificationError: string | null = null,
  ) {
    await this.repository.update(
      { id, verificationStatus: "pending" },
      { verificationStatus, verificationError },
    );
  }
}

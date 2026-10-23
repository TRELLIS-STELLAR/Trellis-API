import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { SubmissionHistory } from "src/blockchain/oracle/entities/submission-history.entity";

export interface SubmissionReference {
  payloadHash: string;
  submitter: string;
  transactionHash: string;
}

/** Bounds one batch to a single lookup of at most 200 hashes and 100 inserts. */
export const MAX_SUBMISSION_BATCH = 100;

const INVALID_REFERENCE =
  "Expected 64-character payload/transaction hashes and a Stellar submitter address";

export type BatchItemStatus =
  | "recorded"
  | "already_recorded"
  | "invalid"
  | "conflict"
  | "failed";

export interface BatchItemResult {
  index: number;
  status: BatchItemStatus;
  id?: string;
  error?: string;
  /** True only for transient failures; resending the item may succeed. */
  retryable: boolean;
}

export interface BatchRecordResult {
  total: number;
  succeeded: number;
  failed: number;
  results: BatchItemResult[];
}

function normalizeReference(input: unknown): SubmissionReference | null {
  const candidate = input as SubmissionReference;
  if (
    !candidate ||
    typeof candidate.payloadHash !== "string" ||
    typeof candidate.transactionHash !== "string" ||
    typeof candidate.submitter !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(candidate.payloadHash) ||
    !/^[a-fA-F0-9]{64}$/.test(candidate.transactionHash) ||
    !/^[GC][A-Z2-7]{55}$/.test(candidate.submitter)
  )
    return null;
  return {
    payloadHash: candidate.payloadHash.toLowerCase(),
    transactionHash: candidate.transactionHash.toLowerCase(),
    submitter: candidate.submitter,
  };
}

function isUniqueViolation(error: any): boolean {
  return error?.code === "23505" || error?.driverError?.code === "23505";
}

function sameReference(row: SubmissionReference, ref: SubmissionReference) {
  return (
    row.payloadHash === ref.payloadHash &&
    row.transactionHash === ref.transactionHash &&
    row.submitter === ref.submitter
  );
}

/** Retain these compact replay keys indefinitely; do not TTL or delete verified rows. */
@Injectable()
export class SubmissionHistoryService {
  constructor(
    @InjectRepository(SubmissionHistory)
    private readonly repository: Repository<SubmissionHistory>,
  ) {}

  async record(input: SubmissionReference): Promise<SubmissionHistory> {
    const reference = normalizeReference(input);
    if (!reference) {
      throw new BadRequestException(INVALID_REFERENCE);
    }
    const { payloadHash, transactionHash } = reference;
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
      if (isUniqueViolation(error)) {
        throw new ConflictException("Duplicate oracle submission");
      }
      throw error;
    }
  }

  /**
   * Records each reference independently and reports per-item outcomes, so one
   * bad item never discards the others. Resending a whole batch is idempotent:
   * already stored identical references report `already_recorded`. Cost is
   * O(n) time and memory with one lookup query plus at most n inserts.
   */
  async recordBatch(inputs: unknown[]): Promise<BatchRecordResult> {
    if (
      !Array.isArray(inputs) ||
      inputs.length < 1 ||
      inputs.length > MAX_SUBMISSION_BATCH
    ) {
      throw new BadRequestException(
        `Batch must contain 1–${MAX_SUBMISSION_BATCH} submissions`,
      );
    }
    const references = inputs.map(normalizeReference);
    const valid = references.filter(Boolean);
    const existing = valid.length
      ? await this.repository.find({
          where: [
            { payloadHash: In(valid.map((ref) => ref.payloadHash)) },
            { transactionHash: In(valid.map((ref) => ref.transactionHash)) },
          ],
        })
      : [];
    const byPayload = new Map(existing.map((row) => [row.payloadHash, row]));
    const byTransaction = new Map(
      existing.map((row) => [row.transactionHash, row]),
    );

    const results: BatchItemResult[] = [];
    for (const [index, ref] of references.entries()) {
      if (!ref) {
        results.push({
          index,
          status: "invalid",
          error: INVALID_REFERENCE,
          retryable: false,
        });
        continue;
      }
      let row =
        byPayload.get(ref.payloadHash) ??
        byTransaction.get(ref.transactionHash);
      if (!row) {
        try {
          row = await this.repository.save(
            this.repository.create({ ...ref, verificationStatus: "pending" }),
          );
          byPayload.set(row.payloadHash, row);
          byTransaction.set(row.transactionHash, row);
          results.push({
            index,
            status: "recorded",
            id: row.id,
            retryable: false,
          });
          continue;
        } catch (error) {
          if (!isUniqueViolation(error)) {
            results.push({
              index,
              status: "failed",
              error: "Submission could not be stored",
              retryable: true,
            });
            continue;
          }
          // A concurrent writer won the unique index; classify against its row.
          row = await this.repository.findOne({
            where: [
              { payloadHash: ref.payloadHash },
              { transactionHash: ref.transactionHash },
            ],
          });
        }
      }
      results.push(
        row && sameReference(row, ref)
          ? { index, status: "already_recorded", id: row.id, retryable: false }
          : {
              index,
              status: "conflict",
              error: "Duplicate oracle submission",
              retryable: false,
            },
      );
    }
    const succeeded = results.filter(
      (result) =>
        result.status === "recorded" || result.status === "already_recorded",
    ).length;
    return {
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    };
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

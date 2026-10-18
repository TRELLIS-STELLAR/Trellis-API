import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  OwnershipTransfer,
  OwnershipTransferStatus,
} from "./entities/ownership-transfer.entity";

export interface InitiateTransferDto {
  resourceType: string;
  resourceId: string;
  currentOwnerId: string;
  proposedOwnerId: string;
  expiresInHours?: number;
}

@Injectable()
export class OwnershipTransferService {
  private readonly logger = new Logger(OwnershipTransferService.name);

  // In-memory store fallback for environments without DB or for testing
  private inMemoryStore = new Map<string, OwnershipTransfer>();

  constructor(
    @InjectRepository(OwnershipTransfer)
    private readonly transferRepo?: Repository<OwnershipTransfer>,
  ) {}

  /**
   * Initiates a two-step ownership transfer request.
   */
  async initiateTransfer(dto: InitiateTransferDto): Promise<OwnershipTransfer> {
    if (dto.currentOwnerId === dto.proposedOwnerId) {
      throw new BadRequestException("Cannot transfer ownership to yourself.");
    }

    if (!dto.resourceType || !dto.resourceId) {
      throw new BadRequestException("resourceType and resourceId are required.");
    }

    // Check for existing pending transfer for this resource
    const existing = await this.findPendingByResource(dto.resourceType, dto.resourceId);
    if (existing && !this.isExpired(existing)) {
      throw new ConflictException(
        `A pending ownership transfer already exists for ${dto.resourceType}:${dto.resourceId}`,
      );
    }

    const expiresInHours = dto.expiresInHours && dto.expiresInHours > 0 ? dto.expiresInHours : 72;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    const transfer: OwnershipTransfer = {
      id: `ot_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      currentOwnerId: dto.currentOwnerId,
      proposedOwnerId: dto.proposedOwnerId,
      status: OwnershipTransferStatus.PENDING,
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (this.transferRepo) {
      return await this.transferRepo.save(transfer);
    }

    this.inMemoryStore.set(transfer.id, transfer);
    this.logger.log(
      `Initiated ownership transfer ${transfer.id} for ${dto.resourceType}:${dto.resourceId} to ${dto.proposedOwnerId}`,
    );
    return transfer;
  }

  /**
   * Proposed owner accepts the pending transfer within the validity window.
   */
  async acceptTransfer(transferId: string, actorId: string): Promise<OwnershipTransfer> {
    const transfer = await this.getTransferById(transferId);

    if (this.isExpired(transfer)) {
      transfer.status = OwnershipTransferStatus.EXPIRED;
      await this.save(transfer);
      throw new BadRequestException("Ownership transfer request has expired.");
    }

    if (transfer.status !== OwnershipTransferStatus.PENDING) {
      throw new BadRequestException(
        `Cannot accept transfer with status '${transfer.status}'. Only PENDING transfers can be accepted.`,
      );
    }

    if (transfer.proposedOwnerId !== actorId) {
      throw new ForbiddenException(
        "Only the proposed owner is authorized to accept this transfer.",
      );
    }

    transfer.status = OwnershipTransferStatus.ACCEPTED;
    transfer.acceptedAt = new Date();
    transfer.updatedAt = new Date();

    const saved = await this.save(transfer);
    this.logger.log(
      `Ownership transfer ${transferId} ACCEPTED by ${actorId}. Ownership transitioned from ${transfer.currentOwnerId}.`,
    );
    return saved;
  }

  /**
   * Current owner cancels an unaccepted transfer before expiration.
   */
  async cancelTransfer(
    transferId: string,
    actorId: string,
    reason?: string,
  ): Promise<OwnershipTransfer> {
    const transfer = await this.getTransferById(transferId);

    if (transfer.status !== OwnershipTransferStatus.PENDING) {
      throw new BadRequestException(
        `Cannot cancel transfer with status '${transfer.status}'.`,
      );
    }

    if (transfer.currentOwnerId !== actorId) {
      throw new ForbiddenException(
        "Only the current owner is authorized to cancel this transfer.",
      );
    }

    transfer.status = OwnershipTransferStatus.CANCELLED;
    transfer.cancelledAt = new Date();
    transfer.cancellationReason = reason ?? "Cancelled by initiator";
    transfer.updatedAt = new Date();

    const saved = await this.save(transfer);
    this.logger.log(`Ownership transfer ${transferId} CANCELLED by ${actorId}.`);
    return saved;
  }

  /**
   * Proposed owner declines an unaccepted transfer.
   */
  async rejectTransfer(
    transferId: string,
    actorId: string,
    reason?: string,
  ): Promise<OwnershipTransfer> {
    const transfer = await this.getTransferById(transferId);

    if (transfer.status !== OwnershipTransferStatus.PENDING) {
      throw new BadRequestException(`Cannot reject transfer with status '${transfer.status}'.`);
    }

    if (transfer.proposedOwnerId !== actorId) {
      throw new ForbiddenException(
        "Only the proposed owner is authorized to reject this transfer.",
      );
    }

    transfer.status = OwnershipTransferStatus.REJECTED;
    transfer.rejectedAt = new Date();
    transfer.rejectionReason = reason ?? "Rejected by proposed owner";
    transfer.updatedAt = new Date();

    return await this.save(transfer);
  }

  /**
   * Retrieve a transfer by ID, automatically resolving expiry.
   */
  async getTransfer(transferId: string): Promise<OwnershipTransfer> {
    const transfer = await this.getTransferById(transferId);
    if (transfer.status === OwnershipTransferStatus.PENDING && this.isExpired(transfer)) {
      transfer.status = OwnershipTransferStatus.EXPIRED;
      return await this.save(transfer);
    }
    return transfer;
  }

  /**
   * List pending transfers for a user.
   */
  async listTransfers(
    userId: string,
    direction: "incoming" | "outgoing" | "all" = "all",
  ): Promise<OwnershipTransfer[]> {
    let all: OwnershipTransfer[] = [];

    if (this.transferRepo) {
      all = await this.transferRepo.find();
    } else {
      all = Array.from(this.inMemoryStore.values());
    }

    // Refresh expiry
    for (const t of all) {
      if (t.status === OwnershipTransferStatus.PENDING && this.isExpired(t)) {
        t.status = OwnershipTransferStatus.EXPIRED;
        await this.save(t);
      }
    }

    return all.filter((t) => {
      if (direction === "incoming") return t.proposedOwnerId === userId;
      if (direction === "outgoing") return t.currentOwnerId === userId;
      return t.currentOwnerId === userId || t.proposedOwnerId === userId;
    });
  }

  private isExpired(transfer: OwnershipTransfer): boolean {
    return new Date(transfer.expiresAt).getTime() <= Date.now();
  }

  private async getTransferById(id: string): Promise<OwnershipTransfer> {
    if (this.transferRepo) {
      const found = await this.transferRepo.findOne({ where: { id } });
      if (!found) throw new NotFoundException(`Ownership transfer '${id}' not found.`);
      return found;
    }

    const found = this.inMemoryStore.get(id);
    if (!found) throw new NotFoundException(`Ownership transfer '${id}' not found.`);
    return found;
  }

  private async findPendingByResource(
    resourceType: string,
    resourceId: string,
  ): Promise<OwnershipTransfer | null> {
    if (this.transferRepo) {
      return await this.transferRepo.findOne({
        where: {
          resourceType,
          resourceId,
          status: OwnershipTransferStatus.PENDING,
        },
      });
    }

    for (const t of this.inMemoryStore.values()) {
      if (
        t.resourceType === resourceType &&
        t.resourceId === resourceId &&
        t.status === OwnershipTransferStatus.PENDING
      ) {
        return t;
      }
    }
    return null;
  }

  private async save(transfer: OwnershipTransfer): Promise<OwnershipTransfer> {
    if (this.transferRepo) {
      return await this.transferRepo.save(transfer);
    }
    this.inMemoryStore.set(transfer.id, transfer);
    return transfer;
  }
}

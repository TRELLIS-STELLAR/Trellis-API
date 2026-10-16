import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  QueuedOperation,
  EnqueueOperationInput,
  OperationStatus,
  ConflictResolutionChoice,
  ConflictDetails,
  OperationQueueStorage,
  TabCoordinationMessage,
} from "./operation-queue.types";
import { OptimisticConcurrencyService } from "../concurrency/optimistic-concurrency.service";

export class InMemoryOperationQueueStorage implements OperationQueueStorage {
  private readonly store = new Map<string, QueuedOperation>();

  async save(op: QueuedOperation): Promise<void> {
    this.store.set(op.id, { ...op });
  }

  async get(id: string): Promise<QueuedOperation | null> {
    const found = this.store.get(id);
    return found ? { ...found } : null;
  }

  async getAll(): Promise<QueuedOperation[]> {
    return Array.from(this.store.values()).map((op) => ({ ...op }));
  }

  async remove(id: string): Promise<void> {
    this.store.delete(id);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

@Injectable()
export class OperationQueueService {
  private readonly logger = new Logger(OperationQueueService.name);
  private readonly tabId = randomUUID();
  private readonly storage: OperationQueueStorage;
  private isOnlineStatus = true;
  private isProcessing = false;
  private channel: BroadcastChannel | null = null;

  constructor(
    @Optional() storage?: OperationQueueStorage,
    @Optional() private readonly concurrencyService?: OptimisticConcurrencyService,
  ) {
    this.storage = storage ?? new InMemoryOperationQueueStorage();
    if (!this.concurrencyService) {
      this.concurrencyService = new OptimisticConcurrencyService();
    }
    this.initCoordinationChannel();
  }

  private initCoordinationChannel(): void {
    if (typeof BroadcastChannel !== "undefined") {
      try {
        this.channel = new BroadcastChannel("trellis_operation_queue");
        if (typeof (this.channel as any).unref === "function") {
          (this.channel as any).unref();
        }
        this.channel.onmessage = (event) => {
          this.handleCoordinationMessage(event.data);
        };
      } catch (e) {
        this.logger.debug("BroadcastChannel not available in current environment");
      }
    }
  }

  private broadcast(message: Partial<TabCoordinationMessage>): void {
    if (this.channel) {
      try {
        this.channel.postMessage({
          ...message,
          tabId: this.tabId,
          timestamp: Date.now(),
        });
      } catch (e) {
        // channel may be closed
      }
    }
  }

  private handleCoordinationMessage(msg: TabCoordinationMessage): void {
    if (msg.tabId === this.tabId) return;
    this.logger.debug(`Received coordination message from tab ${msg.tabId}: ${msg.type}`);
  }

  async enqueue<T = any>(input: EnqueueOperationInput<T>): Promise<QueuedOperation<T>> {
    const now = Date.now();
    const op: QueuedOperation<T> = {
      id: input.id ?? randomUUID(),
      type: input.type,
      entityId: input.entityId,
      expectedVersion: input.expectedVersion,
      payload: input.payload,
      status: "PENDING",
      attempts: 0,
      maxRetries: input.maxRetries ?? 3,
      createdAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotencyKey,
    };

    await this.storage.save(op);
    this.broadcast({ type: "OP_ENQUEUED", operationId: op.id });
    this.logger.log(`Enqueued operation ${op.id} (${op.type}) for entity ${op.entityId}`);
    return op;
  }

  async getOperation(id: string): Promise<QueuedOperation | null> {
    return this.storage.get(id);
  }

  async getAllOperations(filter?: {
    status?: OperationStatus;
    entityId?: string;
  }): Promise<QueuedOperation[]> {
    let all = await this.storage.getAll();
    if (filter?.status) {
      all = all.filter((op) => op.status === filter.status);
    }
    if (filter?.entityId) {
      all = all.filter((op) => op.entityId === filter.entityId);
    }
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }

  async processNext(
    executor: (op: QueuedOperation) => Promise<{ actualVersion: number }>,
  ): Promise<QueuedOperation | null> {
    if (!this.isOnlineStatus) {
      this.logger.debug("Queue paused: currently offline");
      return null;
    }

    const pending = (await this.storage.getAll())
      .filter((op) => op.status === "PENDING")
      .sort((a, b) => a.createdAt - b.createdAt);

    if (pending.length === 0) {
      return null;
    }

    const op = pending[0];
    op.status = "IN_FLIGHT";
    op.attempts++;
    op.lastAttemptAt = Date.now();
    op.updatedAt = Date.now();
    await this.storage.save(op);

    try {
      const result = await executor(op);

      // Verify version match if version returned
      if (result.actualVersion !== undefined && result.actualVersion !== op.expectedVersion) {
        // Concurrency conflict detected!
        return this.flagConflict(op, result.actualVersion);
      }

      op.status = "COMPLETED";
      op.updatedAt = Date.now();
      await this.storage.save(op);
      this.broadcast({ type: "OP_COMPLETED", operationId: op.id });
      this.logger.log(`Operation ${op.id} completed successfully`);
      return op;
    } catch (error: any) {
      // Check if error is an Optimistic Concurrency ConflictException
      if (
        error instanceof ConflictException ||
        error?.name === "ConflictException" ||
        error?.response?.actualVersion !== undefined
      ) {
        const actualVersion =
          error?.response?.actualVersion ?? (op.expectedVersion + 1);
        return this.flagConflict(op, actualVersion, error.message);
      }

      // Retryable failure
      if (op.attempts >= op.maxRetries) {
        op.status = "FAILED";
        op.error = error.message || String(error);
      } else {
        op.status = "PENDING"; // Eligible for backoff retry
        op.error = error.message || String(error);
      }
      op.updatedAt = Date.now();
      await this.storage.save(op);
      this.logger.warn(`Operation ${op.id} attempt ${op.attempts} failed: ${op.error}`);
      return op;
    }
  }

  private async flagConflict(
    op: QueuedOperation,
    actualVersion: number,
    customReason?: string,
  ): Promise<QueuedOperation> {
    op.status = "CONFLICT";
    op.conflictDetails = {
      expectedVersion: op.expectedVersion,
      actualVersion,
      reason:
        customReason ??
        `Entity ${op.entityId} was modified concurrently. Expected version ${op.expectedVersion}, found ${actualVersion}.`,
      allowedChoices: ["RETRY_WITH_LATEST", "DISCARD", "FORCE_APPLY"],
      detectedAt: Date.now(),
    };
    op.updatedAt = Date.now();
    await this.storage.save(op);
    this.broadcast({ type: "OP_CONFLICT", operationId: op.id });
    this.logger.warn(`Conflict detected for operation ${op.id}: ${op.conflictDetails.reason}`);
    return op;
  }

  async resolveConflict(
    operationId: string,
    choice: ConflictResolutionChoice,
    overrides?: { payload?: any },
  ): Promise<QueuedOperation> {
    const op = await this.storage.get(operationId);
    if (!op) {
      throw new NotFoundException(`Operation ${operationId} not found`);
    }

    if (op.status !== "CONFLICT" || !op.conflictDetails) {
      throw new BadRequestException(
        `Operation ${operationId} is in status ${op.status}, not CONFLICT`,
      );
    }

    switch (choice) {
      case "RETRY_WITH_LATEST":
        // Re-align expectedVersion to current actual version
        op.expectedVersion = op.conflictDetails.actualVersion;
        if (overrides?.payload) {
          op.payload = overrides.payload;
        }
        op.status = "PENDING";
        op.attempts = 0; // Reset attempts for resolved retry
        op.conflictDetails = undefined;
        op.updatedAt = Date.now();
        await this.storage.save(op);
        this.broadcast({ type: "OP_RESOLVED", operationId: op.id });
        this.logger.log(`Conflict on operation ${op.id} resolved via RETRY_WITH_LATEST (v${op.expectedVersion})`);
        return op;

      case "DISCARD":
        op.status = "DISCARDED";
        op.updatedAt = Date.now();
        await this.storage.save(op);
        this.broadcast({ type: "OP_RESOLVED", operationId: op.id });
        this.logger.log(`Conflict on operation ${op.id} resolved via DISCARD`);
        return op;

      case "FORCE_APPLY":
        op.expectedVersion = op.conflictDetails.actualVersion;
        op.status = "PENDING";
        op.conflictDetails = undefined;
        op.updatedAt = Date.now();
        await this.storage.save(op);
        this.broadcast({ type: "OP_RESOLVED", operationId: op.id });
        this.logger.log(`Conflict on operation ${op.id} resolved via FORCE_APPLY`);
        return op;

      default:
        throw new BadRequestException(`Unsupported conflict resolution choice: ${choice}`);
    }
  }

  setOnline(online: boolean): void {
    this.isOnlineStatus = online;
    this.logger.log(`OperationQueue connectivity set to: ${online ? "ONLINE" : "OFFLINE"}`);
  }

  isOnline(): boolean {
    return this.isOnlineStatus;
  }

  close(): void {
    if (this.channel) {
      try {
        this.channel.close();
      } catch (e) {}
      this.channel = null;
    }
  }
}

export type OperationStatus =
  | 'PENDING'
  | 'IN_FLIGHT'
  | 'CONFLICT'
  | 'COMPLETED'
  | 'FAILED'
  | 'DISCARDED';

export type ConflictResolutionChoice =
  | 'RETRY_WITH_LATEST'
  | 'DISCARD'
  | 'FORCE_APPLY';

export interface ConflictDetails {
  expectedVersion: number;
  actualVersion: number;
  reason: string;
  allowedChoices: ConflictResolutionChoice[];
  detectedAt: number;
}

export interface QueuedOperation<T = any> {
  id: string;
  type: string;
  entityId: string;
  expectedVersion: number;
  payload: T;
  status: OperationStatus;
  attempts: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt?: number;
  conflictDetails?: ConflictDetails;
  error?: string;
  idempotencyKey?: string;
}

export interface EnqueueOperationInput<T = any> {
  id?: string;
  type: string;
  entityId: string;
  expectedVersion: number;
  payload: T;
  maxRetries?: number;
  idempotencyKey?: string;
}

export interface OperationQueueStorage {
  save(op: QueuedOperation): Promise<void>;
  get(id: string): Promise<QueuedOperation | null>;
  getAll(): Promise<QueuedOperation[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface TabCoordinationMessage {
  type: 'LEADER_PING' | 'OP_ENQUEUED' | 'OP_COMPLETED' | 'OP_CONFLICT' | 'OP_RESOLVED';
  tabId: string;
  operationId?: string;
  timestamp: number;
}

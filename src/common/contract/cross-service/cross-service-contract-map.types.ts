/**
 * @file cross-service-contract-map.types.ts
 *
 * Cross-service integration contract map for domain events and integration boundaries (issue #227).
 *
 * Provides the single source of truth for all cross-service asynchronous domain events,
 * message envelopes, producer/consumer topologies, required payload fields, versioning rules,
 * failure policies, operational edge cases, and rollback/recovery runbooks across:
 * - NestJS core backend & auth
 * - Portfolio & asset management
 * - DeFi protocol adapters
 * - Notifications service
 * - Observability & telemetry
 * - Stellar blockchain settlement & reconciliation
 */

export type ServiceIdentifier =
  | "auth-service"
  | "portfolio-service"
  | "defi-adapter-service"
  | "notifications-service"
  | "observability-service"
  | "settlement-service";

export type EventTransportProtocol =
  | "event-emitter"
  | "bull-queue"
  | "websocket-gateway"
  | "webhook-dispatcher";

export type BackoffStrategy = "exponential" | "linear" | "fixed";

export type FallbackBehavior =
  | "drop-with-alert"
  | "queue-offline"
  | "degrade-gracefully"
  | "compensate-transaction";

export type VersionEvolutionRule =
  | "strict-minor-additive"
  | "major-breaking-migration";

export interface RetryPolicy {
  maxRetries: number;
  backoffStrategy: BackoffStrategy;
  initialIntervalMs: number;
  maxIntervalMs: number;
  jitter: boolean;
}

export interface CircuitBreakerPolicy {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  fallbackAction: FallbackBehavior;
}

export interface ConsumerFailureBehavior {
  retryPolicy: RetryPolicy;
  deadLetterQueue: string;
  circuitBreaker: CircuitBreakerPolicy;
  allowedFallback: FallbackBehavior;
}

export interface ConsumerContract {
  consumer: ServiceIdentifier;
  handlerMethod: string;
  consumerVersion: string;
  failureBehavior: ConsumerFailureBehavior;
}

export interface VersioningRules {
  schemaVersion: string;
  evolutionRule: VersionEvolutionRule;
  backwardCompatible: boolean;
  forwardCompatible: boolean;
  deprecationGracePeriodDays: number;
}

export interface OperationalEdgeCases {
  idempotencyKeyField: string;
  deduplicationTtlSecs: number;
  outOfOrderHandling: string;
  clockDriftToleranceSecs: number;
  partitionToleranceStrategy: string;
}

export interface RollbackAndRecovery {
  rollbackTrigger: string;
  stateCompensationAction: string;
  manualRecoveryRunbook: string;
}

export interface DomainEventContractDefinition<T = Record<string, any>> {
  eventName: string;
  description: string;
  producer: ServiceIdentifier;
  transport: EventTransportProtocol;
  versioning: VersioningRules;
  requiredFields: string[];
  payloadSchema: Record<string, string>;
  consumers: ConsumerContract[];
  operationalEdgeCases: OperationalEdgeCases;
  rollbackAndRecovery: RollbackAndRecovery;
}

export interface DomainEventEnvelope<T = Record<string, any>> {
  eventId: string;
  eventName: string;
  schemaVersion: string;
  producer: ServiceIdentifier;
  timestamp: string;
  correlationId: string;
  payload: T;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

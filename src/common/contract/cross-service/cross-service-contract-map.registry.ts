/**
 * @file cross-service-contract-map.registry.ts
 *
 * Executable registry and validation engine for cross-service domain event contracts (issue #227).
 */

import {
  DomainEventContractDefinition,
  DomainEventEnvelope,
  ServiceIdentifier,
  ValidationResult,
  ConsumerContract,
} from "./cross-service-contract-map.types";

export const CROSS_SERVICE_EVENT_DEFINITIONS: DomainEventContractDefinition[] =
  [
    // -------------------------------------------------------------------------
    // Auth & Identity Integration Boundaries
    // -------------------------------------------------------------------------
    {
      eventName: "auth.user.authenticated",
      description:
        "Emitted when a user successfully authenticates via password, WebAuthn, or API key.",
      producer: "auth-service",
      transport: "event-emitter",
      versioning: {
        schemaVersion: "1.0.0",
        evolutionRule: "strict-minor-additive",
        backwardCompatible: true,
        forwardCompatible: true,
        deprecationGracePeriodDays: 90,
      },
      requiredFields: [
        "userId",
        "authMethod",
        "ipAddress",
        "sessionId",
        "authenticatedAt",
      ],
      payloadSchema: {
        userId: "string (UUID v4)",
        authMethod: "string (password | webauthn | apikey)",
        ipAddress: "string (IPv4/IPv6)",
        sessionId: "string",
        authenticatedAt: "string (ISO8601 UTC)",
        mfaVerified: "boolean (optional)",
      },
      consumers: [
        {
          consumer: "observability-service",
          handlerMethod: "onUserAuthenticated",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 3,
              backoffStrategy: "exponential",
              initialIntervalMs: 500,
              maxIntervalMs: 4000,
              jitter: true,
            },
            deadLetterQueue: "dlq.observability.auth_events",
            circuitBreaker: {
              failureThreshold: 5,
              recoveryTimeoutMs: 30000,
              fallbackAction: "drop-with-alert",
            },
            allowedFallback: "drop-with-alert",
          },
        },
        {
          consumer: "notifications-service",
          handlerMethod: "checkNewLoginAlert",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 3,
              backoffStrategy: "exponential",
              initialIntervalMs: 1000,
              maxIntervalMs: 8000,
              jitter: true,
            },
            deadLetterQueue: "dlq.notifications.login_alerts",
            circuitBreaker: {
              failureThreshold: 5,
              recoveryTimeoutMs: 60000,
              fallbackAction: "queue-offline",
            },
            allowedFallback: "queue-offline",
          },
        },
      ],
      operationalEdgeCases: {
        idempotencyKeyField: "sessionId",
        deduplicationTtlSecs: 86400,
        outOfOrderHandling:
          "Ignore event if local last-login timestamp exceeds event authenticatedAt.",
        clockDriftToleranceSecs: 30,
        partitionToleranceStrategy:
          "Log locally in auth buffer and drain to event bus once connectivity restores.",
      },
      rollbackAndRecovery: {
        rollbackTrigger:
          "Compromised credential identified or session revoked immediately after issuance.",
        stateCompensationAction:
          "Publish auth.session.revoked and invalidate active Redis token cache.",
        manualRecoveryRunbook:
          "docs/OPERATIONAL_RUNBOOK.md#auth-session-lockout",
      },
    },
    {
      eventName: "auth.security.lockout",
      description:
        "Triggered when abuse detection or brute force limits trip account lockout.",
      producer: "auth-service",
      transport: "event-emitter",
      versioning: {
        schemaVersion: "1.0.0",
        evolutionRule: "strict-minor-additive",
        backwardCompatible: true,
        forwardCompatible: true,
        deprecationGracePeriodDays: 90,
      },
      requiredFields: [
        "userId",
        "lockoutReason",
        "lockoutDurationMinutes",
        "triggeredByIp",
        "lockedAt",
      ],
      payloadSchema: {
        userId: "string (UUID v4)",
        lockoutReason: "string",
        lockoutDurationMinutes: "number",
        triggeredByIp: "string",
        lockedAt: "string (ISO8601 UTC)",
        failedAttempts: "number (optional)",
      },
      consumers: [
        {
          consumer: "notifications-service",
          handlerMethod: "dispatchSecurityLockoutNotification",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 5,
              backoffStrategy: "exponential",
              initialIntervalMs: 1000,
              maxIntervalMs: 16000,
              jitter: true,
            },
            deadLetterQueue: "dlq.notifications.security_lockout",
            circuitBreaker: {
              failureThreshold: 3,
              recoveryTimeoutMs: 30000,
              fallbackAction: "queue-offline",
            },
            allowedFallback: "queue-offline",
          },
        },
        {
          consumer: "observability-service",
          handlerMethod: "recordSecurityThreatIncident",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 3,
              backoffStrategy: "fixed",
              initialIntervalMs: 1000,
              maxIntervalMs: 3000,
              jitter: false,
            },
            deadLetterQueue: "dlq.observability.threats",
            circuitBreaker: {
              failureThreshold: 5,
              recoveryTimeoutMs: 15000,
              fallbackAction: "drop-with-alert",
            },
            allowedFallback: "drop-with-alert",
          },
        },
      ],
      operationalEdgeCases: {
        idempotencyKeyField: "userId",
        deduplicationTtlSecs: 3600,
        outOfOrderHandling:
          "Lockout takes absolute precedence; newer lock duration extends existing lockout window.",
        clockDriftToleranceSecs: 60,
        partitionToleranceStrategy:
          "Enforce local database lock regardless of upstream notification status.",
      },
      rollbackAndRecovery: {
        rollbackTrigger:
          "False positive flag cleared by security administrator or customer support.",
        stateCompensationAction:
          "Execute POST /api/v1/auth/unlock with audit trail logging.",
        manualRecoveryRunbook:
          "docs/OPERATIONAL_RUNBOOK.md#manual-account-unlock",
      },
    },

    // -------------------------------------------------------------------------
    // Portfolio & Asset Management Integration Boundaries
    // -------------------------------------------------------------------------
    {
      eventName: "portfolio.rebalance.requested",
      description:
        "Emitted when portfolio allocation drift triggers an automated rebalance request.",
      producer: "portfolio-service",
      transport: "bull-queue",
      versioning: {
        schemaVersion: "1.0.0",
        evolutionRule: "strict-minor-additive",
        backwardCompatible: true,
        forwardCompatible: true,
        deprecationGracePeriodDays: 60,
      },
      requiredFields: [
        "portfolioId",
        "userId",
        "targetAllocations",
        "currentDriftBps",
        "requestId",
        "requestedAt",
      ],
      payloadSchema: {
        portfolioId: "string",
        userId: "string",
        targetAllocations: "Array<{ asset: string; targetPct: number }>",
        currentDriftBps: "number",
        requestId: "string",
        requestedAt: "string (ISO8601 UTC)",
        maxSlippageBps: "number (optional)",
      },
      consumers: [
        {
          consumer: "defi-adapter-service",
          handlerMethod: "executeRebalanceOrders",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 3,
              backoffStrategy: "exponential",
              initialIntervalMs: 2000,
              maxIntervalMs: 10000,
              jitter: true,
            },
            deadLetterQueue: "dlq.defi.rebalance_execution",
            circuitBreaker: {
              failureThreshold: 3,
              recoveryTimeoutMs: 60000,
              fallbackAction: "compensate-transaction",
            },
            allowedFallback: "compensate-transaction",
          },
        },
        {
          consumer: "observability-service",
          handlerMethod: "trackRebalanceLatency",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 2,
              backoffStrategy: "fixed",
              initialIntervalMs: 500,
              maxIntervalMs: 1000,
              jitter: false,
            },
            deadLetterQueue: "dlq.observability.portfolio_metrics",
            circuitBreaker: {
              failureThreshold: 5,
              recoveryTimeoutMs: 30000,
              fallbackAction: "drop-with-alert",
            },
            allowedFallback: "drop-with-alert",
          },
        },
      ],
      operationalEdgeCases: {
        idempotencyKeyField: "requestId",
        deduplicationTtlSecs: 7200,
        outOfOrderHandling:
          "Reject rebalance request if a newer rebalance has already completed for portfolioId.",
        clockDriftToleranceSecs: 15,
        partitionToleranceStrategy:
          "Rebalance tasks queued in Bull persistent Redis with automatic lock expiration.",
      },
      rollbackAndRecovery: {
        rollbackTrigger:
          "Market slippage threshold exceeded or adapter liquidity failure during order batch.",
        stateCompensationAction:
          "Trigger compensatory trade reversal and restore pre-rebalance asset targets.",
        manualRecoveryRunbook:
          "docs/PORTFOLIO_INTEGRATION.md#rebalance-rollback",
      },
    },
    {
      eventName: "portfolio.critical_drawdown.detected",
      description:
        "Triggered when portfolio value experiences sudden drawdown exceeding risk thresholds.",
      producer: "portfolio-service",
      transport: "event-emitter",
      versioning: {
        schemaVersion: "1.0.0",
        evolutionRule: "strict-minor-additive",
        backwardCompatible: true,
        forwardCompatible: true,
        deprecationGracePeriodDays: 60,
      },
      requiredFields: [
        "portfolioId",
        "userId",
        "drawdownPct",
        "previousValueUsd",
        "currentValueUsd",
        "detectedAt",
      ],
      payloadSchema: {
        portfolioId: "string",
        userId: "string",
        drawdownPct: "number",
        previousValueUsd: "number",
        currentValueUsd: "number",
        detectedAt: "string (ISO8601 UTC)",
        atRiskAssets: "Array<string> (optional)",
      },
      consumers: [
        {
          consumer: "notifications-service",
          handlerMethod: "sendUrgentDrawdownAlert",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 4,
              backoffStrategy: "exponential",
              initialIntervalMs: 500,
              maxIntervalMs: 8000,
              jitter: true,
            },
            deadLetterQueue: "dlq.notifications.urgent_alerts",
            circuitBreaker: {
              failureThreshold: 3,
              recoveryTimeoutMs: 30000,
              fallbackAction: "queue-offline",
            },
            allowedFallback: "queue-offline",
          },
        },
        {
          consumer: "defi-adapter-service",
          handlerMethod: "evaluateCollateralProtection",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 3,
              backoffStrategy: "exponential",
              initialIntervalMs: 1000,
              maxIntervalMs: 5000,
              jitter: true,
            },
            deadLetterQueue: "dlq.defi.collateral_protection",
            circuitBreaker: {
              failureThreshold: 2,
              recoveryTimeoutMs: 45000,
              fallbackAction: "degrade-gracefully",
            },
            allowedFallback: "degrade-gracefully",
          },
        },
      ],
      operationalEdgeCases: {
        idempotencyKeyField: "portfolioId",
        deduplicationTtlSecs: 900,
        outOfOrderHandling:
          "Process highest drawdown percentage within sliding 15-minute evaluation window.",
        clockDriftToleranceSecs: 30,
        partitionToleranceStrategy:
          "Send SMS/Push and push to persistent recovery queue simultaneously.",
      },
      rollbackAndRecovery: {
        rollbackTrigger:
          "Oracle mispricing or stale market data identified as root cause.",
        stateCompensationAction:
          "Issue portfolio recalculation event with corrected oracle snapshot.",
        manualRecoveryRunbook:
          "docs/PORTFOLIO_OPTIMIZATION.md#drawdown-recovery",
      },
    },

    // -------------------------------------------------------------------------
    // DeFi Protocol Adapters Integration Boundaries
    // -------------------------------------------------------------------------
    {
      eventName: "defi.adapter.circuit_breaker_tripped",
      description:
        "Emitted when a DeFi protocol adapter detects anomalous pool liquidity, RPC errors, or depeg.",
      producer: "defi-adapter-service",
      transport: "event-emitter",
      versioning: {
        schemaVersion: "1.0.0",
        evolutionRule: "strict-minor-additive",
        backwardCompatible: true,
        forwardCompatible: true,
        deprecationGracePeriodDays: 90,
      },
      requiredFields: [
        "protocol",
        "reason",
        "affectedPools",
        "trippedAt",
        "incidentId",
      ],
      payloadSchema: {
        protocol: "string (aave | compound | blend)",
        reason: "string",
        affectedPools: "Array<string>",
        trippedAt: "string (ISO8601 UTC)",
        incidentId: "string",
        rpcEndpoint: "string (optional)",
      },
      consumers: [
        {
          consumer: "portfolio-service",
          handlerMethod: "pauseProtocolInteractions",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 5,
              backoffStrategy: "exponential",
              initialIntervalMs: 500,
              maxIntervalMs: 5000,
              jitter: true,
            },
            deadLetterQueue: "dlq.portfolio.circuit_breaker",
            circuitBreaker: {
              failureThreshold: 2,
              recoveryTimeoutMs: 60000,
              fallbackAction: "degrade-gracefully",
            },
            allowedFallback: "degrade-gracefully",
          },
        },
        {
          consumer: "observability-service",
          handlerMethod: "raiseDefiIncidentAlert",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 3,
              backoffStrategy: "fixed",
              initialIntervalMs: 1000,
              maxIntervalMs: 3000,
              jitter: false,
            },
            deadLetterQueue: "dlq.observability.incidents",
            circuitBreaker: {
              failureThreshold: 5,
              recoveryTimeoutMs: 30000,
              fallbackAction: "drop-with-alert",
            },
            allowedFallback: "drop-with-alert",
          },
        },
      ],
      operationalEdgeCases: {
        idempotencyKeyField: "incidentId",
        deduplicationTtlSecs: 86400,
        outOfOrderHandling:
          "Circuit breaker trip state remains latched until explicit operator reset event.",
        clockDriftToleranceSecs: 15,
        partitionToleranceStrategy:
          "Fail-safe default: when adapter partition occurs, assume open circuit and reject trades.",
      },
      rollbackAndRecovery: {
        rollbackTrigger:
          "Protocol upstream health restored and liquidity verification passes sanity checks.",
        stateCompensationAction:
          "Emit defi.adapter.circuit_breaker_reset and resume interaction queue.",
        manualRecoveryRunbook:
          "docs/INCIDENT_DRILL_RUNBOOK.md#defi-circuit-breaker",
      },
    },
    {
      eventName: "defi.liquidity.supplied",
      description:
        "Emitted upon successful deposit/mint into a supported lending or yield protocol.",
      producer: "defi-adapter-service",
      transport: "event-emitter",
      versioning: {
        schemaVersion: "1.0.0",
        evolutionRule: "strict-minor-additive",
        backwardCompatible: true,
        forwardCompatible: true,
        deprecationGracePeriodDays: 90,
      },
      requiredFields: [
        "protocol",
        "asset",
        "amount",
        "sharesReceived",
        "txHash",
        "userId",
        "completedAt",
      ],
      payloadSchema: {
        protocol: "string",
        asset: "string",
        amount: "string (BigNumber string)",
        sharesReceived: "string (BigNumber string)",
        txHash: "string (Stellar or EVM tx hash)",
        userId: "string",
        completedAt: "string (ISO8601 UTC)",
        effectiveApy: "number (optional)",
      },
      consumers: [
        {
          consumer: "portfolio-service",
          handlerMethod: "recordSuppliedPosition",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 3,
              backoffStrategy: "exponential",
              initialIntervalMs: 1000,
              maxIntervalMs: 6000,
              jitter: true,
            },
            deadLetterQueue: "dlq.portfolio.position_updates",
            circuitBreaker: {
              failureThreshold: 4,
              recoveryTimeoutMs: 45000,
              fallbackAction: "compensate-transaction",
            },
            allowedFallback: "compensate-transaction",
          },
        },
        {
          consumer: "observability-service",
          handlerMethod: "recordTvlGrowth",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 2,
              backoffStrategy: "fixed",
              initialIntervalMs: 500,
              maxIntervalMs: 1000,
              jitter: false,
            },
            deadLetterQueue: "dlq.observability.tvl",
            circuitBreaker: {
              failureThreshold: 5,
              recoveryTimeoutMs: 30000,
              fallbackAction: "drop-with-alert",
            },
            allowedFallback: "drop-with-alert",
          },
        },
      ],
      operationalEdgeCases: {
        idempotencyKeyField: "txHash",
        deduplicationTtlSecs: 604800,
        outOfOrderHandling:
          "Ledger sequence and transaction hash guarantee single-application position update.",
        clockDriftToleranceSecs: 60,
        partitionToleranceStrategy:
          "Reconcile on-chain ledger state against local DB on consumer recovery.",
      },
      rollbackAndRecovery: {
        rollbackTrigger:
          "On-chain transaction reverted or unconfirmed during block reorganization.",
        stateCompensationAction:
          "Remove pending position and mark operation failed with retry option.",
        manualRecoveryRunbook:
          "docs/OPERATIONAL_RUNBOOK.md#defi-tx-reconciliation",
      },
    },

    // -------------------------------------------------------------------------
    // Notifications Integration Boundaries
    // -------------------------------------------------------------------------
    {
      eventName: "notifications.dispatch.failed",
      description:
        "Emitted when a customer notification channel (email, push, webhook) permanently exhausts retries.",
      producer: "notifications-service",
      transport: "event-emitter",
      versioning: {
        schemaVersion: "1.0.0",
        evolutionRule: "strict-minor-additive",
        backwardCompatible: true,
        forwardCompatible: true,
        deprecationGracePeriodDays: 90,
      },
      requiredFields: [
        "notificationId",
        "userId",
        "channel",
        "failureReason",
        "failedAt",
      ],
      payloadSchema: {
        notificationId: "string",
        userId: "string",
        channel: "string (email | push | webhook | sms)",
        failureReason: "string",
        failedAt: "string (ISO8601 UTC)",
        retryCount: "number (optional)",
      },
      consumers: [
        {
          consumer: "observability-service",
          handlerMethod: "trackNotificationDropRate",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 2,
              backoffStrategy: "fixed",
              initialIntervalMs: 500,
              maxIntervalMs: 1000,
              jitter: false,
            },
            deadLetterQueue: "dlq.observability.notification_drops",
            circuitBreaker: {
              failureThreshold: 5,
              recoveryTimeoutMs: 30000,
              fallbackAction: "drop-with-alert",
            },
            allowedFallback: "drop-with-alert",
          },
        },
      ],
      operationalEdgeCases: {
        idempotencyKeyField: "notificationId",
        deduplicationTtlSecs: 86400,
        outOfOrderHandling:
          "Notification failure terminal state prevents duplicate dispatch attempts.",
        clockDriftToleranceSecs: 60,
        partitionToleranceStrategy:
          "Store failed notification in local dead-letter table for inspection.",
      },
      rollbackAndRecovery: {
        rollbackTrigger:
          "Provider outage resolved (e.g. SendGrid or Twilio webhook recovery).",
        stateCompensationAction:
          "Execute replay script: scripts/replay-failed-notifications.ts.",
        manualRecoveryRunbook:
          "docs/NOTIFICATION_PREFERENCE_ROUTING.md#provider-failover",
      },
    },

    // -------------------------------------------------------------------------
    // Observability & Telemetry Integration Boundaries
    // -------------------------------------------------------------------------
    {
      eventName: "observability.health.state_changed",
      description:
        "Emitted when a platform component health status transitions (e.g. healthy -> degraded).",
      producer: "observability-service",
      transport: "event-emitter",
      versioning: {
        schemaVersion: "1.0.0",
        evolutionRule: "strict-minor-additive",
        backwardCompatible: true,
        forwardCompatible: true,
        deprecationGracePeriodDays: 90,
      },
      requiredFields: [
        "component",
        "previousStatus",
        "currentStatus",
        "transitionReason",
        "timestamp",
      ],
      payloadSchema: {
        component: "string",
        previousStatus: "string (healthy | degraded | down)",
        currentStatus: "string (healthy | degraded | down)",
        transitionReason: "string",
        timestamp: "string (ISO8601 UTC)",
        incidentId: "string (optional)",
      },
      consumers: [
        {
          consumer: "notifications-service",
          handlerMethod: "broadcastStatusBanner",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 3,
              backoffStrategy: "exponential",
              initialIntervalMs: 1000,
              maxIntervalMs: 5000,
              jitter: true,
            },
            deadLetterQueue: "dlq.notifications.status_updates",
            circuitBreaker: {
              failureThreshold: 3,
              recoveryTimeoutMs: 30000,
              fallbackAction: "degrade-gracefully",
            },
            allowedFallback: "degrade-gracefully",
          },
        },
      ],
      operationalEdgeCases: {
        idempotencyKeyField: "component",
        deduplicationTtlSecs: 300,
        outOfOrderHandling:
          "Apply transitions only if timestamp is strictly newer than current component state.",
        clockDriftToleranceSecs: 15,
        partitionToleranceStrategy:
          "Cache latest status locally in-memory with fallback to default status.",
      },
      rollbackAndRecovery: {
        rollbackTrigger: "Flapping health monitor detects transient spike.",
        stateCompensationAction:
          "Enforce hysteresis window before declaring permanent degraded status.",
        manualRecoveryRunbook:
          "docs/PUBLIC_STATUS_MODEL.md#status-state-machine",
      },
    },

    // -------------------------------------------------------------------------
    // Settlement & Stellar Blockchain Integration Boundaries
    // -------------------------------------------------------------------------
    {
      eventName: "settlement.reconciliation.drift_detected",
      description:
        "Emitted when ledger reconciliation identifies a balance discrepancy between DB and chain.",
      producer: "settlement-service",
      transport: "event-emitter",
      versioning: {
        schemaVersion: "1.0.0",
        evolutionRule: "strict-minor-additive",
        backwardCompatible: true,
        forwardCompatible: true,
        deprecationGracePeriodDays: 60,
      },
      requiredFields: [
        "reconciliationId",
        "asset",
        "expectedBalance",
        "actualBalance",
        "driftAmount",
        "detectedAt",
      ],
      payloadSchema: {
        reconciliationId: "string",
        asset: "string",
        expectedBalance: "string",
        actualBalance: "string",
        driftAmount: "string",
        detectedAt: "string (ISO8601 UTC)",
        affectedWallets: "Array<string> (optional)",
      },
      consumers: [
        {
          consumer: "portfolio-service",
          handlerMethod: "quarantineAffectedPositions",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 5,
              backoffStrategy: "exponential",
              initialIntervalMs: 500,
              maxIntervalMs: 8000,
              jitter: true,
            },
            deadLetterQueue: "dlq.portfolio.drift_quarantine",
            circuitBreaker: {
              failureThreshold: 2,
              recoveryTimeoutMs: 60000,
              fallbackAction: "compensate-transaction",
            },
            allowedFallback: "compensate-transaction",
          },
        },
        {
          consumer: "observability-service",
          handlerMethod: "alertOnReconciliationFailure",
          consumerVersion: "^1.0.0",
          failureBehavior: {
            retryPolicy: {
              maxRetries: 3,
              backoffStrategy: "fixed",
              initialIntervalMs: 1000,
              maxIntervalMs: 3000,
              jitter: false,
            },
            deadLetterQueue: "dlq.observability.reconciliation",
            circuitBreaker: {
              failureThreshold: 3,
              recoveryTimeoutMs: 30000,
              fallbackAction: "drop-with-alert",
            },
            allowedFallback: "drop-with-alert",
          },
        },
      ],
      operationalEdgeCases: {
        idempotencyKeyField: "reconciliationId",
        deduplicationTtlSecs: 86400,
        outOfOrderHandling:
          "Quarantine lock persists until an explicit reconciliation approval event is signed.",
        clockDriftToleranceSecs: 30,
        partitionToleranceStrategy:
          "Immediately halt automated outbound settlement while drift is unresolved.",
      },
      rollbackAndRecovery: {
        rollbackTrigger:
          "Operator executes compensating ledger adjustment or proves chain reorganization.",
        stateCompensationAction:
          "Execute ledger reconciliation repair job: scripts/reconciliation-repair.ts.",
        manualRecoveryRunbook:
          "docs/stellar-reconciliation.md#drift-resolution",
      },
    },
  ];

export class CrossServiceContractRegistry {
  private static readonly definitions: Map<
    string,
    DomainEventContractDefinition
  > = new Map(
    CROSS_SERVICE_EVENT_DEFINITIONS.map((def) => [def.eventName, def]),
  );

  /**
   * Returns all registered cross-service event contract definitions.
   */
  public static getAllContracts(): DomainEventContractDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Retrieves an integration contract definition by event name.
   */
  public static getContract(
    eventName: string,
  ): DomainEventContractDefinition | undefined {
    return this.definitions.get(eventName);
  }

  /**
   * Validates a runtime domain event envelope against the contract definition.
   */
  public static validateEventEnvelope(
    envelope: DomainEventEnvelope,
  ): ValidationResult {
    const errors: string[] = [];

    if (!envelope.eventId) {
      errors.push("Missing envelope.eventId");
    }
    if (!envelope.eventName) {
      errors.push("Missing envelope.eventName");
    }
    if (!envelope.schemaVersion) {
      errors.push("Missing envelope.schemaVersion");
    }
    if (!envelope.producer) {
      errors.push("Missing envelope.producer");
    }
    if (!envelope.timestamp) {
      errors.push("Missing envelope.timestamp");
    }
    if (!envelope.correlationId) {
      errors.push("Missing envelope.correlationId");
    }

    const contract = this.definitions.get(envelope.eventName);
    if (!contract) {
      errors.push(`Unknown domain event name: '${envelope.eventName}'`);
      return { isValid: false, errors };
    }

    if (contract.producer !== envelope.producer) {
      errors.push(
        `Producer mismatch for event '${envelope.eventName}': expected '${contract.producer}', received '${envelope.producer}'`,
      );
    }

    if (
      envelope.payload === undefined ||
      envelope.payload === null ||
      typeof envelope.payload !== "object"
    ) {
      errors.push(
        `Payload must be a valid non-null object for event '${envelope.eventName}'`,
      );
      return { isValid: false, errors };
    }

    for (const requiredField of contract.requiredFields) {
      const val = envelope.payload[requiredField];
      if (val === undefined || val === null || val === "") {
        errors.push(
          `Missing required field '${requiredField}' in payload for event '${envelope.eventName}'`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Returns all unique producer services registered in the contract map.
   */
  public static getProducers(): ServiceIdentifier[] {
    const producers = new Set<ServiceIdentifier>();
    for (const def of this.definitions.values()) {
      producers.add(def.producer);
    }
    return Array.from(producers);
  }

  /**
   * Returns all consumers for a given domain event.
   */
  public static getConsumers(eventName: string): ConsumerContract[] {
    return this.definitions.get(eventName)?.consumers ?? [];
  }

  /**
   * Returns all integration boundary edges (from -> to).
   */
  public static getIntegrationBoundaries(): {
    from: ServiceIdentifier;
    to: ServiceIdentifier;
    eventName: string;
  }[] {
    const boundaries: {
      from: ServiceIdentifier;
      to: ServiceIdentifier;
      eventName: string;
    }[] = [];
    for (const def of this.definitions.values()) {
      for (const consumer of def.consumers) {
        boundaries.push({
          from: def.producer,
          to: consumer.consumer,
          eventName: def.eventName,
        });
      }
    }
    return boundaries;
  }
}

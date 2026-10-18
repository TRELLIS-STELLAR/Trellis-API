/**
 * @file cross-service-contract-map.spec.ts
 *
 * Automated verification and contract invariant tests for cross-service domain event contracts (issue #227).
 */

import {
  CrossServiceContractRegistry,
  CROSS_SERVICE_EVENT_DEFINITIONS,
} from "./cross-service-contract-map.registry";
import { DomainEventEnvelope } from "./cross-service-contract-map.types";

function isValidSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}

describe("Cross-Service Contract Map & Integration Boundaries (issue #227)", () => {
  describe("Coverage & Service Topology", () => {
    it("registers integration contracts for all major Trellis core domains", () => {
      const contracts = CrossServiceContractRegistry.getAllContracts();
      expect(contracts.length).toBeGreaterThanOrEqual(7);

      const producers = CrossServiceContractRegistry.getProducers();
      expect(producers).toContain("auth-service");
      expect(producers).toContain("portfolio-service");
      expect(producers).toContain("defi-adapter-service");
      expect(producers).toContain("notifications-service");
      expect(producers).toContain("observability-service");
      expect(producers).toContain("settlement-service");
    });

    it("verifies integration boundaries connect producers to valid consumers", () => {
      const boundaries =
        CrossServiceContractRegistry.getIntegrationBoundaries();
      expect(boundaries.length).toBeGreaterThan(0);

      for (const boundary of boundaries) {
        expect(boundary.from).toBeDefined();
        expect(boundary.to).toBeDefined();
        expect(boundary.eventName).toBeDefined();
        expect(boundary.from).not.toEqual(boundary.to);
      }
    });
  });

  describe("Versioning & Evolution Rules", () => {
    it("enforces semver compliance for all domain event schema versions", () => {
      for (const def of CROSS_SERVICE_EVENT_DEFINITIONS) {
        expect(isValidSemver(def.versioning.schemaVersion)).toBe(true);
        expect(["strict-minor-additive", "major-breaking-migration"]).toContain(
          def.versioning.evolutionRule,
        );
        expect(typeof def.versioning.backwardCompatible).toBe("boolean");
        expect(typeof def.versioning.forwardCompatible).toBe("boolean");
        expect(
          def.versioning.deprecationGracePeriodDays,
        ).toBeGreaterThanOrEqual(30);
      }
    });
  });

  describe("Payload Schema & Required Fields Invariants", () => {
    it("ensures each contract defines explicit required fields and wire schema", () => {
      for (const def of CROSS_SERVICE_EVENT_DEFINITIONS) {
        expect(def.requiredFields.length).toBeGreaterThan(0);
        expect(Object.keys(def.payloadSchema).length).toBeGreaterThanOrEqual(
          def.requiredFields.length,
        );

        for (const reqField of def.requiredFields) {
          expect(def.payloadSchema[reqField]).toBeDefined();
        }
      }
    });

    it("validates a compliant envelope successfully", () => {
      const sampleEnvelope: DomainEventEnvelope = {
        eventId: "evt-test-100",
        eventName: "auth.user.authenticated",
        schemaVersion: "1.0.0",
        producer: "auth-service",
        timestamp: new Date().toISOString(),
        correlationId: "corr-test-100",
        payload: {
          userId: "usr-123",
          authMethod: "password",
          ipAddress: "127.0.0.1",
          sessionId: "sess-abc",
          authenticatedAt: new Date().toISOString(),
        },
      };

      const result =
        CrossServiceContractRegistry.validateEventEnvelope(sampleEnvelope);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects an envelope missing required payload fields", () => {
      const invalidEnvelope: DomainEventEnvelope = {
        eventId: "evt-test-101",
        eventName: "auth.user.authenticated",
        schemaVersion: "1.0.0",
        producer: "auth-service",
        timestamp: new Date().toISOString(),
        correlationId: "corr-test-101",
        payload: {
          userId: "usr-123",
          // missing authMethod, ipAddress, sessionId, authenticatedAt
        },
      };

      const result =
        CrossServiceContractRegistry.validateEventEnvelope(invalidEnvelope);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(
        result.errors.some((e) => e.includes("Missing required field")),
      ).toBe(true);
    });

    it("rejects an envelope with a producer mismatch", () => {
      const mismatchedEnvelope: DomainEventEnvelope = {
        eventId: "evt-test-102",
        eventName: "portfolio.rebalance.requested",
        schemaVersion: "1.0.0",
        producer: "notifications-service", // Should be portfolio-service
        timestamp: new Date().toISOString(),
        correlationId: "corr-test-102",
        payload: {
          portfolioId: "port-1",
          userId: "u-1",
          targetAllocations: [],
          currentDriftBps: 250,
          requestId: "req-1",
          requestedAt: new Date().toISOString(),
        },
      };

      const result =
        CrossServiceContractRegistry.validateEventEnvelope(mismatchedEnvelope);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes("Producer mismatch"))).toBe(
        true,
      );
    });

    it("rejects an unknown event name", () => {
      const unknownEnvelope: DomainEventEnvelope = {
        eventId: "evt-test-103",
        eventName: "unknown.nonexistent.event",
        schemaVersion: "1.0.0",
        producer: "auth-service",
        timestamp: new Date().toISOString(),
        correlationId: "corr-test-103",
        payload: {},
      };

      const result =
        CrossServiceContractRegistry.validateEventEnvelope(unknownEnvelope);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("Unknown domain event name")),
      ).toBe(true);
    });
  });

  describe("Failure Policies & Operational Resilience", () => {
    it("defines retry policies, DLQs, and circuit breakers for all consumers", () => {
      for (const def of CROSS_SERVICE_EVENT_DEFINITIONS) {
        expect(def.consumers.length).toBeGreaterThan(0);

        for (const consumer of def.consumers) {
          const {
            retryPolicy,
            deadLetterQueue,
            circuitBreaker,
            allowedFallback,
          } = consumer.failureBehavior;

          expect(retryPolicy.maxRetries).toBeGreaterThan(0);
          expect(["exponential", "linear", "fixed"]).toContain(
            retryPolicy.backoffStrategy,
          );
          expect(retryPolicy.initialIntervalMs).toBeGreaterThan(0);
          expect(retryPolicy.maxIntervalMs).toBeGreaterThanOrEqual(
            retryPolicy.initialIntervalMs,
          );

          expect(deadLetterQueue).toMatch(/^dlq\.[a-z_]+\.[a-z_]+$/);

          expect(circuitBreaker.failureThreshold).toBeGreaterThan(0);
          expect(circuitBreaker.recoveryTimeoutMs).toBeGreaterThanOrEqual(
            15000,
          );

          expect([
            "drop-with-alert",
            "queue-offline",
            "degrade-gracefully",
            "compensate-transaction",
          ]).toContain(allowedFallback);
        }
      }
    });
  });

  describe("Operational Edge Cases & Rollback/Recovery Runbooks", () => {
    it("defines idempotency, clock drift tolerances, and rollback compensation for every boundary", () => {
      for (const def of CROSS_SERVICE_EVENT_DEFINITIONS) {
        const { operationalEdgeCases, rollbackAndRecovery } = def;

        expect(operationalEdgeCases.idempotencyKeyField).toBeDefined();
        expect(
          operationalEdgeCases.deduplicationTtlSecs,
        ).toBeGreaterThanOrEqual(300);
        expect(operationalEdgeCases.clockDriftToleranceSecs).toBeGreaterThan(0);
        expect(operationalEdgeCases.outOfOrderHandling.length).toBeGreaterThan(
          10,
        );
        expect(
          operationalEdgeCases.partitionToleranceStrategy.length,
        ).toBeGreaterThan(10);

        expect(rollbackAndRecovery.rollbackTrigger.length).toBeGreaterThan(10);
        expect(
          rollbackAndRecovery.stateCompensationAction.length,
        ).toBeGreaterThan(10);
        expect(rollbackAndRecovery.manualRecoveryRunbook).toMatch(
          /^docs\/.*\.md#/,
        );
      }
    });
  });
});

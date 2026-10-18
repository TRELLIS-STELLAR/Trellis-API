import { FailureFixtureGenerator } from "./failure-fixture-generator";

describe("FailureFixtureGenerator", () => {
  describe("Stellar Blockchain Fixtures", () => {
    it("should generate a ledger reorganization fixture with orphaned transactions", () => {
      const fixture = FailureFixtureGenerator.generateLedgerReorg(50000000, 4);

      expect(fixture.originalLedgerSequence).toBe(50000000);
      expect(fixture.reorgDepth).toBe(4);
      expect(fixture.forkedLedgerSequence).toBe(49999997);
      expect(fixture.orphanedTransactions).toHaveLength(4);
      expect(fixture.originalBlockHash).toMatch(/^[a-f0-9]{64}$/);
      expect(fixture.newBlockHash).toMatch(/^[a-f0-9]{64}$/);
      expect(fixture.originalBlockHash).not.toBe(fixture.newBlockHash);
    });

    it("should generate a sequence/nonce collision fixture", () => {
      const fixture = FailureFixtureGenerator.generateNonceCollision(
        "GACC12345",
        "99887766",
      );

      expect(fixture.accountId).toBe("GACC12345");
      expect(fixture.conflictingSequence).toBe("99887766");
      expect(fixture.transactions).toHaveLength(2);
      expect(fixture.transactions[0].status).toBe("FIRST_ACCEPTED");
      expect(fixture.transactions[1].status).toBe("COLLIDED_BAD_SEQ");
    });

    it("should generate diverse malformed XDR scenarios", () => {
      const truncated = FailureFixtureGenerator.generateMalformedXdr("TRUNCATED_XDR");
      expect(truncated.scenario).toBe("TRUNCATED_XDR");
      expect(truncated.expectedErrorCode).toBe("INVALID_TRANSACTION_ENVELOPE");

      const invalidBase64 = FailureFixtureGenerator.generateMalformedXdr("INVALID_BASE64");
      expect(invalidBase64.remediationHint).toContain("base64");

      const passphrase = FailureFixtureGenerator.generateMalformedXdr("MISMATCHED_NETWORK_PASSPHRASE");
      expect(passphrase.expectedErrorCode).toBe("STELLAR_NETWORK_ERROR");

      const sig = FailureFixtureGenerator.generateMalformedXdr("CORRUPTED_SIGNATURE");
      expect(sig.expectedErrorCode).toBe("ORACLE_VERIFICATION_FAILED");
    });
  });

  describe("Persistence & Distributed Failure Fixtures", () => {
    it("should generate partial commit fixture with compensation actions", () => {
      const fixture = FailureFixtureGenerator.generatePartialCommit("tx-deadlock-99");

      expect(fixture.transactionId).toBe("tx-deadlock-99");
      expect(fixture.committedEntities).toHaveLength(1);
      expect(fixture.failedEntities).toHaveLength(1);
      expect(fixture.requiresCompensation).toBe(true);
      expect(fixture.compensationInstructions.length).toBeGreaterThan(0);
    });

    it("should generate dead letter queue spill fixture", () => {
      const fixture = FailureFixtureGenerator.generateDeadLetterSpill("webhook.payment", 5);

      expect(fixture.topic).toBe("webhook.payment");
      expect(fixture.attemptsMade).toBe(5);
      expect(fixture.dlqRoutingKey).toBe("dlq.webhook.payment");
      expect(fixture.lastFailureReason).toContain("503");
    });

    it("should generate tampered audit trail fixture detecting broken hash chain", () => {
      const fixture = FailureFixtureGenerator.generateTamperedAuditChain("chain-audit-2026");

      expect(fixture.chainId).toBe("chain-audit-2026");
      expect(fixture.tamperedEntryIndex).toBe(17);
      expect(fixture.originalHash).not.toBe(fixture.computedHash);
      expect(fixture.tamperedPayload.tamperedAmount).toBeGreaterThan(
        Number(fixture.tamperedPayload.originalAmount),
      );
    });
  });
});

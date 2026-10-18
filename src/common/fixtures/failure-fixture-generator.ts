import { createHash } from "crypto";

export interface LedgerReorganizationFixture {
  originalLedgerSequence: number;
  originalBlockHash: string;
  reorgDepth: number;
  forkedLedgerSequence: number;
  newBlockHash: string;
  orphanedTransactions: Array<{
    txHash: string;
    sourceAccount: string;
    sequenceNumber: string;
    feePaidStroops: number;
  }>;
}

export interface NonceSequenceCollisionFixture {
  accountId: string;
  conflictingSequence: string;
  transactions: Array<{
    txId: string;
    submittedAt: string;
    clientIdentifier: string;
    status: "FIRST_ACCEPTED" | "COLLIDED_BAD_SEQ";
  }>;
}

export interface MalformedXdrFixture {
  scenario: "TRUNCATED_XDR" | "INVALID_BASE64" | "MISMATCHED_NETWORK_PASSPHRASE" | "CORRUPTED_SIGNATURE";
  rawEnvelopeXdr: string;
  expectedErrorCode: string;
  remediationHint: string;
}

export interface PartialCommitFixture {
  transactionId: string;
  committedEntities: Array<{ table: string; id: string; committedAt: string }>;
  failedEntities: Array<{ table: string; error: string }>;
  requiresCompensation: boolean;
  compensationInstructions: string[];
}

export interface DeadLetterSpillFixture {
  eventId: string;
  topic: string;
  attemptsMade: number;
  maxRetriesAllowed: number;
  exhaustionTimestamp: string;
  lastFailureReason: string;
  payload: Record<string, unknown>;
  dlqRoutingKey: string;
}

export interface TamperedAuditChainFixture {
  chainId: string;
  totalEntries: number;
  tamperedEntryIndex: number;
  originalHash: string;
  computedHash: string;
  tamperedPayload: Record<string, unknown>;
  detectionAlgorithm: "SHA256_CHAIN_HEAD_VERIFY";
}

export class FailureFixtureGenerator {
  /**
   * Generates a deterministic ledger reorganization fixture.
   */
  static generateLedgerReorg(
    startSequence = 48500000,
    depth = 3,
  ): LedgerReorganizationFixture {
    const originalHash = createHash("sha256")
      .update(`ledger:${startSequence}:main`)
      .digest("hex");
    const newHash = createHash("sha256")
      .update(`ledger:${startSequence - depth + 1}:reorg_branch`)
      .digest("hex");

    const orphanedTransactions = [];
    for (let i = 0; i < depth; i++) {
      const seq = (startSequence - i).toString();
      orphanedTransactions.push({
        txHash: createHash("sha256").update(`orphaned:${seq}`).digest("hex"),
        sourceAccount: `G_ORPHAN_ACCOUNT_${i}_PUBLIC_KEY`,
        sequenceNumber: seq,
        feePaidStroops: 100,
      });
    }

    return {
      originalLedgerSequence: startSequence,
      originalBlockHash: originalHash,
      reorgDepth: depth,
      forkedLedgerSequence: startSequence - depth + 1,
      newBlockHash: newHash,
      orphanedTransactions,
    };
  }

  /**
   * Generates a nonce/sequence collision fixture.
   */
  static generateNonceCollision(
    accountId = "GA5ZSEJYB37JKNXG2CWUA5BKWJN3ELK24ITV6WQ6M2",
    sequence = "1284759283749",
  ): NonceSequenceCollisionFixture {
    return {
      accountId,
      conflictingSequence: sequence,
      transactions: [
        {
          txId: "tx_first_arrival_win",
          submittedAt: "2026-10-18T10:00:00.100Z",
          clientIdentifier: "worker-pool-node-1",
          status: "FIRST_ACCEPTED",
        },
        {
          txId: "tx_second_collision_fail",
          submittedAt: "2026-10-18T10:00:00.115Z",
          clientIdentifier: "worker-pool-node-2",
          status: "COLLIDED_BAD_SEQ",
        },
      ],
    };
  }

  /**
   * Generates malformed XDR failure fixtures for edge case parser testing.
   */
  static generateMalformedXdr(
    scenario: MalformedXdrFixture["scenario"],
  ): MalformedXdrFixture {
    switch (scenario) {
      case "TRUNCATED_XDR":
        return {
          scenario,
          rawEnvelopeXdr: "AAAAAGX8J2P84d2m9==", // cut off prematurely
          expectedErrorCode: "INVALID_TRANSACTION_ENVELOPE",
          remediationHint: "Ensure XDR payload is not truncated by network boundary.",
        };
      case "INVALID_BASE64":
        return {
          scenario,
          rawEnvelopeXdr: "!!!NOT_VALID_BASE64@@@$$$",
          expectedErrorCode: "INVALID_TRANSACTION_ENVELOPE",
          remediationHint: "Payload must be strictly base64 encoded.",
        };
      case "MISMATCHED_NETWORK_PASSPHRASE":
        return {
          scenario,
          rawEnvelopeXdr: "AAAAAGX8J2P84d2m89v7x2k1l...",
          expectedErrorCode: "STELLAR_NETWORK_ERROR",
          remediationHint: "Hash was signed against Testnet passphrase instead of Public.",
        };
      case "CORRUPTED_SIGNATURE":
        return {
          scenario,
          rawEnvelopeXdr: "AAAAAGX8J2P84d2m...",
          expectedErrorCode: "ORACLE_VERIFICATION_FAILED",
          remediationHint: "Cryptographic ED25519 signature bytes were corrupted.",
        };
    }
  }

  /**
   * Generates a partial database commit failure fixture requiring compensating transactions.
   */
  static generatePartialCommit(
    transactionId = "tx-partial-fail-001",
  ): PartialCommitFixture {
    return {
      transactionId,
      committedEntities: [
        {
          table: "reconciliation_invoices",
          id: "inv-98765",
          committedAt: new Date().toISOString(),
        },
      ],
      failedEntities: [
        {
          table: "stellar_transactions",
          error: "QueryFailedError: deadlock detected on foreign key lock",
        },
      ],
      requiresCompensation: true,
      compensationInstructions: [
        "Rollback invoice state from 'SETTLED' back to 'PENDING'",
        "Emit DeadLetter compensation event to reconciliation supervisor",
        "Release reserved asset liquidity locks in memory",
      ],
    };
  }

  /**
   * Generates a dead-letter queue spill fixture after retry exhaustion.
   */
  static generateDeadLetterSpill(
    topic = "webhook.settlement.confirmed",
    attempts = 5,
  ): DeadLetterSpillFixture {
    return {
      eventId: `evt_dlq_${Date.now()}`,
      topic,
      attemptsMade: attempts,
      maxRetriesAllowed: 5,
      exhaustionTimestamp: new Date().toISOString(),
      lastFailureReason: "HTTP 503: Service Unavailable upstream for 5 consecutive attempts",
      payload: {
        settlementId: "settle-abc-123",
        amountStroops: 50000000,
        destination: "GABCD12345",
      },
      dlqRoutingKey: `dlq.${topic}`,
    };
  }

  /**
   * Generates an audit trail anomaly fixture where a chain head link was tampered with.
   */
  static generateTamperedAuditChain(
    chainHeadId = "chain-head-treasury-2026",
  ): TamperedAuditChainFixture {
    const originalHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const computedHash = createHash("sha256")
      .update('{"tampered":true,"authorizedAmount":99999999}')
      .digest("hex");

    return {
      chainId: chainHeadId,
      totalEntries: 42,
      tamperedEntryIndex: 17,
      originalHash,
      computedHash,
      tamperedPayload: {
        action: "treasury.disburse",
        originalAmount: 1000,
        tamperedAmount: 99999999,
      },
      detectionAlgorithm: "SHA256_CHAIN_HEAD_VERIFY",
    };
  }
}

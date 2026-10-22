import { ConfigService } from "@nestjs/config";
import { Contract, Keypair, Networks, rpc, xdr } from "@stellar/stellar-sdk";
import {
  classifyLedgerEntry,
  StellarOracleAdapter,
} from "src/blockchain/oracle/services/stellar-oracle.adapter";
import { SubmissionVerifierService } from "src/blockchain/oracle/submission-verifier.service";
import { SubmissionHistoryService } from "src/blockchain/oracle/services/submission-history.service";
import { AuditLogService } from "src/infrastructure/audit/audit-log.service";
import {
  CONFIRMATION_FIXTURES,
  createLedgerSequenceFixture,
  LEDGER_FIXTURE_CONTRACT,
  LEDGER_TTL_FIXTURES,
} from "./ledger-sequence.fixtures";

jest.mock("src/observability/telemetry.service", () => ({
  telemetryService: { startTimer: () => jest.fn() },
}));

describe("deterministic ledger sequence fixtures (#346)", () => {
  const fixture = createLedgerSequenceFixture();
  let transaction: jest.SpyInstance;
  let latest: jest.SpyInstance;
  let adapter: StellarOracleAdapter;

  function configuredAdapter(minimum = 2) {
    return new StellarOracleAdapter(
      new ConfigService({
        SOROBAN_RPC_URL: "https://rpc.example.com",
        ORACLE_CONTRACT_ADDRESS: LEDGER_FIXTURE_CONTRACT,
        ORACLE_MIN_CONFIRMATIONS: minimum,
        ORACLE_RPC_MAX_RETRIES: 2,
        ORACLE_RPC_RETRY_DELAY_MS: 1,
      }),
    );
  }

  function successfulTransaction(ledger = 100) {
    return {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger,
      createdAt: 1700000000,
      envelopeXdr: fixture.transaction.toEnvelope(),
    };
  }

  beforeEach(() => {
    jest.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: Networks.TESTNET,
    } as Awaited<ReturnType<rpc.Server["getNetwork"]>>);
    transaction = jest
      .spyOn(rpc.Server.prototype, "getTransaction")
      .mockResolvedValue(
        successfulTransaction() as Awaited<
          ReturnType<rpc.Server["getTransaction"]>
        >,
      );
    latest = jest
      .spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockResolvedValue({ sequence: 101 } as Awaited<
        ReturnType<rpc.Server["getLatestLedger"]>
      >);
    adapter = configuredAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("recreates identical XDR and hashes independently of wall clock and randomness", () => {
    jest.spyOn(Date, "now").mockReturnValue(2000000000000);
    jest.spyOn(Keypair, "random").mockImplementation(() => {
      throw new Error("random identity");
    });
    const replay = createLedgerSequenceFixture();
    expect(replay.transaction.toEnvelope().toXdr("base64")).toBe(
      fixture.transaction.toEnvelope().toXdr("base64"),
    );
    expect(replay.submission).toEqual(fixture.submission);
    expect(replay.transaction.sequence).toBe("429496729601");
  });

  it.each(CONFIRMATION_FIXTURES)(
    "$name",
    async ({ ledger, latest: head, minimum, confirmed }) => {
      transaction.mockResolvedValue(successfulTransaction(ledger));
      latest.mockResolvedValue({ sequence: head });
      const result = configuredAdapter(minimum).verify(fixture.submission);
      if (confirmed) {
        await expect(result).resolves.toEqual({
          hash: fixture.submission.payloadHash,
          timestamp: 1700000000000,
          ledger,
        });
      } else {
        await expect(result).rejects.toMatchObject({
          code: "INSUFFICIENT_CONFIRMATIONS",
          retryable: true,
        });
      }
      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );

  it.each(LEDGER_TTL_FIXTURES)(
    "$name",
    ({ latest: head, ttl, temporary, expected }) => {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Contract(LEDGER_FIXTURE_CONTRACT)
            .address()
            .toScAddress(),
          key: xdr.ScVal.scvSymbol("feed_his"),
          durability: temporary
            ? xdr.ContractDataDurability.temporary
            : xdr.ContractDataDurability.persistent,
        }),
      );
      const result = classifyLedgerEntry(
        key,
        key.toXdr("base64"),
        {
          key,
          val: {} as rpc.Api.LedgerEntryResult["val"],
          lastModifiedLedgerSeq: 1,
          liveUntilLedgerSeq: ttl,
        },
        head,
      );
      expect(result).toEqual({
        key: key.toXdr("base64"),
        state: expected,
        liveUntilLedger: ttl,
        lastModifiedLedger: 1,
      });
    },
  );

  it.each([
    [rpc.Api.GetTransactionStatus.NOT_FOUND, "TRANSACTION_NOT_FOUND", true],
    [rpc.Api.GetTransactionStatus.FAILED, "TRANSACTION_FAILED", false],
  ])(
    "handles transaction status %s before reading the head",
    async (status, code, retryable) => {
      transaction.mockResolvedValue({ status });
      await expect(adapter.verify(fixture.submission)).rejects.toMatchObject({
        code,
        retryable,
      });
      expect(latest).not.toHaveBeenCalled();
    },
  );

  it("retries a transient head read without re-reading the transaction", async () => {
    jest.useFakeTimers();
    latest.mockRejectedValueOnce({ response: { status: 429 } });
    const result = adapter.verify(fixture.submission);
    await jest.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ ledger: 100 });
    expect(latest).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("bounds retries when the head remains unavailable", async () => {
    jest.useFakeTimers();
    latest.mockRejectedValue({ code: "ETIMEDOUT" });
    const assertion = expect(
      adapter.verify(fixture.submission),
    ).rejects.toMatchObject({ code: "RPC_UNAVAILABLE", retryable: true });
    await jest.runAllTimersAsync();
    await assertion;
    expect(latest).toHaveBeenCalledTimes(3);
  });

  it("does not retry RPC authorization failures", async () => {
    latest.mockRejectedValue({
      response: { status: 403 },
      message: "Forbidden",
    });
    await expect(adapter.verify(fixture.submission)).rejects.toMatchObject({
      code: "RPC_ERROR",
      retryable: false,
    });
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("rejects a different registered submitter even at the confirmation threshold", async () => {
    await expect(
      adapter.verify({
        ...fixture.submission,
        submitter: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 43)).publicKey(),
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH", retryable: false });
  });

  it("defers then verifies the same submission when the ledger reaches the threshold", async () => {
    const history = {
      pending: jest
        .fn()
        .mockResolvedValue([{ id: "ledger-fixture", ...fixture.submission }]),
      defer: jest.fn(),
      setResult: jest.fn(),
    };
    const verifier = new SubmissionVerifierService(
      { recordVerification: jest.fn() } as unknown as AuditLogService,
      history as unknown as SubmissionHistoryService,
      adapter,
    );
    try {
      latest.mockResolvedValueOnce({ sequence: 100 });
      await verifier.verifyCycle();
      expect(history.defer).toHaveBeenCalledWith(
        "ledger-fixture",
        expect.any(String),
      );
      expect(history.setResult).not.toHaveBeenCalled();
      await verifier.verifyCycle();
      expect(history.setResult).toHaveBeenCalledTimes(1);
      expect(history.setResult).toHaveBeenCalledWith(
        "ledger-fixture",
        "verified",
      );
      expect(transaction.mock.calls).toEqual([
        [fixture.submission.transactionHash],
        [fixture.submission.transactionHash],
      ]);
    } finally {
      verifier.onModuleDestroy();
    }
  });
});

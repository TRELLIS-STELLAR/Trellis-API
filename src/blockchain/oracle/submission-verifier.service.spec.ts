import { SubmissionVerifierService } from "./submission-verifier.service";
import { OracleVerificationError } from "./services/stellar-oracle.adapter";

jest.mock("src/observability/telemetry.service", () => ({
  telemetryService: { startTimer: () => jest.fn() },
}));

const ledger = (instance: string) => ({
  latestLedger: 100,
  instance: { key: "i", state: instance },
  code: null,
  history: { key: "h", state: "missing" },
});

describe("SubmissionVerifierService", () => {
  let verifier: SubmissionVerifierService;
  let history: any;
  let adapter: any;
  beforeEach(() => {
    history = {
      pending: jest.fn().mockResolvedValue([{ id: "1" }]),
      setResult: jest.fn(),
      defer: jest.fn(),
    };
    adapter = {
      isEnabled: true,
      verify: jest.fn().mockResolvedValue({ hash: "a" }),
      assertNetwork: jest.fn().mockResolvedValue(undefined),
      getOracleLedgerState: jest.fn().mockResolvedValue(ledger("live")),
    };
    verifier = new SubmissionVerifierService(
      { recordVerification: jest.fn() } as any,
      history,
      adapter,
    );
  });
  afterEach(() => verifier.onModuleDestroy());
  it("persists verification only after the ledger check passes", async () => {
    await verifier.verifyCycle();
    expect(history.setResult).toHaveBeenCalledWith("1", "verified");
  });
  it("keeps unconfirmed submissions pending", async () => {
    adapter.verify.mockRejectedValue(
      new OracleVerificationError(
        "INSUFFICIENT_CONFIRMATIONS",
        "pending",
        true,
      ),
    );
    expect((await verifier.verifyCycle()).missing).toHaveLength(1);
    expect(history.setResult).not.toHaveBeenCalled();
  });
  it("persists rejected verification and its reason", async () => {
    adapter.verify.mockRejectedValue(
      new OracleVerificationError("PAYLOAD_MISMATCH", "wrong hash"),
    );
    await verifier.verifyCycle();
    expect(history.setResult).toHaveBeenCalledWith(
      "1",
      "rejected",
      "wrong hash",
    );
  });
  it("surfaces RPC failures and leaves retryable work pending", async () => {
    adapter.verify.mockRejectedValue(
      new OracleVerificationError("RPC_UNAVAILABLE", "offline", true),
    );
    await expect(verifier.verifyCycle()).rejects.toThrow("offline");
    expect(history.setResult).not.toHaveBeenCalled();
  });
  it("cleans up polling on shutdown", async () => {
    await verifier.start();
    expect(verifier.getStatus().running).toBe(true);
    verifier.onModuleDestroy();
    expect(verifier.getStatus().running).toBe(false);
  });

  describe("initialization", () => {
    it("runs every step and records the ledger state", async () => {
      expect(await verifier.start()).toMatchObject({
        state: "running",
        attempts: 1,
        ledger: ledger("live"),
      });
      expect(verifier.getStatus().running).toBe(true);
    });

    it("starts against archived state, which only blocks new submissions", async () => {
      adapter.getOracleLedgerState.mockResolvedValue(ledger("archived"));
      expect((await verifier.start()).state).toBe("running");
    });

    it.each([
      [
        "network",
        () =>
          adapter.assertNetwork.mockRejectedValue(
            new OracleVerificationError("NETWORK_MISMATCH", "wrong network"),
          ),
        "wrong network",
      ],
      [
        "contract",
        () => adapter.getOracleLedgerState.mockResolvedValue(ledger("missing")),
        "ORACLE_CONTRACT_ADDRESS has no contract instance on this network",
      ],
    ])(
      "rolls back and verifies a failed %s step",
      async (step, fail, error) => {
        fail();
        expect(await verifier.start()).toEqual({
          state: "failed",
          attempts: 1,
          failedStep: step,
          error,
          retryable: false,
          rolledBack: true,
        });
        expect(verifier.getStatus().running).toBe(false);
      },
    );

    it("reports transient failures as retryable and recovers on retry", async () => {
      adapter.assertNetwork.mockRejectedValueOnce(
        new OracleVerificationError("RPC_UNAVAILABLE", "offline", true),
      );
      expect(await verifier.start()).toMatchObject({
        state: "failed",
        retryable: true,
        rolledBack: true,
      });
      expect(await verifier.start()).toMatchObject({
        state: "running",
        attempts: 2,
      });
    });

    it("shares one attempt between concurrent and repeated starts", async () => {
      await Promise.all([verifier.start(), verifier.start()]);
      await verifier.start();
      expect(adapter.assertNetwork).toHaveBeenCalledTimes(1);
    });

    it("flags an unverified rollback while a cycle is still in flight", async () => {
      history.pending.mockReturnValue(new Promise(() => undefined));
      void verifier.verifyCycle();
      adapter.assertNetwork.mockRejectedValue(new Error("boom"));
      expect(await verifier.start()).toMatchObject({
        state: "failed",
        retryable: false,
        rolledBack: false,
      });
    });

    it("stays disabled without RPC configuration", async () => {
      adapter.isEnabled = false;
      expect((await verifier.start()).state).toBe("disabled");
      expect(adapter.assertNetwork).not.toHaveBeenCalled();
    });
  });
});

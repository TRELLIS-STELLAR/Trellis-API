import { SubmissionVerifierService } from "./submission-verifier.service";
import { OracleVerificationError } from "./services/stellar-oracle.adapter";

jest.mock("src/observability/telemetry.service", () => ({
  telemetryService: { startTimer: () => jest.fn() },
}));

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
  it("cleans up polling on shutdown", () => {
    verifier.start();
    expect(verifier.getStatus().running).toBe(true);
    verifier.onModuleDestroy();
    expect(verifier.getStatus().running).toBe(false);
  });
});

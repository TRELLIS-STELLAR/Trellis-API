import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  StellarOracleAdapter,
  hashOracleArguments,
} from "./stellar-oracle.adapter";

describe("StellarOracleAdapter", () => {
  const submitter = Keypair.random().publicKey();
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
  const args = [
    new Address(submitter).toScVal(),
    nativeToScVal("XLM_USD", { type: "symbol" }),
    nativeToScVal(100n, { type: "i128" }),
    nativeToScVal(2, { type: "u32" }),
    nativeToScVal(123n, { type: "u64" }),
    nativeToScVal(1n, { type: "u64" }),
  ];
  function envelope(
    contract = contractId,
    method = "submit_price",
    invocationArgs = args,
    network = Networks.TESTNET,
  ) {
    return new TransactionBuilder(new Account(submitter, "0"), {
      fee: "100",
      networkPassphrase: network,
    })
      .addOperation(new Contract(contract).call(method, ...invocationArgs))
      .setTimeout(30)
      .build();
  }
  let server: any;
  let adapter: StellarOracleAdapter;
  let input: any;
  beforeEach(() => {
    const tx = envelope();
    input = {
      submitter,
      payloadHash: hashOracleArguments(args),
      transactionHash: Buffer.from(tx.hash()).toString("hex"),
    };
    server = {
      getNetwork: jest
        .spyOn(rpc.Server.prototype, "getNetwork")
        .mockResolvedValue({ passphrase: Networks.TESTNET } as any),
      getTransaction: jest
        .spyOn(rpc.Server.prototype, "getTransaction")
        .mockResolvedValue({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 100,
          createdAt: 123,
          envelopeXdr: tx.toEnvelope(),
          returnValue: nativeToScVal(1n, { type: "u64" }),
        } as any),
      getLatestLedger: jest
        .spyOn(rpc.Server.prototype, "getLatestLedger")
        .mockResolvedValue({ sequence: 101 } as any),
    };
    const config: any = {
      get: (key, fallback) =>
        ({
          SOROBAN_RPC_URL: "https://rpc.example.com",
          ORACLE_CONTRACT_ADDRESS: contractId,
          ORACLE_MIN_CONFIRMATIONS: 2,
          ORACLE_RPC_MAX_RETRIES: 2,
          ORACLE_RPC_RETRY_DELAY_MS: 1,
        })[key] ?? fallback,
    };
    adapter = new StellarOracleAdapter(config);
  });
  afterEach(() => jest.restoreAllMocks());
  it("verifies the actual successful oracle invocation", async () => {
    expect(await adapter.verify(input)).toEqual({
      hash: input.payloadHash,
      timestamp: 123000,
      ledger: 100,
    });
    expect(server.getTransaction).toHaveBeenCalledWith(input.transactionHash);
  });
  it("rejects an RPC on a different network before reading a transaction", async () => {
    server.getNetwork.mockResolvedValue({ passphrase: Networks.PUBLIC });
    await expect(adapter.verify(input)).rejects.toMatchObject({
      code: "NETWORK_MISMATCH",
      retryable: false,
    });
    expect(server.getTransaction).not.toHaveBeenCalled();
  });
  it("reports missing transactions without trusting them", async () => {
    server.getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    });
    await expect(adapter.verify(input)).rejects.toMatchObject({
      code: "TRANSACTION_NOT_FOUND",
      retryable: true,
    });
  });
  it("reports insufficient confirmations", async () => {
    server.getLatestLedger.mockResolvedValue({ sequence: 100 });
    await expect(adapter.verify(input)).rejects.toMatchObject({
      code: "INSUFFICIENT_CONFIRMATIONS",
      retryable: true,
    });
  });
  it("retries transient failures with bounded backoff", async () => {
    server.getNetwork
      .mockRejectedValueOnce({ code: "ETIMEDOUT" })
      .mockRejectedValueOnce({ response: { status: 503 } });
    await expect(adapter.verify(input)).resolves.toBeDefined();
    expect(server.getNetwork).toHaveBeenCalledTimes(3);
  });
  it("surfaces RPC unavailability after exhausting retries", async () => {
    server.getNetwork.mockRejectedValue({ code: "ECONNRESET" });
    await expect(adapter.verify(input)).rejects.toMatchObject({
      code: "RPC_UNAVAILABLE",
      retryable: true,
    });
    expect(server.getNetwork).toHaveBeenCalledTimes(3);
  });
  it("does not retry permanent RPC errors", async () => {
    server.getNetwork.mockRejectedValue({
      response: { status: 400 },
      message: "invalid request",
    });
    await expect(adapter.verify(input)).rejects.toMatchObject({
      code: "RPC_ERROR",
    });
    expect(server.getNetwork).toHaveBeenCalledTimes(1);
  });
  it("rejects failed transactions", async () => {
    server.getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.FAILED,
    });
    await expect(adapter.verify(input)).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
    });
  });
  it.each([
    [
      "another contract",
      StrKey.encodeContract(Buffer.alloc(32, 2)),
      "submit_price",
    ],
    ["another method", contractId, "initialize"],
  ])("rejects %s", async (_, contract, method) => {
    const tx = envelope(contract, method);
    server.getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 100,
      envelopeXdr: tx.toEnvelope(),
    });
    await expect(
      adapter.verify({
        ...input,
        transactionHash: Buffer.from(tx.hash()).toString("hex"),
      }),
    ).rejects.toMatchObject({ code: "WRONG_CONTRACT" });
  });
  it("rejects a mismatched payload digest or submitter", async () => {
    await expect(
      adapter.verify({ ...input, payloadHash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH" });
    await expect(
      adapter.verify({ ...input, submitter: Keypair.random().publicKey() }),
    ).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH" });
  });
  it("rejects a substituted transaction envelope", async () => {
    await expect(
      adapter.verify({ ...input, transactionHash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "TRANSACTION_HASH_MISMATCH" });
  });
  it("rejects the wrong argument types", async () => {
    const tx = envelope(contractId, "submit_price", [
      args[0],
      xdr.ScVal.scvString("wrong"),
      ...args.slice(2),
    ]);
    server.getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 100,
      envelopeXdr: tx.toEnvelope(),
    });
    await expect(
      adapter.verify({
        ...input,
        transactionHash: Buffer.from(tx.hash()).toString("hex"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });
});

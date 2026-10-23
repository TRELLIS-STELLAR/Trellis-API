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
  MAX_LEDGER_KEYS_PER_REQUEST,
  MAX_LEDGER_KEYS_PER_SCAN,
  StellarOracleAdapter,
  classifyLedgerEntry,
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
  describe("ledger entry state", () => {
    const contract = new Contract(contractId);
    const instanceKey = contract.getFootprint();
    const wasmHash = Buffer.alloc(32, 7);
    const dataKey = (symbol: string, temporary = false) =>
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contract.address().toScAddress(),
          key: xdr.ScVal.scvSymbol(symbol),
          durability: temporary
            ? xdr.ContractDataDurability.temporary
            : xdr.ContractDataDurability.persistent,
        }),
      );
    const codeKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: wasmHash }),
    );
    const instanceVal: any = {
      type: "contractData",
      contractData: {
        val: xdr.ScVal.scvContractInstance(
          new xdr.ScContractInstance({
            executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
            storage: null,
          }),
        ),
      },
    };
    const entry = (key: any, liveUntilLedgerSeq?: number, val: any = {}) => ({
      key,
      val,
      lastModifiedLedgerSeq: 50,
      liveUntilLedgerSeq,
    });
    let getLedgerEntries: jest.SpyInstance;
    beforeEach(() => {
      getLedgerEntries = jest
        .spyOn(rpc.Server.prototype, "getLedgerEntries")
        .mockImplementation(async (...keys: any[]) => ({
          latestLedger: 1000,
          entries: keys.map((key) => entry(key, 2000)),
        }));
    });

    it.each([
      ["live until a future ledger", entry(instanceKey, 2000), "live"],
      ["live through the latest ledger", entry(instanceKey, 1000), "live"],
      ["archived with an elapsed TTL", entry(instanceKey, 999), "archived"],
      [
        "archived with the RPC placeholder TTL 0",
        entry(instanceKey, 0),
        "archived",
      ],
      ["absent from the RPC response", undefined, "missing"],
    ])("classifies an entry %s", (_, result: any, state) => {
      expect(classifyLedgerEntry(instanceKey, "k", result, 1000).state).toBe(
        state,
      );
    });

    it("treats an expired temporary entry as deleted, not restorable", () => {
      const key = dataKey("lock", true);
      expect(
        classifyLedgerEntry(key, "k", entry(key, 10) as any, 1000).state,
      ).toBe("missing");
    });

    it("treats classic entries without a TTL as live", () => {
      expect(
        classifyLedgerEntry(instanceKey, "k", entry(instanceKey) as any, 1000)
          .state,
      ).toBe("live");
    });

    it("reports live, archived and missing oracle state with code", async () => {
      getLedgerEntries
        .mockResolvedValueOnce({
          latestLedger: 1000,
          entries: [entry(instanceKey, 900, instanceVal)],
        })
        .mockResolvedValueOnce({
          latestLedger: 1001,
          entries: [entry(codeKey, 5000)],
        });
      const state = await adapter.getOracleLedgerState();
      expect(state).toMatchObject({
        latestLedger: 1001,
        instance: { state: "archived", liveUntilLedger: 900 },
        code: { state: "live", key: codeKey.toXdr("base64") },
        history: {
          state: "missing",
          key: dataKey("feed_his").toXdr("base64"),
          liveUntilLedger: null,
        },
      });
    });

    it("skips the code lookup when the contract instance is missing", async () => {
      getLedgerEntries.mockResolvedValueOnce({
        latestLedger: 1000,
        entries: [],
      });
      const state = await adapter.getOracleLedgerState();
      expect(state.instance.state).toBe("missing");
      expect(state.code).toBeNull();
      expect(getLedgerEntries).toHaveBeenCalledTimes(1);
    });

    it("de-duplicates keys and chunks scans at the RPC key limit", async () => {
      const keys = Array.from({ length: 450 }, (_, i) => dataKey(`k${i}`));
      const scan = await adapter.readLedgerEntries([...keys, keys[0]]);
      expect(getLedgerEntries.mock.calls.map((call) => call.length)).toEqual([
        MAX_LEDGER_KEYS_PER_REQUEST,
        MAX_LEDGER_KEYS_PER_REQUEST,
        50,
      ]);
      expect(scan.entries).toHaveLength(451);
      expect(scan.entries[450]).toEqual(scan.entries[0]);
    });

    it("refuses unbounded scans before calling RPC", async () => {
      const keys = Array.from(
        { length: MAX_LEDGER_KEYS_PER_SCAN + 1 },
        (_, i) => dataKey(`k${i}`),
      );
      await expect(adapter.readLedgerEntries(keys)).rejects.toMatchObject({
        code: "LEDGER_SCAN_LIMIT",
      });
      expect(getLedgerEntries).not.toHaveBeenCalled();
    });

    it("retries transient RPC failures while reading entries", async () => {
      getLedgerEntries.mockRejectedValueOnce({ response: { status: 429 } });
      const scan = await adapter.readLedgerEntries([instanceKey]);
      expect(scan.entries[0].state).toBe("live");
      expect(getLedgerEntries).toHaveBeenCalledTimes(2);
    });

    it("requires RPC configuration", async () => {
      const unconfigured = new StellarOracleAdapter({
        get: (_: string, fallback?: unknown) => fallback,
      } as any);
      await expect(unconfigured.getOracleLedgerState()).rejects.toMatchObject({
        code: "NOT_CONFIGURED",
      });
    });
  });
});

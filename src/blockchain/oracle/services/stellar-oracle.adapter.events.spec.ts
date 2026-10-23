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
import { StellarOracleAdapter, hashOracleArguments } from "./stellar-oracle.adapter";
import { SubmissionVerifierService } from "../submission-verifier.service";

jest.mock("src/observability/telemetry.service", () => ({
  telemetryService: { startTimer: () => jest.fn() },
}));

/**
 * verify() cross-checks the contract's ("oracle", "price") event against the
 * submit_price invocation (#348), without changing behaviour for RPC servers
 * that return no events.
 */
describe("StellarOracleAdapter contract event verification", () => {
  const submitter = Keypair.random().publicKey();
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
  const sym = (value: string) => nativeToScVal(value, { type: "symbol" });
  const args = [
    new Address(submitter).toScVal(),
    sym("XLM_USD"),
    nativeToScVal(100n, { type: "i128" }),
    nativeToScVal(2, { type: "u32" }),
    nativeToScVal(123n, { type: "u64" }),
    nativeToScVal(1n, { type: "u64" }),
  ];
  const tx = new TransactionBuilder(new Account(submitter, "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(contractId).call("submit_price", ...args))
    .setTimeout(30)
    .build();
  const input = {
    submitter,
    payloadHash: hashOracleArguments(args),
    transactionHash: Buffer.from(tx.hash()).toString("hex"),
  } as any;

  function priceEvent(
    data: xdr.ScVal[] = [sym("XLM_USD"), nativeToScVal(100n, { type: "i128" }), new Address(submitter).toScVal(), nativeToScVal(123n, { type: "u64" })],
    emitter = contractId,
  ) {
    return new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: new xdr.ContractId(StrKey.decodeContract(emitter)),
      type: xdr.ContractEventType.contract,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({ topics: [sym("oracle"), sym("price")], data: xdr.ScVal.scvVec(data) }),
      ),
    });
  }

  let getTransaction: jest.SpyInstance;
  let adapter: StellarOracleAdapter;
  const respond = (contractEventsXdr?: xdr.ContractEvent[][]) =>
    getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 100,
      createdAt: 123,
      envelopeXdr: tx.toEnvelope(),
      ...(contractEventsXdr && {
        events: { transactionEventsXdr: [], contractEventsXdr },
      }),
    } as any);

  beforeEach(() => {
    jest
      .spyOn(rpc.Server.prototype, "getNetwork")
      .mockResolvedValue({ passphrase: Networks.TESTNET } as any);
    jest
      .spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockResolvedValue({ sequence: 101 } as any);
    getTransaction = jest.spyOn(rpc.Server.prototype, "getTransaction");
    adapter = new StellarOracleAdapter({
      get: (key: string, fallback?: unknown) =>
        ({
          SOROBAN_RPC_URL: "https://rpc.example.com",
          ORACLE_CONTRACT_ADDRESS: contractId,
          ORACLE_RPC_RETRY_DELAY_MS: 1,
        })[key] ?? fallback,
    } as any);
  });
  afterEach(() => jest.restoreAllMocks());

  it("preserves the existing response when RPC returns no contract events", async () => {
    respond();
    expect(await adapter.verify(input)).toEqual({ hash: input.payloadHash, timestamp: 123000, ledger: 100 });
    respond([[]]);
    expect(await adapter.verify(input)).not.toHaveProperty("contractEvent");
  });

  it("normal path: returns the decoded v1 event", async () => {
    respond([[priceEvent()]]);
    const result = await adapter.verify(input);
    expect(result.contractEvent).toMatchObject({
      kind: "price",
      schemaVersion: 1,
      fields: { feed_id: "XLM_USD", price: "100", submitter },
      correlationId: null,
    });
  });

  it("normal path: surfaces the v2 correlation ID", async () => {
    respond([[priceEvent([sym("XLM_USD"), nativeToScVal(100n, { type: "i128" }), new Address(submitter).toScVal(), nativeToScVal(123n, { type: "u64" }), sym("req_9")])]]);
    expect((await adapter.verify(input)).contractEvent).toMatchObject({ schemaVersion: 2, correlationId: "req_9" });
  });

  it("failure path: an event that contradicts the invocation is a hard mismatch", async () => {
    respond([[priceEvent([sym("XLM_USD"), nativeToScVal(999n, { type: "i128" }), new Address(submitter).toScVal(), nativeToScVal(123n, { type: "u64" })])]]);
    await expect(adapter.verify(input)).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH", retryable: false });
  });

  it("authorization path: a spoofed event from another contract does not satisfy verification", async () => {
    respond([[priceEvent(undefined, StrKey.encodeContract(Buffer.alloc(32, 2)))]]);
    await expect(adapter.verify(input)).rejects.toMatchObject({ code: "CONTRACT_EVENT_MISSING", retryable: true });
  });

  it("retry path: schema drift is retryable instead of rejecting the submission", async () => {
    respond([[priceEvent([nativeToScVal(100n, { type: "i128" }), sym("XLM_USD"), new Address(submitter).toScVal(), nativeToScVal(123n, { type: "u64" })])]]);
    await expect(adapter.verify(input)).rejects.toMatchObject({ code: "EVENT_SCHEMA_MISMATCH", retryable: true });
  });

  it("retry path: the verifier defers a drifted submission and verifies it after a fix", async () => {
    const history = {
      pending: jest.fn().mockResolvedValue([{ id: "sub-1", ...input }]),
      setResult: jest.fn(),
      defer: jest.fn(),
    };
    const verifier = new SubmissionVerifierService({ recordVerification: jest.fn() } as any, history as any, adapter);
    try {
      respond([[priceEvent([sym("XLM_USD"), nativeToScVal(100n, { type: "u64" }), new Address(submitter).toScVal(), nativeToScVal(123n, { type: "u64" })])]]);
      await verifier.verifyCycle();
      expect(history.defer).toHaveBeenCalledWith("sub-1", expect.stringContaining("matches no registered schema"));
      expect(history.setResult).not.toHaveBeenCalled();

      // Next cycle (e.g. after deploying a decoder that knows the release).
      respond([[priceEvent()]]);
      await verifier.verifyCycle();
      expect(history.setResult).toHaveBeenCalledWith("sub-1", "verified");
    } finally {
      verifier.onModuleDestroy();
    }
  });

  it("bounds the scan: an event flood is refused before decoding", async () => {
    respond([Array.from({ length: 101 }, () => priceEvent())]);
    await expect(adapter.verify(input)).rejects.toMatchObject({ code: "EVENT_SCAN_LIMIT", retryable: true });
  });
});

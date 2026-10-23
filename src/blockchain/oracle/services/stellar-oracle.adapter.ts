import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Address,
  Contract,
  Networks,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import { SubmissionReference } from "./submission-history.service";
import {
  DecodedOracleEvent,
  OracleContractEventError,
  decodeOracleTransactionEvents,
} from "../events/oracle-contract-events";

export class OracleVerificationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

/** SHA-256 of the canonical ScVal vector of submit_price's six arguments. */
export function hashOracleArguments(args: xdr.ScVal[]): string {
  return createHash("sha256")
    .update(xdr.ScVal.scvVec(args).toXdr())
    .digest("hex");
}

/** Stellar RPC rejects getLedgerEntries requests with more than 200 keys. */
export const MAX_LEDGER_KEYS_PER_REQUEST = 200;
/** Upper bound for one ledger scan: at most five RPC round trips. */
export const MAX_LEDGER_KEYS_PER_SCAN = 1000;
/** Persistent key of the oracle contract's price history map. */
const FEED_HISTORY_KEY = "feed_his";

export type LedgerEntryState = "live" | "archived" | "missing";

export interface LedgerEntryStatus {
  /** Base64 LedgerKey XDR. */
  key: string;
  state: LedgerEntryState;
  liveUntilLedger: number | null;
  lastModifiedLedger: number | null;
}

export interface LedgerScan {
  latestLedger: number;
  /** One status per requested key, in request order. */
  entries: LedgerEntryStatus[];
  /** Raw entries that exist on the ledger (live or archived), by base64 key. */
  found: Map<string, rpc.Api.LedgerEntryResult>;
}

export interface OracleLedgerState {
  latestLedger: number;
  instance: LedgerEntryStatus;
  /** Null when the instance is missing or is not backed by uploaded Wasm. */
  code: LedgerEntryStatus | null;
  history: LedgerEntryStatus;
}

/**
 * Classifies one getLedgerEntries result. RPC omits keys that do not exist and
 * returns archived entries with a liveUntilLedgerSeq below the latest ledger
 * (0 when Core does not report the archived TTL). An expired temporary entry is
 * deleted, not archived, so it can never be restored.
 */
export function classifyLedgerEntry(
  key: xdr.LedgerKey,
  encodedKey: string,
  entry: rpc.Api.LedgerEntryResult | undefined,
  latestLedger: number,
): LedgerEntryStatus {
  const lastModifiedLedger = entry?.lastModifiedLedgerSeq ?? null;
  const liveUntilLedger = entry?.liveUntilLedgerSeq ?? null;
  let state: LedgerEntryState = "missing";
  if (entry) {
    // Classic entries (accounts, trustlines) carry no TTL and never archive.
    if (liveUntilLedger === null || liveUntilLedger >= latestLedger) {
      state = "live";
    } else if (
      key.type !== "contractData" ||
      key.contractData.durability.name !== "temporary"
    ) {
      state = "archived";
    }
  }
  return { key: encodedKey, state, liveUntilLedger, lastModifiedLedger };
}

@Injectable()
export class StellarOracleAdapter {
  private readonly server?: rpc.Server;
  private readonly passphrase: string;
  private readonly contract: string;
  private readonly confirmations: number;
  private readonly retries: number;
  private readonly retryDelay: number;

  constructor(config: ConfigService) {
    const url = config.get<string>("SOROBAN_RPC_URL");
    this.contract = config.get<string>("ORACLE_CONTRACT_ADDRESS");
    this.passphrase = config.get<string>(
      "STELLAR_NETWORK_PASSPHRASE",
      Networks.TESTNET,
    );
    this.confirmations = Number(config.get("ORACLE_MIN_CONFIRMATIONS", 1));
    this.retries = Number(config.get("ORACLE_RPC_MAX_RETRIES", 3));
    this.retryDelay = Number(config.get("ORACLE_RPC_RETRY_DELAY_MS", 250));
    if (
      !Number.isInteger(this.confirmations) ||
      this.confirmations < 1 ||
      !Number.isInteger(this.retries) ||
      this.retries < 0 ||
      this.retries > 10 ||
      !Number.isInteger(this.retryDelay) ||
      this.retryDelay < 1 ||
      this.retryDelay > 10000
    ) {
      throw new Error("Invalid oracle confirmation or retry configuration");
    }
    if (url && this.contract) {
      if (!StrKey.isValidContract(this.contract))
        throw new Error(
          "ORACLE_CONTRACT_ADDRESS must be a Stellar contract ID",
        );
      this.server = new rpc.Server(url, { timeout: 10 });
    }
  }

  get isEnabled() {
    return !!this.server;
  }

  private async request<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await action();
      } catch (error) {
        const status = error.response?.status;
        const transient =
          status === 429 ||
          status >= 500 ||
          [
            "ECONNRESET",
            "ECONNREFUSED",
            "ETIMEDOUT",
            "ENOTFOUND",
            "EAI_AGAIN",
            "ECONNABORTED",
          ].includes(error.code) ||
          /timeout|fetch failed|network error/i.test(error.message ?? "");
        if (!transient)
          throw new OracleVerificationError(
            "RPC_ERROR",
            `Soroban RPC request failed: ${error.message}`,
          );
        if (attempt >= this.retries)
          throw new OracleVerificationError(
            "RPC_UNAVAILABLE",
            "Soroban RPC unavailable after retries",
            true,
          );
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(this.retryDelay * 2 ** attempt, 10000)),
        );
      }
    }
  }

  private requireServer(): rpc.Server {
    if (!this.server)
      throw new OracleVerificationError(
        "NOT_CONFIGURED",
        "Configure SOROBAN_RPC_URL and ORACLE_CONTRACT_ADDRESS",
      );
    return this.server;
  }

  async assertNetwork(): Promise<void> {
    const server = this.requireServer();
    const network = await this.request(() => server.getNetwork());
    if (network.passphrase !== this.passphrase)
      throw new OracleVerificationError(
        "NETWORK_MISMATCH",
        "Soroban RPC network does not match STELLAR_NETWORK_PASSPHRASE",
      );
  }

  /**
   * Reads ledger entries in RPC-sized chunks and classifies each as live,
   * archived or missing. Keys are de-duplicated and the scan is capped, so cost
   * is O(n) time and space with ceil(n / 200) round trips, n <= 1000.
   */
  async readLedgerEntries(keys: xdr.LedgerKey[]): Promise<LedgerScan> {
    const server = this.requireServer();
    const encoded = keys.map((key) => key.toXdr("base64"));
    const unique = new Map<string, xdr.LedgerKey>();
    encoded.forEach((key, index) => unique.set(key, keys[index]));
    if (unique.size > MAX_LEDGER_KEYS_PER_SCAN)
      throw new OracleVerificationError(
        "LEDGER_SCAN_LIMIT",
        `Ledger scans are limited to ${MAX_LEDGER_KEYS_PER_SCAN} distinct keys`,
      );
    const pending = [...unique.keys()];
    const statuses = new Map<string, LedgerEntryStatus>();
    const found = new Map<string, rpc.Api.LedgerEntryResult>();
    let latestLedger = 0;
    for (let i = 0; i < pending.length; i += MAX_LEDGER_KEYS_PER_REQUEST) {
      const chunk = pending.slice(i, i + MAX_LEDGER_KEYS_PER_REQUEST);
      const response = await this.request(() =>
        server.getLedgerEntries(...chunk.map((key) => unique.get(key))),
      );
      latestLedger = Math.max(latestLedger, response.latestLedger);
      for (const entry of response.entries)
        found.set(entry.key.toXdr("base64"), entry);
      for (const key of chunk)
        statuses.set(
          key,
          classifyLedgerEntry(
            unique.get(key),
            key,
            found.get(key),
            response.latestLedger,
          ),
        );
    }
    return {
      latestLedger,
      entries: encoded.map((key) => statuses.get(key)),
      found,
    };
  }

  /**
   * Reports the entries every submit_price invocation depends on: the contract
   * instance (instance storage holds submitters, nonces and latest prices), its
   * Wasm code, and the persistent price history map.
   */
  async getOracleLedgerState(): Promise<OracleLedgerState> {
    this.requireServer();
    const contract = new Contract(this.contract);
    const instanceKey = contract.getFootprint();
    const historyKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contract.address().toScAddress(),
        key: xdr.ScVal.scvSymbol(FEED_HISTORY_KEY),
        durability: xdr.ContractDataDurability.persistent,
      }),
    );
    const scan = await this.readLedgerEntries([instanceKey, historyKey]);
    const [instance, history] = scan.entries;
    const instanceData = scan.found.get(instance.key)?.val;
    const value =
      instanceData?.type === "contractData"
        ? instanceData.contractData.val
        : undefined;
    let code: LedgerEntryStatus | null = null;
    let latestLedger = scan.latestLedger;
    if (
      value?.type === "scvContractInstance" &&
      value.instance.executable.type === "contractExecutableWasm"
    ) {
      const codeScan = await this.readLedgerEntries([
        xdr.LedgerKey.contractCode(
          new xdr.LedgerKeyContractCode({
            hash: value.instance.executable.wasmHash,
          }),
        ),
      ]);
      code = codeScan.entries[0];
      latestLedger = Math.max(latestLedger, codeScan.latestLedger);
    }
    return { latestLedger, instance, code, history };
  }

  async verify(submission: SubmissionReference): Promise<{
    hash: string;
    timestamp: number;
    ledger: number;
    /** Present only when RPC returned the transaction's contract events. */
    contractEvent?: DecodedOracleEvent;
  }> {
    await this.assertNetwork();
    const transaction = await this.request(() =>
      this.server.getTransaction(submission.transactionHash),
    );
    if (transaction.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      throw new OracleVerificationError(
        "TRANSACTION_NOT_FOUND",
        "Transaction not found in RPC retention window; it may be pending or require an archival RPC",
        true,
      );
    }
    if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new OracleVerificationError(
        "TRANSACTION_FAILED",
        "Oracle transaction failed on the ledger",
      );
    }
    const latest = await this.request(() => this.server.getLatestLedger());
    if (latest.sequence - transaction.ledger + 1 < this.confirmations) {
      throw new OracleVerificationError(
        "INSUFFICIENT_CONFIRMATIONS",
        "Transaction has insufficient ledger confirmations",
        true,
      );
    }
    const envelope = TransactionBuilder.fromXdr(
      transaction.envelopeXdr,
      this.passphrase,
    );
    if (
      Buffer.from(envelope.hash()).toString("hex") !==
      submission.transactionHash.toLowerCase()
    ) {
      throw new OracleVerificationError(
        "TRANSACTION_HASH_MISMATCH",
        "RPC envelope does not match the requested transaction",
      );
    }
    const inner =
      "innerTransaction" in envelope ? envelope.innerTransaction : envelope;
    const operation =
      inner.operations.length === 1 ? inner.operations[0] : undefined;
    if (
      !operation ||
      operation.type !== "invokeHostFunction" ||
      operation.func.type !== "hostFunctionTypeInvokeContract"
    ) {
      throw new OracleVerificationError(
        "INVALID_INVOCATION",
        "Expected a single direct oracle contract invocation",
      );
    }
    const invocation = operation.func.invokeContract;
    if (
      Address.fromScAddress(invocation.contractAddress).toString() !==
        this.contract ||
      invocation.functionName.toString() !== "submit_price"
    ) {
      throw new OracleVerificationError(
        "WRONG_CONTRACT",
        "Transaction does not invoke submit_price on the configured oracle contract",
      );
    }
    const args = invocation.args;
    const types = [
      "scvAddress",
      "scvSymbol",
      "scvI128",
      "scvU32",
      "scvU64",
      "scvU64",
    ];
    if (
      args.length !== types.length ||
      args.some((arg, index) => arg.type !== types[index])
    ) {
      throw new OracleVerificationError(
        "INVALID_PAYLOAD",
        "Oracle arguments do not match the submit_price ABI",
      );
    }
    if (
      scValToNative(args[0]) !== submission.submitter ||
      hashOracleArguments(args) !== submission.payloadHash.toLowerCase()
    ) {
      throw new OracleVerificationError(
        "PAYLOAD_MISMATCH",
        "Ledger submitter or payload hash differs from the registered submission",
      );
    }
    const contractEvent = this.verifyPriceEvent(
      (transaction as rpc.Api.GetSuccessfulTransactionResponse).events
        ?.contractEventsXdr,
      args,
    );
    return {
      hash: hashOracleArguments(args),
      timestamp: Number(transaction.createdAt) * 1000,
      ledger: transaction.ledger,
      ...(contractEvent && { contractEvent }),
    };
  }

  /**
   * Cross-checks the `("oracle", "price")` event against the invocation (#348).
   * RPC servers or protocols that return no contract events keep the previous
   * argument-only verification; once events are present they must decode
   * against a registered schema and agree with the arguments.
   *
   * Schema drift is retryable: the submission is deferred, not rejected, so it
   * verifies once a decoder that knows the new contract release is deployed.
   * Only a decoded event that contradicts the invocation is a hard mismatch.
   */
  private verifyPriceEvent(
    contractEventsXdr: xdr.ContractEvent[][] | undefined,
    args: xdr.ScVal[],
  ): DecodedOracleEvent | undefined {
    let events: ReturnType<typeof decodeOracleTransactionEvents>;
    try {
      events = decodeOracleTransactionEvents(contractEventsXdr, this.contract);
    } catch (error) {
      if (error instanceof OracleContractEventError)
        throw new OracleVerificationError(error.code, error.message, true);
      throw error;
    }
    if (!events.available) return undefined;
    const prices = events.decoded.filter((event) => event.kind === "price");
    if (prices.length !== 1)
      throw new OracleVerificationError(
        "CONTRACT_EVENT_MISSING",
        `Expected exactly one oracle price event from the configured contract, found ${prices.length}`,
        true,
      );
    const [event] = prices;
    if (
      event.fields.feed_id !== String(scValToNative(args[1])) ||
      event.fields.price !== String(scValToNative(args[2])) ||
      event.fields.submitter !== scValToNative(args[0])
    )
      throw new OracleVerificationError(
        "PAYLOAD_MISMATCH",
        "Oracle price event differs from the submit_price invocation",
      );
    return event;
  }
}

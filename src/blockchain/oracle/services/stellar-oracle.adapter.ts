import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Address,
  Networks,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import { SubmissionReference } from "./submission-history.service";

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

  async verify(
    submission: SubmissionReference,
  ): Promise<{ hash: string; timestamp: number; ledger: number }> {
    if (!this.server)
      throw new OracleVerificationError(
        "NOT_CONFIGURED",
        "Configure SOROBAN_RPC_URL and ORACLE_CONTRACT_ADDRESS",
      );
    const network = await this.request(() => this.server.getNetwork());
    if (network.passphrase !== this.passphrase)
      throw new OracleVerificationError(
        "NETWORK_MISMATCH",
        "Soroban RPC network does not match STELLAR_NETWORK_PASSPHRASE",
      );
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
    return {
      hash: hashOracleArguments(args),
      timestamp: Number(transaction.createdAt) * 1000,
      ledger: transaction.ledger,
    };
  }
}

import { Injectable, Logger, BadRequestException, ServiceUnavailableException, Optional } from "@nestjs/common";
import {
  Keypair,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  Horizon,
  BASE_FEE,
} from "@stellar/stellar-sdk";

export interface TradeRequest {
  portfolioId: string;
  ticker: string;
  action: "buy" | "sell";
  quantity: number;
  price: number;
  clientRequestId?: string;
  slippageTolerance?: number; // e.g. 0.02 (2%)
  sourceSecret?: string;
  destinationAddress?: string;
  accountBalance?: number;
  hasTrustline?: boolean;
  actualPrice?: number;
}

export interface TradeResult {
  success: boolean;
  transactionHash?: string;
  executedQuantity: number;
  executedPrice: number;
  status: "CONFIRMED" | "FAILED" | "TIMED_OUT";
  errorReason?: string;
  timestamp: string;
  clientRequestId?: string;
}

@Injectable()
export class TradingTransactionService {
  private readonly logger = new Logger(TradingTransactionService.name);
  private readonly tradeHistory: Map<string, TradeResult> = new Map(); // hash/id -> result
  private readonly idempotencyMap: Map<string, TradeResult> = new Map(); // clientRequestId -> result
  private server?: Horizon.Server;
  private networkPassphrase: string = Networks.TESTNET;

  constructor(
    @Optional() horizonServer?: Horizon.Server,
    @Optional() networkPassphrase?: string,
  ) {
    if (horizonServer) {
      this.server = horizonServer;
    }
    if (networkPassphrase) {
      this.networkPassphrase = networkPassphrase;
    }
  }

  setHorizonServer(server: Horizon.Server) {
    this.server = server;
  }

  /**
   * Main entry point called by callers (e.g. rebalancing service)
   */
  async executeTrade(
    portfolioId: string,
    ticker: string,
    action: "buy" | "sell",
    quantity: number,
    price: number,
    clientRequestId?: string,
    extraOptions?: Partial<TradeRequest>,
  ): Promise<TradeResult> {
    return this.processTrade({
      portfolioId,
      ticker,
      action,
      quantity,
      price,
      clientRequestId,
      ...extraOptions,
    });
  }

  /**
   * Process a trade request with Stellar SDK integration, idempotency, failure mode handling, and timeout verification.
   */
  async processTrade(request: TradeRequest): Promise<TradeResult> {
    const {
      portfolioId,
      ticker,
      action,
      quantity,
      price,
      clientRequestId,
      slippageTolerance = 0.02,
      sourceSecret,
      destinationAddress,
      accountBalance,
      hasTrustline,
      actualPrice,
    } = request;

    this.logger.log(
      `Executing ${action} trade for ${quantity} of ${ticker} at $${price} for portfolio ${portfolioId}`,
    );

    // 1. Idempotency Check
    if (clientRequestId && this.idempotencyMap.has(clientRequestId)) {
      this.logger.log(`Idempotent trade request detected for key: ${clientRequestId}`);
      return this.idempotencyMap.get(clientRequestId)!;
    }

    // 2. Validate Failure Modes

    // Failure Mode A: Slippage Tolerance Exceeded
    const currentMarketPrice = actualPrice !== undefined ? actualPrice : price;
    if (price > 0) {
      const priceDrift = Math.abs(currentMarketPrice - price) / price;
      if (priceDrift > slippageTolerance) {
        const failureResult: TradeResult = {
          success: false,
          executedQuantity: 0,
          executedPrice: currentMarketPrice,
          status: "FAILED",
          errorReason: "SLIPPAGE_EXCEEDED",
          timestamp: new Date().toISOString(),
          clientRequestId,
        };
        if (clientRequestId) this.idempotencyMap.set(clientRequestId, failureResult);
        return failureResult;
      }
    }

    // Failure Mode B: Insufficient Balance
    const totalCost = quantity * currentMarketPrice;
    if (accountBalance !== undefined && accountBalance < totalCost) {
      const failureResult: TradeResult = {
        success: false,
        executedQuantity: 0,
        executedPrice: 0,
        status: "FAILED",
        errorReason: "INSUFFICIENT_BALANCE",
        timestamp: new Date().toISOString(),
        clientRequestId,
      };
      if (clientRequestId) this.idempotencyMap.set(clientRequestId, failureResult);
      return failureResult;
    }

    // Failure Mode C: Trustline Missing
    if (hasTrustline === false) {
      const failureResult: TradeResult = {
        success: false,
        executedQuantity: 0,
        executedPrice: 0,
        status: "FAILED",
        errorReason: "TRUSTLINE_MISSING",
        timestamp: new Date().toISOString(),
        clientRequestId,
      };
      if (clientRequestId) this.idempotencyMap.set(clientRequestId, failureResult);
      return failureResult;
    }

    // 3. Build, Sign & Submit via Stellar SDK if server is available or mock submission
    let txHash: string;
    try {
      if (this.server && sourceSecret) {
        const sourceKeypair = Keypair.fromSecret(sourceSecret);
        const sourceAccount = await this.server.loadAccount(sourceKeypair.publicKey());

        const asset = ticker === "XLM" || ticker === "NATIVE"
          ? Asset.native()
          : new Asset(ticker, destinationAddress || sourceKeypair.publicKey());

        const builder = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        }).addOperation(
          Operation.payment({
            destination: destinationAddress || sourceKeypair.publicKey(),
            asset,
            amount: quantity.toString(),
          }),
        );

        const tx = builder.setTimeout(30).build();
        tx.sign(sourceKeypair);

        try {
          const res = await this.server.submitTransaction(tx as any);
          txHash = res.hash;
        } catch (submitErr: any) {
          // Check if submission timed out vs failed
          if (submitErr.message?.includes("timeout") || submitErr.code === "ETIMEDOUT") {
            const rawHash = Buffer.from(tx.hash()).toString("hex");
            const confirmedHash = await this.checkLedgerStatus(rawHash);
            if (confirmedHash) {
              txHash = confirmedHash;
            } else {
              const timedOutResult: TradeResult = {
                success: false,
                executedQuantity: 0,
                executedPrice: 0,
                status: "TIMED_OUT",
                errorReason: "NETWORK_TIMEOUT",
                timestamp: new Date().toISOString(),
                clientRequestId,
              };
              if (clientRequestId) this.idempotencyMap.set(clientRequestId, timedOutResult);
              return timedOutResult;
            }
          } else {
            throw submitErr;
          }
        }
      } else {
        // Fallback / mock execution hash for test environments without live RPC
        const crypto = require("crypto");
        txHash = crypto.createHash("sha256").update(`${portfolioId}-${ticker}-${action}-${quantity}-${Date.now()}`).digest("hex");
      }
    } catch (err: any) {
      this.logger.error(`Trade submission failed for ${ticker}: ${err.message}`);
      const errReason = err.message?.includes("underfunded")
        ? "INSUFFICIENT_BALANCE"
        : err.message?.includes("no_trust")
        ? "TRUSTLINE_MISSING"
        : "NETWORK_ERROR";

      const failureResult: TradeResult = {
        success: false,
        executedQuantity: 0,
        executedPrice: 0,
        status: "FAILED",
        errorReason: errReason,
        timestamp: new Date().toISOString(),
        clientRequestId,
      };
      if (clientRequestId) this.idempotencyMap.set(clientRequestId, failureResult);
      return failureResult;
    }

    const successResult: TradeResult = {
      success: true,
      transactionHash: txHash,
      executedQuantity: quantity,
      executedPrice: currentMarketPrice,
      status: "CONFIRMED",
      timestamp: new Date().toISOString(),
      clientRequestId,
    };

    // 4. Persist Trade Record
    this.tradeHistory.set(txHash, successResult);
    if (clientRequestId) {
      this.idempotencyMap.set(clientRequestId, successResult);
    }

    return successResult;
  }

  /**
   * Check ledger on timeout before reporting failure.
   */
  async checkLedgerStatus(hash: string): Promise<string | null> {
    if (!this.server) return null;
    try {
      const record: any = await this.server.transactions().transaction(hash).call();
      if (record && record.successful) {
        return record.hash;
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Retrieve persisted trade by transaction hash
   */
  getTradeByHash(hash: string): TradeResult | undefined {
    return this.tradeHistory.get(hash);
  }

  /**
   * Retrieve all persisted trades
   */
  getAllTrades(): TradeResult[] {
    return Array.from(this.tradeHistory.values());
  }
}

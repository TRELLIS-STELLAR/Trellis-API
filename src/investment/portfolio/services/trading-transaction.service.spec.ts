import { Test, TestingModule } from "@nestjs/testing";
import { Keypair, Account } from "@stellar/stellar-sdk";
import { TradingTransactionService, TradeRequest } from "./trading-transaction.service";

describe("TradingTransactionService", () => {
  let service: TradingTransactionService;
  const validSecretKey = Keypair.random().secret();
  const mockAccount = new Account(Keypair.fromSecret(validSecretKey).publicKey(), "100");

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TradingTransactionService],
    }).compile();

    service = module.get<TradingTransactionService>(TradingTransactionService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("trade execution success & persistence", () => {
    it("should execute trade successfully and persist transaction hash", async () => {
      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "XLM",
        action: "buy",
        quantity: 100,
        price: 0.12,
        clientRequestId: "req-001",
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(true);
      expect(result.status).toBe("CONFIRMED");
      expect(result.transactionHash).toBeDefined();
      expect(result.executedQuantity).toBe(100);
      expect(result.executedPrice).toBe(0.12);

      const persisted = service.getTradeByHash(result.transactionHash!);
      expect(persisted).toEqual(result);
    });
  });

  describe("idempotency", () => {
    it("should return identical result for duplicate clientRequestId without double execution", async () => {
      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "BTC",
        action: "sell",
        quantity: 1,
        price: 50000,
        clientRequestId: "idempotency-key-123",
      };

      const firstCall = await service.processTrade(request);
      const secondCall = await service.processTrade(request);

      expect(firstCall).toBe(secondCall);
      expect(service.getAllTrades()).toHaveLength(1);
    });
  });

  describe("failure modes", () => {
    it("should handle INSUFFICIENT_BALANCE distinctly", async () => {
      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "ETH",
        action: "buy",
        quantity: 10,
        price: 3000,
        accountBalance: 500, // less than required 30,000
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.errorReason).toBe("INSUFFICIENT_BALANCE");
    });

    it("should handle TRUSTLINE_MISSING distinctly", async () => {
      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "USDC",
        action: "buy",
        quantity: 500,
        price: 1,
        hasTrustline: false,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.errorReason).toBe("TRUSTLINE_MISSING");
    });

    it("should handle price moving beyond SLIPPAGE_EXCEEDED tolerance distinctly", async () => {
      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "XLM",
        action: "buy",
        quantity: 1000,
        price: 0.1,
        actualPrice: 0.15, // 50% price change > 2% slippage tolerance
        slippageTolerance: 0.02,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.errorReason).toBe("SLIPPAGE_EXCEEDED");
    });

    it("should distinguish network error failure mode", async () => {
      const mockHorizonServer: any = {
        loadAccount: jest.fn().mockRejectedValue(new Error("Network connection refused")),
      };
      service.setHorizonServer(mockHorizonServer);

      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "XLM",
        action: "buy",
        quantity: 100,
        price: 0.1,
        sourceSecret: validSecretKey,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.errorReason).toBe("NETWORK_ERROR");
    });
  });

  describe("timed out submission ledger verification", () => {
    it("should check ledger on timeout and confirm if transaction exists on chain", async () => {
      const mockHorizonServer: any = {
        loadAccount: jest.fn().mockResolvedValue(mockAccount),
        submitTransaction: jest.fn().mockRejectedValue({ message: "timeout error" }),
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({
            call: jest.fn().mockResolvedValue({
              successful: true,
              hash: "ledger-confirmed-hash-123",
            }),
          }),
        }),
      };

      service.setHorizonServer(mockHorizonServer);

      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "XLM",
        action: "buy",
        quantity: 50,
        price: 0.1,
        sourceSecret: validSecretKey,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(true);
      expect(result.status).toBe("CONFIRMED");
      expect(result.transactionHash).toBe("ledger-confirmed-hash-123");
    });

    it("should report TIMED_OUT if transaction is not found on ledger after timeout", async () => {
      const mockHorizonServer: any = {
        loadAccount: jest.fn().mockResolvedValue(mockAccount),
        submitTransaction: jest.fn().mockRejectedValue({ message: "timeout error" }),
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({
            call: jest.fn().mockRejectedValue(new Error("404 Not Found")),
          }),
        }),
      };

      service.setHorizonServer(mockHorizonServer);

      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "XLM",
        action: "buy",
        quantity: 50,
        price: 0.1,
        sourceSecret: validSecretKey,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("TIMED_OUT");
      expect(result.errorReason).toBe("NETWORK_TIMEOUT");
    });
  });
});

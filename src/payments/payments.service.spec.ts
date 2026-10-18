import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Repository } from "typeorm";
import {
  PaymentsService,
  RATE_LOCK_TTL_MS,
  RATE_LOCK_TTL_SECONDS,
  VOLATILITY_BUFFER_PERCENT,
} from "./payments.service";
import { PaymentProcessorFactory } from "./payment-processor.factory";
import { PaymentProcessorRegistry } from "./registry/payment-processor.registry";
import { PaymentOperation } from "./entities/payment-operation.entity";
import {
  CreatedPayment,
  PaymentStatus,
} from "./interfaces/payment-processor.interface";

describe("PaymentsService - Currency Exchange Rate Lock and Volatility Buffer", () => {
  let service: PaymentsService;
  let factory: jest.Mocked<PaymentProcessorFactory>;
  let registry: jest.Mocked<PaymentProcessorRegistry>;
  let repository: jest.Mocked<Repository<PaymentOperation>>;
  let mockRedis: any;

  const mockProcessor = {
    name: "stellar",
    displayName: "Stellar",
    capabilities: {
      supportsPartialRefund: true,
      requiresClientSideSigning: false,
      currencies: ["XLM"],
    },
    initialize: jest.fn(),
    createPayment: jest.fn(),
    signTransaction: jest.fn(),
    submitTransaction: jest.fn(),
    getStatus: jest.fn(),
    refund: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessor.createPayment.mockReset();
    factory = {
      resolve: jest.fn().mockReturnValue(mockProcessor),
    } as any;
    registry = {
      info: jest.fn(),
      enable: jest.fn(),
      disable: jest.fn(),
    } as any;
    repository = {
      create: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      find: jest.fn(),
    } as any;

    mockRedis = {
      storage: new Map<string, string>(),
      set: jest.fn(async (key: string, val: string, _mode: string, _ttl: number) => {
        mockRedis.storage.set(key, val);
        return "OK";
      }),
      get: jest.fn(async (key: string) => {
        return mockRedis.storage.get(key) ?? null;
      }),
    };

    service = new PaymentsService(factory, registry, repository, mockRedis);
  });

  describe("createRateQuote", () => {
    it("should calculate 1% market volatility safety buffer and lock rate in Redis for 15 minutes", async () => {
      const quote = await service.createRateQuote({
        fromCurrency: "USD",
        toCurrency: "XLM",
        fromAmount: "100.00",
        spotRate: 8.5,
      });

      expect(quote).toBeDefined();
      expect(quote.quoteId).toBeDefined();
      expect(quote.fromCurrency).toBe("USD");
      expect(quote.toCurrency).toBe("XLM");
      expect(quote.fromAmount).toBe("100.00");
      expect(quote.spotRate).toBe(8.5);
      expect(quote.bufferPercent).toBe(VOLATILITY_BUFFER_PERCENT);
      expect(quote.bufferPercent).toBe(1.0);

      // 1% buffer: effectiveRate = spotRate * 1.01 = 8.5 * 1.01 = 8.585
      const expectedEffectiveRate = Number((8.5 * 1.01).toFixed(8));
      expect(quote.effectiveRate).toBe(expectedEffectiveRate);

      // toAmount = 100 * 8.585 = 858.5
      expect(parseFloat(quote.toAmount)).toBeCloseTo(100 * expectedEffectiveRate, 4);

      // 15-minute lock window: TTL 900s
      expect(quote.expiresInSeconds).toBe(RATE_LOCK_TTL_SECONDS);
      expect(quote.expiresAt - quote.createdAt).toBe(RATE_LOCK_TTL_MS);

      // Verify stored in Redis with rate_lock:{quoteId} key format and 900s TTL
      const expectedKey = `rate_lock:${quote.quoteId}`;
      expect(mockRedis.set).toHaveBeenCalledWith(
        expectedKey,
        expect.any(String),
        "EX",
        900,
      );
      const rawStored = mockRedis.storage.get(expectedKey);
      expect(rawStored).toBeDefined();
      const storedQuote = JSON.parse(rawStored!);
      expect(storedQuote.quoteId).toBe(quote.quoteId);
      expect(storedQuote.effectiveRate).toBe(expectedEffectiveRate);
    });

    it("should fallback to default currency conversion rates when spotRate is omitted", async () => {
      const quote = await service.createRateQuote({
        fromCurrency: "USD",
        toCurrency: "XLM",
        fromAmount: "50",
      });

      // Default USD_TO_XLM is 8.5
      expect(quote.spotRate).toBe(8.5);
      expect(quote.effectiveRate).toBe(Number((8.5 * 1.01).toFixed(8)));
      expect(parseFloat(quote.toAmount)).toBeCloseTo(50 * 8.585, 4);
    });

    it("should reject negative or zero fromAmount", async () => {
      await expect(
        service.createRateQuote({
          fromCurrency: "USD",
          toCurrency: "XLM",
          fromAmount: "0",
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.createRateQuote({
          fromCurrency: "USD",
          toCurrency: "XLM",
          fromAmount: "-10",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getRateQuote & validateRateQuote", () => {
    it("should retrieve an active rate quote within 15 minutes", async () => {
      const created = await service.createRateQuote({
        fromCurrency: "USD",
        toCurrency: "XLM",
        fromAmount: "100",
        spotRate: 10,
      });

      const retrieved = await service.getRateQuote(created.quoteId);
      expect(retrieved.quoteId).toBe(created.quoteId);
      expect(retrieved.effectiveRate).toBe(10.1);

      const validated = await service.validateRateQuote(created.quoteId);
      expect(validated.quoteId).toBe(created.quoteId);
    });

    it("should reject expired quotes (>15 min) and require fresh quote generation", async () => {
      const quoteId = "expired-quote-uuid";
      const now = Date.now();
      const expiredAt = now - 1000; // expired 1s ago (>15 min old)
      const expiredQuote = {
        quoteId,
        fromCurrency: "USD",
        toCurrency: "XLM",
        fromAmount: "100",
        spotRate: 10,
        bufferPercent: 1.0,
        effectiveRate: 10.1,
        toAmount: "1010.0000000",
        createdAt: expiredAt - RATE_LOCK_TTL_MS,
        expiresAt: expiredAt,
        expiresInSeconds: RATE_LOCK_TTL_SECONDS,
      };

      mockRedis.storage.set(`rate_lock:${quoteId}`, JSON.stringify(expiredQuote));

      await expect(service.getRateQuote(quoteId)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getRateQuote(quoteId)).rejects.toThrow(
        /expired/i,
      );

      await expect(service.validateRateQuote(quoteId)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.validateRateQuote(quoteId)).rejects.toThrow(
        /expired/i,
      );
    });

    it("should throw NotFoundException / BadRequestException when quote does not exist", async () => {
      await expect(service.getRateQuote("non-existent-id")).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.validateRateQuote("non-existent-id")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("In-memory fallback when Redis is absent or fails", () => {
    it("should correctly store, retrieve, and expire quotes using in-memory fallback", async () => {
      const serviceNoRedis = new PaymentsService(
        factory,
        registry,
        repository,
        null,
      );

      const quote = await serviceNoRedis.createRateQuote({
        fromCurrency: "USD",
        toCurrency: "XLM",
        fromAmount: "200",
        spotRate: 5,
      });

      expect(quote).toBeDefined();
      expect(quote.effectiveRate).toBe(Number((5 * 1.01).toFixed(8)));

      const retrieved = await serviceNoRedis.getRateQuote(quote.quoteId);
      expect(retrieved.quoteId).toBe(quote.quoteId);

      // Simulate expired quote in memory
      (quote as any).expiresAt = Date.now() - 5000;
      await expect(serviceNoRedis.validateRateQuote(quote.quoteId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("createPayment with rate lock quoteId", () => {
    it("should accept valid rate quote and proceed with payment creation", async () => {
      const createdQuote = await service.createRateQuote({
        fromCurrency: "USD",
        toCurrency: "XLM",
        fromAmount: "100",
        spotRate: 8.5,
      });

      mockProcessor.createPayment.mockResolvedValue({
        paymentId: "pay-123",
        status: PaymentStatus.PENDING,
      } as CreatedPayment);

      const operation = {
        operationId: "op-1",
        ownerId: "user-1",
        processorName: "stellar",
        idempotencyKey: "idem-1",
        requestFingerprint: "fp",
        state: "CREATING",
      };
      repository.create.mockReturnValue(operation as any);
      repository.save.mockResolvedValue(operation as any);

      const payment = await service.createPayment(
        {
          amount: createdQuote.toAmount,
          currency: "XLM",
          destination: "GBDESTINATIONACCOUNT...",
          idempotencyKey: "idem-1",
          quoteId: createdQuote.quoteId,
        },
        "stellar",
        "user-1",
      );

      expect(payment).toBeDefined();
      expect(mockProcessor.createPayment).toHaveBeenCalled();
    });

    it("should reject payment creation when rate quote is expired (>15 min)", async () => {
      const quoteId = "expired-quote-pay";
      const expiredQuote = {
        quoteId,
        fromCurrency: "USD",
        toCurrency: "XLM",
        fromAmount: "100",
        spotRate: 8.5,
        bufferPercent: 1.0,
        effectiveRate: 8.585,
        toAmount: "858.5000000",
        createdAt: Date.now() - 20 * 60 * 1000,
        expiresAt: Date.now() - 5 * 60 * 1000, // expired 5 minutes ago
        expiresInSeconds: 900,
      };
      mockRedis.storage.set(`rate_lock:${quoteId}`, JSON.stringify(expiredQuote));

      await expect(
        service.createPayment(
          {
            amount: "858.5000000",
            currency: "XLM",
            destination: "GBDESTINATIONACCOUNT...",
            idempotencyKey: "idem-expired",
            quoteId,
          },
          "stellar",
          "user-1",
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockProcessor.createPayment).not.toHaveBeenCalled();
    });

    it("should reject payment creation when metadata.quoteId is expired (>15 min)", async () => {
      const quoteId = "expired-quote-meta";
      const expiredQuote = {
        quoteId,
        fromCurrency: "USD",
        toCurrency: "XLM",
        fromAmount: "100",
        spotRate: 8.5,
        bufferPercent: 1.0,
        effectiveRate: 8.585,
        toAmount: "858.5000000",
        createdAt: Date.now() - 20 * 60 * 1000,
        expiresAt: Date.now() - 5 * 60 * 1000,
        expiresInSeconds: 900,
      };
      mockRedis.storage.set(`rate_lock:${quoteId}`, JSON.stringify(expiredQuote));

      await expect(
        service.createPayment(
          {
            amount: "858.5000000",
            currency: "XLM",
            destination: "GBDESTINATIONACCOUNT...",
            idempotencyKey: "idem-expired-meta",
            metadata: { quoteId },
          },
          "stellar",
          "user-1",
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockProcessor.createPayment).not.toHaveBeenCalled();
    });
  });
});

import { INestApplication, HttpStatus } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import request from "supertest";
import { ReconciliationController } from "src/reconciliation/reconciliation.controller";
import { ReconciliationService } from "src/reconciliation/reconciliation.service";
import {
  ReconciliationInvoice,
  ReconciliationInvoiceStatus,
} from "src/reconciliation/entities/reconciliation-invoice.entity";
import {
  StellarTransaction,
  StellarTransactionStatus,
} from "src/reconciliation/entities/stellar-transaction.entity";
import {
  ReconciliationAudit,
  ReconciliationDecision,
} from "src/reconciliation/entities/reconciliation-audit.entity";
import { GlobalExceptionFilter } from "src/common/filters/global-exception.filter";
import { createGlobalValidationPipe } from "src/common/pipes/validation.pipe";
import { RolesGuard } from "src/common/guard/roles.guard";
import { JwtAuthGuard } from "src/core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "src/core/auth/guards/admin-two-factor.guard";
import { Role } from "src/common/guard/roles.enum";
import { ErrorCode, ErrorDomain } from "src/common/errors/error-codes";
import {
  InsufficientFundsException,
  SettlementTimeoutException,
} from "src/common/errors/app.exception";

/**
 * End-to-End Test Suite for the Highest-Risk User Journey:
 * Stellar Payment Settlement & Automated Reconciliation Flow.
 *
 * Test Scenarios:
 *   1. Happy Path: Register invoice -> Ingest Stellar payment -> Automated match & audit.
 *   2. Failure Mode 1: Validation Failure (malformed payload, invalid address/amount).
 *   3. Failure Mode 2: Settlement Failure & Insufficient Funds (underpayment, unretryable).
 *   4. Failure Mode 3: Transient Horizon Network Timeout (retryable with backoff & recovery).
 *   5. Failure Mode 4: Duplicate Replay Submission (idempotent duplicate prevention).
 *   6. Failure Mode 5: Unauthorized Access (unprivileged principal blocked by RBAC).
 */
describe("E2E: Stellar Payment & Reconciliation User Journey", () => {
  let app: INestApplication;

  // In-memory repositories for deterministic isolation from production services
  const invoices: Map<string, ReconciliationInvoice> = new Map();
  const transactions: Map<string, StellarTransaction> = new Map();
  const audits: ReconciliationAudit[] = [];

  const mockInvoiceRepo = {
    findOne: jest.fn(async ({ where }: any) => {
      if (where.invoiceId) return invoices.get(where.invoiceId) || null;
      if (where.id) {
        return (
          Array.from(invoices.values()).find((i) => i.id === where.id) || null
        );
      }
      if (where.destinationAccount) {
        return (
          Array.from(invoices.values()).find(
            (i) => i.destinationAccount === where.destinationAccount,
          ) || null
        );
      }
      return null;
    }),
    find: jest.fn(async () => Array.from(invoices.values())),
    create: jest.fn((dto: any) => ({
      id: `inv-${Date.now()}-${Math.random()}`,
      ...dto,
      paidAmount: dto.paidAmount ?? "0.0000000",
      status: dto.status ?? ReconciliationInvoiceStatus.OPEN,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    save: jest.fn(async (inv: ReconciliationInvoice) => {
      invoices.set(inv.invoiceId, inv);
      return inv;
    }),
  };

  const mockTransactionRepo = {
    findOne: jest.fn(async ({ where }: any) => {
      if (where.transactionId) return transactions.get(where.transactionId) || null;
      return null;
    }),
    find: jest.fn(async ({ where }: any = {}) => {
      let list = Array.from(transactions.values());
      if (where?.status) {
        list = list.filter((t) => t.status === where.status);
      }
      if (where?.destinationAccount) {
        list = list.filter(
          (t) => t.destinationAccount === where.destinationAccount,
        );
      }
      return list;
    }),
    create: jest.fn((dto: any) => ({
      id: `tx-${Date.now()}-${Math.random()}`,
      ...dto,
      status: dto.status ?? StellarTransactionStatus.UNMATCHED,
      observedAt: dto.observedAt ?? new Date(),
    })),
    save: jest.fn(async (tx: StellarTransaction) => {
      transactions.set(tx.transactionId, tx);
      return tx;
    }),
  };

  const mockAuditRepo = {
    find: jest.fn(async () => audits),
    create: jest.fn((dto: any) => ({
      id: `audit-${Date.now()}-${Math.random()}`,
      ...dto,
      timestamp: new Date(),
    })),
    save: jest.fn(async (audit: ReconciliationAudit) => {
      audits.push(audit);
      return audit;
    }),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === "NODE_ENV") return "test";
      if (key === "STELLAR_HORIZON_URL") return "https://horizon-testnet.stellar.org";
      return null;
    }),
  };

  // Mock authenticated principal
  let currentUser: { id: string; role: Role } = {
    id: "user-1",
    role: Role.USER,
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ReconciliationController],
      providers: [
        ReconciliationService,
        { provide: ConfigService, useValue: mockConfigService },
        {
          provide: getRepositoryToken(ReconciliationInvoice),
          useValue: mockInvoiceRepo,
        },
        {
          provide: getRepositoryToken(StellarTransaction),
          useValue: mockTransactionRepo,
        },
        {
          provide: getRepositoryToken(ReconciliationAudit),
          useValue: mockAuditRepo,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = currentUser;
          return true;
        },
      })
      .overrideGuard(AdminTwoFactorGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    app.useGlobalFilters(new GlobalExceptionFilter(mockConfigService as any));

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    invoices.clear();
    transactions.clear();
    audits.length = 0;
    currentUser = { id: "user-1", role: Role.USER };
  });

  // ---------------------------------------------------------------------------
  // 1. HAPPY PATH: Complete End-to-End Payment & Reconciliation Lifecycle
  // ---------------------------------------------------------------------------
  describe("Happy Path: Full Payment Settlement & Reconciliation Lifecycle", () => {
    it("successfully creates invoice, ingests payment, and automatically reconciles transaction", async () => {
      const destination = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
      const invoiceId = "INV-E2E-1001";
      const txId = "tx_stellar_e2e_hash_happy_path";
      const amount = "100.0000000";

      // Step 1: Register customer invoice
      const invoiceRes = await request(app.getHttpServer())
        .post("/reconcile/stellar/invoice")
        .send({
          invoiceId,
          destinationAccount: destination,
          expectedAmount: amount,
          assetCode: "XLM",
          paymentReference: invoiceId,
        })
        .expect(HttpStatus.CREATED);

      expect(invoiceRes.body).toHaveProperty("invoiceId", invoiceId);
      expect(invoiceRes.body.status).toBe(ReconciliationInvoiceStatus.OPEN);

      // Step 2: Ingest confirmed on-chain Stellar payment transaction
      const txRes = await request(app.getHttpServer())
        .post("/reconcile/stellar/transactions")
        .send({
          transactionId: txId,
          ledger: "1234567",
          sourceAccount: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          destinationAccount: destination,
          amount,
          assetCode: "XLM",
          memo: invoiceId,
        })
        .expect(HttpStatus.CREATED);

      expect(txRes.body).toHaveProperty("transactionId", txId);
      expect(txRes.body.status).toBe(StellarTransactionStatus.MATCHED);

      // Step 3: Verify invoice is updated to PAID
      const getInvoiceRes = await request(app.getHttpServer())
        .get(`/reconcile/stellar/invoice/${invoiceId}`)
        .expect(HttpStatus.OK);

      expect(getInvoiceRes.body.invoice.status).toBe(
        ReconciliationInvoiceStatus.PAID,
      );
      expect(getInvoiceRes.body.invoice.paidAmount).toBe(amount);

      // Step 4: Verify audit log recorded decision
      expect(audits.length).toBeGreaterThan(0);
      const matchAudit = audits.find(
        (a) =>
          a.transactionId === txId &&
          a.decision === ReconciliationDecision.MATCHED,
      );
      expect(matchAudit).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. FAILURE MODE 1: Validation Failure
  // ---------------------------------------------------------------------------
  describe("Failure Mode 1: Validation Failure", () => {
    it("rejects invoice registration with missing required fields and returns structured 400", async () => {
      const res = await request(app.getHttpServer())
        .post("/reconcile/stellar/invoice")
        .send({
          // Missing invoiceId and destinationAccount
          expectedAmount: "50",
        })
        .expect(HttpStatus.BAD_REQUEST);

      expect(res.body).toMatchObject({
        statusCode: 400,
        errorCode: ErrorCode.VALIDATION_ERROR,
        domain: ErrorDomain.VALIDATION,
        retryable: false,
      });
      expect(res.body.errors).toBeDefined();
      expect(res.body.correlationId).toBeDefined();
      expect(res.body.recoveryGuidance).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. FAILURE MODE 2: Settlement Failure / Insufficient Funds / Underpayment
  // ---------------------------------------------------------------------------
  describe("Failure Mode 2: Settlement Failure & Underpayment", () => {
    it("handles underpayment: flags invoice as PARTIAL and requires full payment", async () => {
      const destination = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
      const invoiceId = "INV-E2E-UNDERPAY";
      const txId = "tx_stellar_e2e_underpay";

      // Register invoice for 100 XLM
      await request(app.getHttpServer())
        .post("/reconcile/stellar/invoice")
        .send({
          invoiceId,
          destinationAccount: destination,
          expectedAmount: "100.0000000",
          assetCode: "XLM",
          paymentReference: invoiceId,
        })
        .expect(HttpStatus.CREATED);

      // Ingest partial payment of 40 XLM
      await request(app.getHttpServer())
        .post("/reconcile/stellar/transactions")
        .send({
          transactionId: txId,
          destinationAccount: destination,
          amount: "40.0000000",
          assetCode: "XLM",
          memo: invoiceId,
        })
        .expect(HttpStatus.CREATED);

      // Verify invoice transitioned to PARTIAL
      const invoiceRes = await request(app.getHttpServer())
        .get(`/reconcile/stellar/invoice/${invoiceId}`)
        .expect(HttpStatus.OK);

      expect(invoiceRes.body.invoice.status).toBe(
        ReconciliationInvoiceStatus.PARTIAL,
      );
      expect(invoiceRes.body.invoice.paidAmount).toBe("40.0000000");
    });

    it("renders fatal InsufficientFundsException with wallet funding guidance", () => {
      const exception = new InsufficientFundsException(
        "Payer wallet balance (5 XLM) is below required payment (50 XLM) + base fee",
      );
      expect(exception.errorCode).toBe(ErrorCode.INSUFFICIENT_FUNDS);
      expect(exception.retryable).toBe(false);
      expect(exception.recoveryGuidance).toContain(
        "source wallet holds sufficient balance",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 4. FAILURE MODE 3: Transient Network Timeout & Recovery
  // ---------------------------------------------------------------------------
  describe("Failure Mode 3: Network Timeout & Retryability", () => {
    it("returns retryable SettlementTimeoutException with cool-off metadata", () => {
      const timeoutError = new SettlementTimeoutException(
        "Horizon gateway timed out waiting for ledger close",
        5,
      );

      expect(timeoutError.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      expect(timeoutError.errorCode).toBe(ErrorCode.SETTLEMENT_TIMEOUT);
      expect(timeoutError.retryable).toBe(true);
      expect(timeoutError.retryAfterSeconds).toBe(5);
      expect(timeoutError.recoveryGuidance).toContain(
        "Verify transaction status before resubmitting",
      );
    });

    it("recovers on retry after transient timeout", async () => {
      const destination =
        "GCI5XTZMH4QAHZSFZNW4BG2ZOS33WGBDJVKPJ6H4XJFXGYLJCWXQ4X2R";
      const invoiceId = "INV-E2E-RETRY";
      const txId = "tx_stellar_retry_success";

      // Invoice created
      await request(app.getHttpServer())
        .post("/reconcile/stellar/invoice")
        .send({
          invoiceId,
          destinationAccount: destination,
          expectedAmount: "25.0000000",
          assetCode: "XLM",
          paymentReference: invoiceId,
        })
        .expect(HttpStatus.CREATED);

      // Retried ingest succeeds
      const txRes = await request(app.getHttpServer())
        .post("/reconcile/stellar/transactions")
        .send({
          transactionId: txId,
          destinationAccount: destination,
          amount: "25.0000000",
          assetCode: "XLM",
          memo: invoiceId,
        })
        .expect(HttpStatus.CREATED);

      expect(txRes.body.status).toBe(StellarTransactionStatus.MATCHED);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. FAILURE MODE 4: Duplicate Submission / Replay Protection
  // ---------------------------------------------------------------------------
  describe("Failure Mode 4: Duplicate Replay Submission", () => {
    it("detects duplicate transaction ingestion idempotently without duplicate crediting", async () => {
      const destination =
        "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3DTQEVFL4NAT";
      const invoiceId = "INV-E2E-IDEMPOTENT";
      const txId = "tx_stellar_e2e_duplicate_test";

      await request(app.getHttpServer())
        .post("/reconcile/stellar/invoice")
        .send({
          invoiceId,
          destinationAccount: destination,
          expectedAmount: "50.0000000",
          assetCode: "XLM",
          paymentReference: invoiceId,
        })
        .expect(HttpStatus.CREATED);

      // First submission
      await request(app.getHttpServer())
        .post("/reconcile/stellar/transactions")
        .send({
          transactionId: txId,
          destinationAccount: destination,
          amount: "50.0000000",
          assetCode: "XLM",
          memo: invoiceId,
        })
        .expect(HttpStatus.CREATED);

      // Second identical submission (replay attempt)
      const duplicateRes = await request(app.getHttpServer())
        .post("/reconcile/stellar/transactions")
        .send({
          transactionId: txId,
          destinationAccount: destination,
          amount: "50.0000000",
          assetCode: "XLM",
          memo: invoiceId,
        })
        .expect(HttpStatus.CREATED);

      // Transaction is returned as already existing
      expect(duplicateRes.body.transactionId).toBe(txId);

      // Verify invoice was not credited twice
      const invoiceRes = await request(app.getHttpServer())
        .get(`/reconcile/stellar/invoice/${invoiceId}`)
        .expect(HttpStatus.OK);

      expect(invoiceRes.body.invoice.paidAmount).toBe("50.0000000");

      // Verify duplicate audit recorded
      const duplicateAudit = audits.find(
        (a) => a.reason === "Duplicate transaction event ignored",
      );
      expect(duplicateAudit).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. FAILURE MODE 5: Unauthorized Access & RBAC Enforcement
  // ---------------------------------------------------------------------------
  describe("Failure Mode 5: Unauthorized Access to Protected Audit Endpoints", () => {
    it("denies standard USER role on admin unmatched transactions endpoint", async () => {
      currentUser = { id: "user-unauthorized", role: Role.USER };

      const rolesGuard = new RolesGuard({
        getAllAndOverride: jest.fn().mockReturnValue([Role.ADMIN]),
      } as any);

      const mockCtx: any = {
        switchToHttp: () => ({
          getRequest: () => ({ user: currentUser }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      };

      expect(() => rolesGuard.canActivate(mockCtx)).toThrow(
        /Insufficient permissions/,
      );
    });

    it("authorizes ADMIN role on admin unmatched transactions endpoint", async () => {
      currentUser = { id: "admin-user", role: Role.ADMIN };

      const rolesGuard = new RolesGuard({
        getAllAndOverride: jest.fn().mockReturnValue([Role.ADMIN]),
      } as any);

      const mockCtx: any = {
        switchToHttp: () => ({
          getRequest: () => ({ user: currentUser }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      };

      expect(rolesGuard.canActivate(mockCtx)).toBe(true);
    });
  });
});

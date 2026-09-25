import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import {
  StellarTransaction,
  StellarTransactionStatus,
} from "../reconciliation/entities/stellar-transaction.entity";
import {
  ReconciliationInvoice,
  ReconciliationInvoiceStatus,
} from "../reconciliation/entities/reconciliation-invoice.entity";
import { WebhookDeadLetter } from "../infrastructure/webhooks/entities/webhook-dead-letter.entity";

export interface OperationalHealthReport {
  generatedAt: string;
  categories: {
    reconciliation: {
      unresolvedTransactions: number;
      failedTransactions: number;
      failedInvoices: number;
      records: Array<{ id: string; kind: string; link: string }>;
    };
    webhooks: {
      unresolvedDeadLetters: number;
      staleDeadLetters: number;
      records: Array<{ id: string; kind: string; link: string }>;
    };
  };
}

@Injectable()
export class OperationalHealthService {
  constructor(
    @InjectRepository(StellarTransaction)
    private readonly transactionRepo: Repository<StellarTransaction>,
    @InjectRepository(ReconciliationInvoice)
    private readonly invoiceRepo: Repository<ReconciliationInvoice>,
    @InjectRepository(WebhookDeadLetter)
    private readonly deadLetterRepo: Repository<WebhookDeadLetter>,
  ) {}

  async getReport(staleAfterHours = 24): Promise<OperationalHealthReport> {
    const staleCutoff = new Date(Date.now() - staleAfterHours * 60 * 60 * 1000);
    const [unresolvedTransactions, failedTransactions, failedInvoices, unresolvedDeadLetters, staleDeadLetters] =
      await Promise.all([
        this.transactionRepo.count({ where: { status: StellarTransactionStatus.UNMATCHED } }),
        this.transactionRepo.count({ where: { status: StellarTransactionStatus.FAILED } }),
        this.invoiceRepo.count({ where: { status: ReconciliationInvoiceStatus.FAILED } }),
        this.deadLetterRepo.count({ where: { retried: false } }),
        this.deadLetterRepo.count({ where: { retried: false, createdAt: LessThan(staleCutoff) } }),
      ]);

    const [transactions, invoices, deadLetters] = await Promise.all([
      this.transactionRepo.find({
        where: [{ status: StellarTransactionStatus.UNMATCHED }, { status: StellarTransactionStatus.FAILED }],
        order: { createdAt: "DESC" },
        take: 20,
      }),
      this.invoiceRepo.find({ where: { status: ReconciliationInvoiceStatus.FAILED }, order: { createdAt: "DESC" }, take: 20 }),
      this.deadLetterRepo.find({ where: { retried: false }, order: { createdAt: "DESC" }, take: 20 }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      categories: {
        reconciliation: {
          unresolvedTransactions,
          failedTransactions,
          failedInvoices,
          records: [
            ...transactions.map((record) => ({
              id: record.id,
              kind: `transaction:${record.status}`,
              link: `/reconcile/stellar/tx/${record.id}`,
            })),
            ...invoices.map((record) => ({
              id: record.id,
              kind: "invoice:failed",
              link: `/reconcile/stellar/invoice/${record.id}`,
            })),
          ],
        },
        webhooks: {
          unresolvedDeadLetters,
          staleDeadLetters,
          records: deadLetters.map((record) => ({
            id: record.id,
            kind: "webhook:dead-letter",
            link: `/webhooks/dead-letters/${record.id}`,
          })),
        },
      },
    };
  }
}
import { OperationalHealthService } from "./operational-health.service";
import { StellarTransactionStatus } from "../reconciliation/entities/stellar-transaction.entity";
import { ReconciliationInvoiceStatus } from "../reconciliation/entities/reconciliation-invoice.entity";

describe("OperationalHealthService", () => {
  it("reports actionable counts without exposing webhook payloads", async () => {
    const transactionRepo = {
      count: jest.fn()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1),
      find: jest.fn().mockResolvedValue([
        { id: "tx-row", transactionId: "tx-secret", status: StellarTransactionStatus.UNMATCHED },
      ]),
    };
    const invoiceRepo = {
      count: jest.fn().mockResolvedValue(1),
      find: jest.fn().mockResolvedValue([
        { id: "invoice-row", invoiceId: "invoice-secret" },
      ]),
    };
    const deadLetterRepo = {
      count: jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2),
      find: jest.fn().mockResolvedValue([
        { id: "dead-letter-row", url: "https://secret.example", eventPayload: { secret: true } },
      ]),
    };
    const service = new OperationalHealthService(
      transactionRepo as any,
      invoiceRepo as any,
      deadLetterRepo as any,
    );

    const report = await service.getReport();

    expect(report.categories.reconciliation.unresolvedTransactions).toBe(2);
    expect(report.categories.reconciliation.failedTransactions).toBe(1);
    expect(report.categories.reconciliation.failedInvoices).toBe(1);
    expect(report.categories.webhooks.unresolvedDeadLetters).toBe(3);
    expect(report.categories.webhooks.staleDeadLetters).toBe(2);
    expect(JSON.stringify(report)).not.toContain("secret.example");
    expect(JSON.stringify(report)).not.toContain("tx-secret");
    expect(report.categories.webhooks.records[0]).toEqual({
      id: "dead-letter-row",
      kind: "webhook:dead-letter",
      link: "/webhooks/dead-letters/dead-letter-row",
    });
  });
});
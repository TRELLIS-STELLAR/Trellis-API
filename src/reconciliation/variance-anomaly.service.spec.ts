import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { VarianceAnomalyService } from "./variance-anomaly.service";

describe("VarianceAnomalyService", () => {
  function makeService(values: Record<string, string> = {}) {
    const config = new ConfigService({
      RECONCILIATION_VARIANCE_ALERT_THRESHOLD: "0.0100000",
      AUTO_REIMBURSEMENT_MAX_LIMIT: "1.0000000",
      ...values,
    });
    return { service: new VarianceAnomalyService(config, new EventEmitter2()), config };
  }

  it("queues micro discrepancies below both safety thresholds", () => {
    const { service } = makeService();
    expect(service.evaluate("invoice-1", "10.0000000", "9.9950000")).toMatchObject({
      variance: "0.0050000",
      disposition: "auto_reimburse",
      alertRequired: false,
      auditRequired: true,
    });
  });

  it("requires manual review and an alert for material drift", () => {
    const { service } = makeService();
    expect(service.evaluate("invoice-2", "10.0000000", "9.9700000")).toMatchObject({
      variance: "0.0300000",
      disposition: "manual_review",
      alertRequired: true,
    });
  });

  it("never auto reimburses a variance at or above the configured cap", () => {
    const { service } = makeService({
      RECONCILIATION_VARIANCE_ALERT_THRESHOLD: "2.0000000",
      AUTO_REIMBURSEMENT_MAX_LIMIT: "0.0100000",
    });
    expect(service.evaluate("invoice-3", "1.0000000", "0.9800000").disposition).toBe("manual_review");
  });
});

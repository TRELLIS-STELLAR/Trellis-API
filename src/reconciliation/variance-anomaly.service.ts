import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";

const SCALE = 7n;
const SCALE_FACTOR = 10n ** SCALE;

export type VarianceDisposition = "within_tolerance" | "auto_reimburse" | "manual_review";

export interface VarianceEvaluation {
  referenceId: string;
  expectedAmount: string;
  actualAmount: string;
  variance: string;
  disposition: VarianceDisposition;
  alertRequired: boolean;
  auditRequired: boolean;
}

/**
 * Applies one deterministic policy to every reconciliation variance. The
 * service emits an event for the notification adapters (Slack, PagerDuty, or
 * email) and never performs a reimbursement itself; a separately authorized
 * worker can consume the auto-reimbursement event and leave an audit trail.
 */
@Injectable()
export class VarianceAnomalyService {
  private readonly logger = new Logger(VarianceAnomalyService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  evaluate(referenceId: string, expectedAmount: string, actualAmount: string): VarianceEvaluation {
    const expected = this.toUnits(expectedAmount);
    const actual = this.toUnits(actualAmount);
    const absoluteVariance = expected >= actual ? expected - actual : actual - expected;
    const alertThreshold = this.toUnits(
      this.config.get<string>("RECONCILIATION_VARIANCE_ALERT_THRESHOLD", "0.0100000"),
    );
    const reimbursementCap = this.toUnits(
      this.config.get<string>("AUTO_REIMBURSEMENT_MAX_LIMIT", "1.0000000"),
    );

    const disposition: VarianceDisposition =
      absoluteVariance === 0n
        ? "within_tolerance"
        : absoluteVariance < reimbursementCap && absoluteVariance < alertThreshold
          ? "auto_reimburse"
          : "manual_review";
    const evaluation: VarianceEvaluation = {
      referenceId,
      expectedAmount: this.fromUnits(expected),
      actualAmount: this.fromUnits(actual),
      variance: this.fromUnits(absoluteVariance),
      disposition,
      alertRequired: absoluteVariance >= alertThreshold,
      auditRequired: disposition !== "within_tolerance",
    };

    if (evaluation.alertRequired) {
      this.events.emit("reconciliation.variance.alert", evaluation);
      this.logger.error(
        `Reconciliation variance ${evaluation.variance} for ${referenceId} requires ${disposition}`,
      );
    } else if (disposition === "auto_reimburse") {
      this.events.emit("reconciliation.variance.auto_reimburse", evaluation);
      this.logger.warn(`Micro-variance ${evaluation.variance} queued for ${referenceId}`);
    }
    return evaluation;
  }

  private toUnits(value: string): bigint {
    const normalized = String(value).trim();
    if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error(`Invalid reconciliation amount: ${value}`);
    const [whole, fraction = ""] = normalized.split(".");
    return BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(Number(SCALE), "0").slice(0, Number(SCALE)));
  }

  private fromUnits(units: bigint): string {
    const whole = units / SCALE_FACTOR;
    const fraction = (units % SCALE_FACTOR).toString().padStart(Number(SCALE), "0");
    return `${whole}.${fraction}`;
  }
}

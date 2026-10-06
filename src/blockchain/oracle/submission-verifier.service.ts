import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { AuditLogService } from "src/infrastructure/audit/audit-log.service";
import { telemetryService } from "src/observability/telemetry.service";
import { SubmissionHistoryService } from "./services/submission-history.service";
import {
  OracleVerificationError,
  StellarOracleAdapter,
} from "./services/stellar-oracle.adapter";

@Injectable()
export class SubmissionVerifierService implements OnModuleDestroy {
  private readonly logger = new Logger(SubmissionVerifierService.name);
  private readonly pollingInterval = 15000;
  private timer?: ReturnType<typeof setInterval>;
  private verifying = false;

  constructor(
    private readonly auditLogService: AuditLogService,
    private readonly submissionHistory: SubmissionHistoryService,
    private readonly adapter: StellarOracleAdapter,
  ) {}

  start() {
    if (!this.adapter.isEnabled) {
      this.logger.warn(
        "Submission verifier disabled: configure SOROBAN_RPC_URL and ORACLE_CONTRACT_ADDRESS",
      );
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.verifyCycle().catch((error) =>
        this.logger.error("Oracle verification cycle failed", error),
      );
    }, this.pollingInterval);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async verifyCycle() {
    if (this.verifying) return;
    this.verifying = true;
    const endTelemetry = telemetryService.startTimer(
      "oracle.verify_submission",
      {
        actorType: "service_actor",
        funnel: "oracle_sync",
        step: "submission_verify",
      },
    );
    const result = {
      timestamp: new Date(),
      totalChecked: 0,
      mismatches: [] as Array<{ id: string; error: string }>,
      missing: [] as Array<{ id: string; error: string }>,
      duplicates: [] as string[],
    };
    try {
      const submissions = await this.submissionHistory.pending();
      for (const submission of submissions) {
        result.totalChecked++;
        try {
          await this.adapter.verify(submission);
          await this.submissionHistory.setResult(submission.id, "verified");
        } catch (error) {
          if (!(error instanceof OracleVerificationError)) throw error;
          if (
            [
              "RPC_UNAVAILABLE",
              "RPC_ERROR",
              "NOT_CONFIGURED",
              "NETWORK_MISMATCH",
            ].includes(error.code)
          )
            throw error;
          if (error.retryable) {
            await this.submissionHistory.defer(submission.id, error.message);
            result.missing.push({ id: submission.id, error: error.message });
          } else {
            await this.submissionHistory.setResult(
              submission.id,
              "rejected",
              error.message,
            );
            result.mismatches.push({ id: submission.id, error: error.message });
          }
        }
      }
      await this.auditLogService.recordVerification(result);
      const failure = result.mismatches.length + result.missing.length > 0;
      if (failure)
        this.logger.warn(
          `Oracle verification needs attention: ${JSON.stringify(result)}`,
        );
      endTelemetry(
        failure ? "failure" : "success",
        failure ? "ORACLE_SUBMISSION_MISMATCH" : undefined,
        {
          mismatchesCount: result.mismatches.length,
          missingCount: result.missing.length,
          totalChecked: result.totalChecked,
        },
      );
      return result;
    } catch (error) {
      endTelemetry("failure", "ORACLE_VERIFICATION_ERROR", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.verifying = false;
    }
  }

  getStatus() {
    return {
      running: !!this.timer,
      enabled: this.adapter.isEnabled,
      interval: this.pollingInterval,
    };
  }
}

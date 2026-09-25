import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditLogService } from "src/infrastructure/audit/audit-log.service";
import { telemetryService } from "src/observability/telemetry.service";

interface OnChainSubmission {
  id: string;
  hash: string;
  timestamp: number;
}

interface OffChainSubmission {
  id: string;
  hash: string;
  createdAt: Date;
}

@Injectable()
export class SubmissionVerifierService {
  private readonly logger = new Logger(SubmissionVerifierService.name);

  private pollingInterval = 15000; // 15s
  private isRunning = false;
  private isEnabled = false;

  constructor(
    private readonly auditLogService: AuditLogService,
    private readonly configService: ConfigService,
  ) {
    // Only enable if blockchain configuration is present
    const rpcUrl = this.configService.get<string>("ETH_RPC_URL");
    const contractAddress = this.configService.get<string>(
      "ORACLE_CONTRACT_ADDRESS",
    );
    this.isEnabled = !!(rpcUrl && contractAddress);
  }

  // -------------------------------------
  // START POLLING
  // -------------------------------------
  start() {
    if (!this.isEnabled) {
      this.logger.warn(
        "SubmissionVerifierService is disabled: Missing required blockchain configuration. Set ETH_RPC_URL and ORACLE_CONTRACT_ADDRESS to enable.",
      );
      return;
    }
    if (this.isRunning) return;

    this.isRunning = true;
    this.logger.log("Starting submission verifier...");

    setInterval(() => this.verifyCycle(), this.pollingInterval);
  }

  // -------------------------------------
  // VERIFY LOOP
  // -------------------------------------
  async verifyCycle() {
    const endTelemetry = telemetryService.startTimer("oracle.verify_submission", {
      actorType: "service_actor",
      funnel: "oracle_sync",
      step: "submission_verify",
    });

    try {
      const onChain = await this.fetchOnChainSubmissions();
      const offChain = await this.fetchOffChainSubmissions();

      const result = this.compare(onChain, offChain);

      await this.auditLogService.recordVerification(result);

      if (result.mismatches.length > 0) {
        await this.triggerAlerts(result);
        endTelemetry("failure", "ORACLE_SUBMISSION_MISMATCH", {
          mismatchesCount: result.mismatches.length,
          totalChecked: result.totalChecked,
        });
      } else {
        endTelemetry("success", undefined, {
          totalChecked: result.totalChecked,
        });
      }
      return result;
    } catch (err) {
      this.logger.error("Verification failed", err);
      endTelemetry("failure", "ORACLE_VERIFICATION_ERROR", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // -------------------------------------
  // FETCH ON-CHAIN (MOCK / ADAPTER)
  // -------------------------------------
  private async fetchOnChainSubmissions(): Promise<OnChainSubmission[]> {
    // TODO: Replace with actual blockchain adapter (ethers/web3)
    return [{ id: "1", hash: "abc", timestamp: Date.now() }];
  }

  // -------------------------------------
  // FETCH OFF-CHAIN
  // -------------------------------------
  private async fetchOffChainSubmissions(): Promise<OffChainSubmission[]> {
    // TODO: Replace with DB query
    return [{ id: "1", hash: "abc", createdAt: new Date() }];
  }

  // -------------------------------------
  // CORE COMPARISON LOGIC
  // -------------------------------------
  private compare(
    onChain: OnChainSubmission[],
    offChain: OffChainSubmission[],
  ) {
    const mismatches = [];
    const missing = [];
    const duplicates = [];

    const offChainMap = new Map(offChain.map((o) => [o.id, o]));

    for (const on of onChain) {
      const off = offChainMap.get(on.id);

      if (!off) {
        missing.push(on);
        continue;
      }

      if (off.hash !== on.hash) {
        mismatches.push({
          id: on.id,
          onChainHash: on.hash,
          offChainHash: off.hash,
        });
      }
    }

    return {
      timestamp: new Date(),
      totalChecked: onChain.length,
      mismatches,
      missing,
      duplicates,
    };
  }

  // -------------------------------------
  // ALERTING
  // -------------------------------------
  private async triggerAlerts(result: any) {
    // 👉 Replace with real integrations
    console.warn("ALERT: Submission mismatch detected", result);

    // Example webhook
    // await axios.post(WEBHOOK_URL, result);
  }

  // -------------------------------------
  // PUBLIC STATUS
  // -------------------------------------
  getStatus() {
    return {
      running: this.isRunning,
      interval: this.pollingInterval,
    };
  }
}

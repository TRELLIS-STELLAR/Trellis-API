import { ForbiddenException, Logger } from "@nestjs/common";
import { Role, normalizeRole } from "../common/guard/roles.enum";
import {
  DEFAULT_TTL_POLICY,
  LedgerTtlGateway,
  RepairActor,
  TrackedEntry,
  TtlPolicy,
} from "./storage-ttl.types";
import { validatePolicy, assessEntry } from "./storage-ttl.policy";
import {
  ArchivalContext,
  ArchivalResult,
  CandidateEntry,
  ExpirationScanReport,
  IProactiveArchivalHook,
  ProactiveArchivalRunSummary,
} from "./storage-archival.types";

export interface StorageTtlScannerOptions {
  policy?: TtlPolicy;
  /** Ledgers remaining before entry is considered an impending expiration archival candidate. Default: criticalBelowLedgers + 5000 */
  proactiveArchivalThresholdLedgers?: number;
  /** Max entries to proactively archive in a single execution sweep. Default: 25 */
  maxArchivalsPerRun?: number;
  /** Max retry attempts for transient hook failures. Default: 3 */
  maxAttempts?: number;
  /** Exponential backoff base ms. Default: 100ms */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Logger, "log" | "warn" | "error">;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Storage TTL Expiration Scanner with Proactive Archival Hook (#521).
 *
 * Scans on-chain storage entries for impending TTL expiration and proactively
 * archives qualifying persistent or temporary state to cold storage before
 * ledger eviction occurs.
 */
export class StorageTtlExpirationScanner {
  private readonly policy: TtlPolicy;
  private readonly archivalThreshold: number;
  private readonly maxArchivalsPerRun: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Logger, "log" | "warn" | "error">;

  constructor(
    private readonly gateway: LedgerTtlGateway,
    private readonly archivalHook: IProactiveArchivalHook,
    options: StorageTtlScannerOptions = {},
  ) {
    this.policy = validatePolicy(options.policy ?? DEFAULT_TTL_POLICY);
    this.archivalThreshold =
      options.proactiveArchivalThresholdLedgers ??
      this.policy.criticalBelowLedgers + 5000;
    this.maxArchivalsPerRun = Math.max(1, options.maxArchivalsPerRun ?? 25);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.backoffMs = options.backoffMs ?? 100;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? new Logger(StorageTtlExpirationScanner.name);
  }

  /**
   * Scans tracked entries and identifies candidates approaching expiration.
   * Read-only and safe for monitoring callers.
   */
  async scanExpirationCandidates(
    entries: TrackedEntry[],
  ): Promise<ExpirationScanReport> {
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.key)) throw new Error(`Duplicate tracked key: ${e.key}`);
      seen.add(e.key);
    }

    const currentLedger = await this.gateway.getCurrentLedger();
    const ttls = entries.length
      ? await this.gateway.getTtls(entries.map((e) => e.key))
      : {};

    const candidates: CandidateEntry[] = [];
    let healthyCount = 0;
    let unhealthyCount = 0;
    let archivedCount = 0;
    let expiredCount = 0;

    for (const entry of entries) {
      const ttl = ttls[entry.key];
      const assessment = assessEntry(entry, ttl, currentLedger, this.policy);

      if (assessment.health === "healthy") {
        healthyCount++;
      } else if (assessment.health === "archived") {
        archivedCount++;
      } else if (assessment.health === "expired") {
        expiredCount++;
      } else {
        unhealthyCount++;
      }

      // Check candidate qualification for proactive archival
      if (
        ttl &&
        !ttl.archived &&
        ttl.liveUntilLedger != null &&
        ttl.liveUntilLedger >= currentLedger
      ) {
        const remaining = ttl.liveUntilLedger - currentLedger;
        if (remaining <= this.archivalThreshold) {
          const isTemporary = entry.durability === "temporary";
          const urgency =
            remaining <= this.policy.criticalBelowLedgers
              ? "critical"
              : remaining <= this.archivalThreshold / 2
                ? "high"
                : "medium";

          candidates.push({
            entry,
            health: assessment.health,
            remainingLedgers: remaining,
            urgency,
            reason: isTemporary
              ? "temporary_entry_preservation"
              : "impending_expiration",
          });
        }
      }
    }

    return {
      currentLedger,
      totalTracked: entries.length,
      archivalCandidates: candidates,
      unhealthyCount,
      healthyCount,
      archivedCount,
      expiredCount,
      scanTimestamp: new Date().toISOString(),
    };
  }

  /**
   * Executes proactive archival on candidate entries approaching expiration.
   * Requires ADMIN or SYSTEM_OPERATOR role.
   */
  async executeProactiveArchival(
    entries: TrackedEntry[],
    actor: RepairActor,
    options: { dryRun?: boolean } = {},
  ): Promise<ProactiveArchivalRunSummary> {
    this.assertAuthorizedOperator(actor);
    const dryRun = options.dryRun ?? false;

    const report = await this.scanExpirationCandidates(entries);
    const candidates = report.archivalCandidates;

    const toProcess = candidates.slice(0, this.maxArchivalsPerRun);
    const deferred = candidates.slice(this.maxArchivalsPerRun);

    const results: ProactiveArchivalRunSummary["results"] = [];

    for (const candidate of toProcess) {
      if (dryRun) {
        results.push({
          key: candidate.entry.key,
          outcome: "dry-run",
          attempts: 0,
          detail: `Dry-run: candidate for proactive archival (${candidate.remainingLedgers} ledgers remain, urgency: ${candidate.urgency})`,
        });
        continue;
      }

      const res = await this.archiveEntryWithRetry(candidate, report.currentLedger);
      results.push(res);
    }

    for (const def of deferred) {
      results.push({
        key: def.entry.key,
        outcome: "skipped",
        attempts: 0,
        detail: `Deferred: run cap reached (${this.maxArchivalsPerRun} max per run)`,
      });
    }

    const count = (o: ProactiveArchivalRunSummary["results"][0]["outcome"]) =>
      results.filter((r) => r.outcome === o).length;

    const summary: ProactiveArchivalRunSummary = {
      dryRun,
      currentLedger: report.currentLedger,
      candidatesCount: candidates.length,
      archivedCount: count("archived"),
      failedCount: count("failed"),
      skippedCount: count("skipped"),
      deferredCount: deferred.length,
      results,
    };

    this.logger.log(
      `Proactive archival run by ${actor.id}: dryRun=${dryRun} candidates=${candidates.length} archived=${summary.archivedCount} failed=${summary.failedCount} deferred=${summary.deferredCount}`,
    );

    return summary;
  }

  private async archiveEntryWithRetry(
    candidate: CandidateEntry,
    currentLedger: number,
  ): Promise<ProactiveArchivalRunSummary["results"][0]> {
    let attempts = 0;
    let lastError = "unknown error";

    const ttlInfo = await this.gateway.getTtls([candidate.entry.key]);
    const liveTtl = ttlInfo[candidate.entry.key];

    if (!liveTtl || liveTtl.archived || (liveTtl.liveUntilLedger ?? -1) < currentLedger) {
      return {
        key: candidate.entry.key,
        outcome: "skipped",
        attempts: 1,
        detail: "Entry already expired or archived on-chain before hook execution",
      };
    }

    const context: ArchivalContext = {
      entry: candidate.entry,
      ttl: liveTtl,
      currentLedger,
      remainingLedgers: (liveTtl.liveUntilLedger ?? 0) - currentLedger,
      reason: candidate.reason,
    };

    while (attempts < this.maxAttempts) {
      attempts++;
      try {
        const hookResult: ArchivalResult = await this.archivalHook.archive(context);

        if (!hookResult.success) {
          lastError = hookResult.error || "Archival hook reported failure";
          if (!hookResult.transient) {
            break; // Non-transient failure
          }
        } else {
          // Verification / Rollback step if hook provides verification
          if (
            this.archivalHook.verify &&
            hookResult.archiveLocation &&
            hookResult.digest
          ) {
            const verified = await this.archivalHook.verify(
              hookResult.archiveLocation,
              hookResult.digest,
            );
            if (!verified) {
              if (this.archivalHook.rollback) {
                await this.archivalHook.rollback(
                  candidate.entry.key,
                  hookResult.archiveLocation,
                );
              }
              throw new Error("Post-archival integrity verification failed");
            }
          }

          return {
            key: candidate.entry.key,
            outcome: "archived",
            location: hookResult.archiveLocation,
            digest: hookResult.digest,
            attempts,
            detail: `Proactively archived to ${hookResult.archiveLocation || "cold storage"}`,
          };
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      if (attempts < this.maxAttempts) {
        await this.sleep(this.backoffMs * 2 ** (attempts - 1));
      }
    }

    this.logger.error(
      `Proactive archival failed for ${candidate.entry.key} after ${attempts} attempts: ${lastError}`,
    );

    return {
      key: candidate.entry.key,
      outcome: "failed",
      attempts,
      detail: lastError,
    };
  }

  private assertAuthorizedOperator(actor: RepairActor): void {
    if (!actor || !actor.roles || !Array.isArray(actor.roles)) {
      throw new ForbiddenException(
        "Missing actor context or roles for proactive archival",
      );
    }
    const roles = actor.roles.map((r) => normalizeRole(r));
    const isAuthorized =
      roles.includes(Role.ADMIN) ||
      roles.some((r) => r.toUpperCase() === "SYSTEM_OPERATOR");
    if (!isAuthorized) {
      throw new ForbiddenException(
        "Only an ADMIN or SYSTEM_OPERATOR may trigger proactive storage archival",
      );
    }
  }
}

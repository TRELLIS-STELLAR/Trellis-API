import { TrackedEntry, EntryTtl, TtlPolicy, TtlHealth } from "./storage-ttl.types";

export type ArchivalTriggerReason =
  | "impending_expiration"
  | "policy_scheduled"
  | "pre_eviction_safeguard"
  | "temporary_entry_preservation";

export interface ArchivalContext {
  entry: TrackedEntry;
  ttl: EntryTtl;
  currentLedger: number;
  remainingLedgers: number;
  reason: ArchivalTriggerReason;
}

export interface ArchivalResult {
  key: string;
  success: boolean;
  archiveLocation?: string;
  digest?: string;
  archivedAtLedger: number;
  attempts: number;
  error?: string;
  transient?: boolean;
}

export interface IProactiveArchivalHook {
  readonly name: string;
  archive(context: ArchivalContext): Promise<ArchivalResult>;
  verify?(archiveLocation: string, digest: string): Promise<boolean>;
  rollback?(key: string, archiveLocation: string): Promise<void>;
}

export interface CandidateEntry {
  entry: TrackedEntry;
  health: TtlHealth;
  remainingLedgers: number;
  urgency: "critical" | "high" | "medium";
  reason: ArchivalTriggerReason;
}

export interface ExpirationScanReport {
  currentLedger: number;
  totalTracked: number;
  archivalCandidates: CandidateEntry[];
  unhealthyCount: number;
  healthyCount: number;
  archivedCount: number;
  expiredCount: number;
  scanTimestamp: string;
}

export interface ProactiveArchivalRunSummary {
  dryRun: boolean;
  currentLedger: number;
  candidatesCount: number;
  archivedCount: number;
  failedCount: number;
  skippedCount: number;
  deferredCount: number;
  results: Array<{
    key: string;
    outcome: "archived" | "failed" | "skipped" | "dry-run";
    location?: string;
    digest?: string;
    attempts: number;
    detail: string;
  }>;
}

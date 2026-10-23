/**
 * @file cross-service-contract-drift.ts
 *
 * Detects drift between two snapshots of the cross-service event contract map
 * (issue #371). Compare the last released definitions (`baseline`) with the
 * working tree (`current`) and report changes that break consumers.
 */

import { DomainEventContractDefinition } from "./cross-service-contract-map.types";
import { CROSS_SERVICE_EVENT_DEFINITIONS } from "./cross-service-contract-map.registry";

export type ContractDriftKind =
  | "event-removed"
  | "producer-changed"
  | "required-field-removed"
  | "required-field-added"
  | "payload-type-changed"
  | "consumer-removed"
  | "version-regressed"
  | "breaking-without-major-bump"
  | "event-added";

export interface ContractDriftFinding {
  eventName: string;
  kind: ContractDriftKind;
  /** Breaking findings fail the gate; the rest are informational. */
  breaking: boolean;
  detail: string;
}

export interface ContractDriftReport {
  ok: boolean;
  findings: ContractDriftFinding[];
}

function parseMajor(version: string): number | null {
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
  return match ? Number(match[1]) : null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Compare a released baseline with the current definitions. Pure and
 * deterministic: the same inputs always yield the same, sorted findings.
 */
export function detectContractDrift(
  baseline: DomainEventContractDefinition[],
  current: DomainEventContractDefinition[] = CROSS_SERVICE_EVENT_DEFINITIONS,
): ContractDriftReport {
  const findings: ContractDriftFinding[] = [];
  const currentByName = new Map(current.map((d) => [d.eventName, d]));
  const baselineNames = new Set(baseline.map((d) => d.eventName));

  for (const old of baseline) {
    const next = currentByName.get(old.eventName);
    if (!next) {
      findings.push({
        eventName: old.eventName,
        kind: "event-removed",
        breaking: true,
        detail: `Event '${old.eventName}' was removed while consumers (${old.consumers
          .map((c) => c.consumer)
          .join(", ")}) may still depend on it`,
      });
      continue;
    }

    const local: ContractDriftFinding[] = [];
    const breakingKinds: ContractDriftKind[] = [];
    const add = (
      kind: ContractDriftKind,
      breaking: boolean,
      detail: string,
    ): void => {
      local.push({ eventName: old.eventName, kind, breaking, detail });
      if (breaking) breakingKinds.push(kind);
    };

    if (old.producer !== next.producer) {
      add(
        "producer-changed",
        true,
        `Producer changed from '${old.producer}' to '${next.producer}'`,
      );
    }

    for (const field of old.requiredFields) {
      if (!next.requiredFields.includes(field)) {
        add(
          "required-field-removed",
          true,
          `Required field '${field}' was removed`,
        );
      }
    }
    for (const field of next.requiredFields) {
      if (!old.requiredFields.includes(field)) {
        add(
          "required-field-added",
          true,
          `Required field '${field}' was added; existing producers do not send it`,
        );
      }
    }

    for (const [field, type] of Object.entries(old.payloadSchema)) {
      const newType = next.payloadSchema[field];
      if (newType !== undefined && newType !== type) {
        add(
          "payload-type-changed",
          true,
          `Payload field '${field}' changed type from '${type}' to '${newType}'`,
        );
      }
    }

    const nextConsumers = new Set(next.consumers.map((c) => c.consumer));
    for (const consumer of old.consumers) {
      if (!nextConsumers.has(consumer.consumer)) {
        add(
          "consumer-removed",
          true,
          `Consumer '${consumer.consumer}' is no longer registered`,
        );
      }
    }

    const oldVersion = old.versioning.schemaVersion;
    const newVersion = next.versioning.schemaVersion;
    const oldMajor = parseMajor(oldVersion);
    const newMajor = parseMajor(newVersion);
    if (oldMajor === null || newMajor === null) {
      add(
        "version-regressed",
        true,
        `Schema version '${newVersion}' (was '${oldVersion}') is not valid semver`,
      );
    } else if (compareVersions(newVersion, oldVersion) < 0) {
      add(
        "version-regressed",
        true,
        `Schema version moved backwards from ${oldVersion} to ${newVersion}`,
      );
    } else if (breakingKinds.length > 0 && newMajor === oldMajor) {
      add(
        "breaking-without-major-bump",
        true,
        `Breaking changes (${[...new Set(breakingKinds)].join(
          ", ",
        )}) require a major version bump; still ${newVersion}`,
      );
    } else if (newMajor > oldMajor) {
      // A major bump is the contract's declared way to ship a breaking change.
      for (const finding of local) {
        if (finding.breaking) {
          finding.breaking = false;
          finding.detail += ` (acknowledged by major bump ${oldVersion} -> ${newVersion})`;
        }
      }
    }
    findings.push(...local);
  }

  for (const next of current) {
    if (!baselineNames.has(next.eventName)) {
      findings.push({
        eventName: next.eventName,
        kind: "event-added",
        breaking: false,
        detail: `New event '${next.eventName}' (v${next.versioning.schemaVersion})`,
      });
    }
  }

  findings.sort(
    (a, b) =>
      a.eventName.localeCompare(b.eventName) || a.kind.localeCompare(b.kind),
  );
  return { ok: !findings.some((f) => f.breaking), findings };
}

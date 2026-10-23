/**
 * @file cross-service-contract-drift.spec.ts
 *
 * Verifies cross-service contract drift detection (issue #371).
 */

import { detectContractDrift } from "./cross-service-contract-drift";
import { CROSS_SERVICE_EVENT_DEFINITIONS } from "./cross-service-contract-map.registry";
import { DomainEventContractDefinition } from "./cross-service-contract-map.types";

function clone(): DomainEventContractDefinition[] {
  return JSON.parse(JSON.stringify(CROSS_SERVICE_EVENT_DEFINITIONS));
}

function find(
  defs: DomainEventContractDefinition[],
  name: string,
): DomainEventContractDefinition {
  const def = defs.find((d) => d.eventName === name);
  if (!def) throw new Error(`missing fixture ${name}`);
  return def;
}

const EVENT = "auth.user.authenticated";

describe("detectContractDrift (issue #371)", () => {
  it("reports no drift when the current map matches the baseline", () => {
    const report = detectContractDrift(clone());
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("flags a removed event as breaking", () => {
    const baseline = clone();
    const current = clone().filter((d) => d.eventName !== EVENT);
    const report = detectContractDrift(baseline, current);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      expect.objectContaining({ eventName: EVENT, kind: "event-removed", breaking: true }),
    ]);
  });

  it("flags a removed required field and demands a major bump", () => {
    const current = clone();
    find(current, EVENT).requiredFields = ["userId", "authMethod"];
    const report = detectContractDrift(clone(), current);

    expect(report.ok).toBe(false);
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toContain("required-field-removed");
    expect(kinds).toContain("breaking-without-major-bump");
  });

  it("flags a newly required field as breaking for existing producers", () => {
    const current = clone();
    find(current, EVENT).requiredFields.push("deviceId");
    const report = detectContractDrift(clone(), current);

    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.kind)).toContain("required-field-added");
  });

  it("flags payload type changes, producer changes and removed consumers", () => {
    const current = clone();
    const def = find(current, EVENT);
    def.payloadSchema.userId = "number";
    def.producer = "portfolio-service";
    def.consumers = def.consumers.slice(1);
    const report = detectContractDrift(clone(), current);

    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "payload-type-changed",
        "producer-changed",
        "consumer-removed",
      ]),
    );
    expect(report.ok).toBe(false);
  });

  it("accepts a breaking change that ships with a major version bump", () => {
    const current = clone();
    const def = find(current, EVENT);
    def.requiredFields = ["userId"];
    def.versioning.schemaVersion = "2.0.0";
    const report = detectContractDrift(clone(), current);

    expect(report.ok).toBe(true);
    expect(report.findings.every((f) => !f.breaking)).toBe(true);
    expect(report.findings[0].detail).toContain("acknowledged by major bump");
  });

  it("flags a version that moves backwards or is not semver", () => {
    const backwards = clone();
    find(backwards, EVENT).versioning.schemaVersion = "0.9.0";
    expect(detectContractDrift(clone(), backwards).findings[0]).toEqual(
      expect.objectContaining({ kind: "version-regressed", breaking: true }),
    );

    const invalid = clone();
    find(invalid, EVENT).versioning.schemaVersion = "v1";
    expect(detectContractDrift(clone(), invalid).ok).toBe(false);
  });

  it("reports a new event as informational only", () => {
    const baseline = clone().filter((d) => d.eventName !== EVENT);
    const report = detectContractDrift(baseline, clone());
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([
      expect.objectContaining({ eventName: EVENT, kind: "event-added", breaking: false }),
    ]);
  });

  it("is deterministic regardless of input order", () => {
    const current = clone();
    find(current, EVENT).requiredFields = ["userId"];
    const a = detectContractDrift(clone(), current);
    const b = detectContractDrift(clone().reverse(), [...current].reverse());
    expect(b).toEqual(a);
  });
});

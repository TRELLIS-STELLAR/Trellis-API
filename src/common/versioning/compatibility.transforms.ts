/**
 * Compatibility transforms — coerce legacy/future record shapes into the
 * canonical form expected by the current application layer.
 *
 * Convention
 * ──────────
 * Each transform module registers a `readTransform` and optionally a
 * `writeTransform` for a given (entity, from-version → to-version) pair.
 *
 * The CompatibilityTransformPipeline applies transforms in order so records
 * that skip multiple versions are upgraded step by step.
 *
 * Issue: #64
 */

export type TransformFn<T = Record<string, unknown>> = (record: T) => T;

export interface CompatibilityTransform<T = Record<string, unknown>> {
  entity: string;
  fromVersion: string; // semver range of the *stored* schema
  toVersion: string;   // the version produced after transform
  direction: "read" | "write";
  transform: TransformFn<T>;
  /** Short human-readable description for documentation / introspection. */
  description: string;
}

/** Raised rather than returning a record whose schema this build cannot read. */
export class UnsupportedRecordSchemaVersionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly schemaVersion: string | undefined,
  ) {
    super(
      `Unsupported schema version "${schemaVersion ?? "missing"}" for ${entity}`,
    );
    this.name = "UnsupportedRecordSchemaVersionError";
  }
}

/**
 * Registry of all registered compatibility transforms, keyed by entity name.
 */
const registry = new Map<string, CompatibilityTransform[]>();

export function registerTransform<T = Record<string, unknown>>(
  transform: CompatibilityTransform<T>,
): void {
  const key = transform.entity;
  const existing = registry.get(key) ?? [];
  registry.set(key, [...existing, transform as CompatibilityTransform]);
}

export function getTransforms(entity: string): CompatibilityTransform[] {
  return registry.get(entity) ?? [];
}

/**
 * Apply all registered read transforms for `entity` to `record`,
 * upgrading it step-by-step from its stored `schemaVersion` to the
 * latest version.
 *
 * Returns the transformed record (original is never mutated).
 */
export function applyReadTransforms<T extends { schemaVersion?: string }>(
  entity: string,
  record: T,
): T {
  const transforms = getTransforms(entity).filter(
    (t) => t.direction === "read",
  );
  if (transforms.length === 0) return record;

  const initialVersion = record.schemaVersion;
  if (!initialVersion || !semver.valid(initialVersion)) {
    throw new UnsupportedRecordSchemaVersionError(entity, initialVersion);
  }

  const latestVersion = transforms.reduce(
    (latest, transform) =>
      semver.gt(transform.toVersion, latest) ? transform.toVersion : latest,
    transforms[0].toVersion,
  );

  let current = { ...record };
  let version = initialVersion;
  const visited = new Set<string>();
  while (!semver.eq(version, latestVersion)) {
    if (visited.has(version)) {
      throw new Error(`Cyclic schema transforms registered for ${entity}`);
    }
    visited.add(version);

    const transform = transforms.find((candidate) =>
      semver.satisfies(version, candidate.fromVersion),
    );
    if (!transform) {
      throw new UnsupportedRecordSchemaVersionError(entity, version);
    }

    current = transform.transform(current as Record<string, unknown>) as T;
    version = transform.toVersion;
    current.schemaVersion = version;
  }
  return current;
}

// ────────────────────────────────────────────────────────────────────────────
// Built-in transforms for existing Trellis entities
// ────────────────────────────────────────────────────────────────────────────

/**
 * Portfolio entity: v0.x records stored `createdDate` as a Unix epoch number.
 * v1.x uses ISO-8601 strings (`createdAt`). This transform normalises old records.
 */
registerTransform({
  entity: "Portfolio",
  fromVersion: "^0.x",
  toVersion: "1.0.0",
  direction: "read",
  description: 'Rename `createdDate` (epoch ms) → `createdAt` (ISO string) for Portfolio v0→v1',
  transform: (record: Record<string, unknown>) => {
    if (
      Object.prototype.hasOwnProperty.call(record, "createdDate") &&
      !Object.prototype.hasOwnProperty.call(record, "createdAt")
    ) {
      const { createdDate, ...rest } = record;
      return {
        ...rest,
        createdAt:
          typeof createdDate === "number"
            ? new Date(createdDate).toISOString()
            : createdDate,
      };
    }
    return record;
  },
});

/**
 * User entity: v0.x stored `role` as a lowercase string ("admin", "user").
 * v1.x canonical Role enum uses UPPERCASE. This transform normalises legacy JWTs
 * and DB rows (the normaliseRole() helper already handles this at runtime;
 * this transform makes it explicit in the compatibility pipeline).
 */
registerTransform({
  entity: "User",
  fromVersion: "^0.x",
  toVersion: "1.0.0",
  direction: "read",
  description: "Normalise legacy lowercase `role` field to UPPERCASE canonical form",
  transform: (record: Record<string, unknown>) => {
    if (typeof record.role === "string") {
      return { ...record, role: record.role.toUpperCase() };
    }
    return record;
  },
});

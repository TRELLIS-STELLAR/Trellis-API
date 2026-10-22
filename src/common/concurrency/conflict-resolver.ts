export interface FieldConflict<T> {
  field: string;
  base: T | undefined;
  current: T | undefined;
  proposed: T | undefined;
}

export interface ThreeWayMergeResult<T> {
  merged: Record<string, T>;
  /** Sorted by field, so the same inputs always report the same conflicts. */
  conflicts: FieldConflict<T>[];
  /** False when the proposal is already reflected in `current` (a retried edit). */
  changed: boolean;
}

/**
 * Deterministic field-level three-way merge for multi-client edits.
 *
 * `base` is the snapshot the client edited, `current` the latest stored
 * snapshot and `proposed` the client's complete replacement. An absent key
 * means the field does not exist (a removal). Per field:
 *
 * - proposed equals current: keep it (both sides agree, or a retried edit);
 * - proposed equals base: only another client changed it, keep current;
 * - current equals base: only this client changed it, take proposed;
 * - otherwise both changed it differently: conflict.
 *
 * Fields are visited in sorted order, so the result depends only on the three
 * snapshots, never on arrival or key order. O(k log k) time, O(k) space for k
 * distinct fields.
 */
export function threeWayMerge<T>(
  base: Record<string, T>,
  current: Record<string, T>,
  proposed: Record<string, T>,
): ThreeWayMergeResult<T> {
  const fields = [
    ...new Set([
      ...Object.keys(base),
      ...Object.keys(current),
      ...Object.keys(proposed),
    ]),
  ].sort();
  const merged: Record<string, T> = {};
  const conflicts: FieldConflict<T>[] = [];
  let changed = false;
  for (const field of fields) {
    const b = base[field];
    const c = current[field];
    const p = proposed[field];
    let value: T | undefined;
    if (Object.is(p, c) || Object.is(p, b)) {
      value = c;
    } else if (Object.is(c, b)) {
      value = p;
      changed = true;
    } else {
      conflicts.push({ field, base: b, current: c, proposed: p });
      continue;
    }
    if (value !== undefined) merged[field] = value;
  }
  return { merged, conflicts, changed };
}

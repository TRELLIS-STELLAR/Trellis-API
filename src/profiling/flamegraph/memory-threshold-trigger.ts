/**
 * Memory threshold trigger for flamegraph capture (#527).
 *
 * Fires once when heap usage crosses `threshold`, then stays disarmed until usage
 * falls back below `rearmRatio`. Two guards stop it thrashing:
 *
 *  - Hysteresis. Without `rearmRatio` a process hovering at the threshold would
 *    fire on every sample. With it, one excursion produces one capture.
 *  - Cooldown. Even across separate excursions, captures are at least
 *    `cooldownMs` apart. A CPU profile is not free, and an alarm loop must not
 *    become the load it was meant to diagnose.
 *
 * The trigger only decides. It does not capture, so it can be tested with a
 * fake clock and reused by any caller.
 */

export interface HeapSample {
  usedHeapSize: number;
  heapSizeLimit: number;
}

export type TriggerDecision = "fire" | "idle" | "cooldown";

export interface MemoryThresholdTriggerOptions {
  /** Heap usage ratio in (0, 1) that arms a capture, e.g. 0.85. */
  threshold: number;
  /** Usage ratio that re-arms the trigger. Must be below `threshold`. */
  rearmRatio?: number;
  /** Minimum ms between captures. Defaults to 15 minutes. */
  cooldownMs?: number;
  now?: () => number;
}

export class MemoryThresholdTrigger {
  private readonly threshold: number;
  private readonly rearmRatio: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private armed = true;
  private lastFiredAt = Number.NEGATIVE_INFINITY;

  constructor(options: MemoryThresholdTriggerOptions) {
    if (!(options.threshold > 0 && options.threshold < 1)) {
      throw new Error(
        "memory threshold must be a ratio strictly between 0 and 1",
      );
    }
    this.threshold = options.threshold;
    this.rearmRatio =
      options.rearmRatio ?? Math.max(0, options.threshold - 0.05);
    if (!(this.rearmRatio >= 0 && this.rearmRatio < this.threshold)) {
      throw new Error("rearmRatio must be >= 0 and below the threshold");
    }
    this.cooldownMs = options.cooldownMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  evaluate(sample: HeapSample): TriggerDecision {
    if (!(sample.heapSizeLimit > 0) || !Number.isFinite(sample.usedHeapSize)) {
      return "idle";
    }
    const ratio = sample.usedHeapSize / sample.heapSizeLimit;

    if (!this.armed) {
      if (ratio < this.rearmRatio) this.armed = true;
      return "idle";
    }
    if (ratio < this.threshold) return "idle";

    const now = this.now();
    if (now - this.lastFiredAt < this.cooldownMs) return "cooldown";

    this.armed = false;
    this.lastFiredAt = now;
    return "fire";
  }

  isArmed(): boolean {
    return this.armed;
  }
}

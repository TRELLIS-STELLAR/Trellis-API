import { ConflictException, ForbiddenException, Logger } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { Role, hasRole } from "../../common/guard/roles.enum";
import {
  CpuProfile,
  FlamegraphNode,
  buildFlamegraph,
  toFoldedStacks,
  topSelfFrames,
} from "./flamegraph";
import { HeapSample, MemoryThresholdTrigger } from "./memory-threshold-trigger";

/**
 * Flamegraph snapshot collector with a memory threshold trigger (#527).
 *
 * Two entry points produce the same artifact:
 *  - `collect(actor)`: manual capture. Requires ADMIN. Checked before any
 *    profile is started.
 *  - `onMemorySample(sample)`: automatic capture when the trigger fires. It runs
 *    as the system, so it needs no actor. It is only ever reached through the
 *    same production gate as manual capture.
 *
 * Gates, in order (each refusal happens before a profile starts):
 *  1. Authorization: manual capture requires ADMIN.
 *  2. Feature gate: in production, profiling must be enabled explicitly
 *     (`ENABLE_PROFILING=true`), matching the existing profiling controller.
 *  3. Concurrency: one capture at a time. A second manual request gets 409. A
 *     trigger that finds a capture running is skipped, not queued.
 *
 * Failure and retry: a failing profile source is retried with exponential
 * backoff up to `maxAttempts`. Writes go to a temp file and are renamed into
 * place. If a write fails, any file already written for that capture is
 * removed, so a failed capture leaves no partial artifact behind.
 *
 * Recovery: artifacts are plain files in `outputDir` and are never deleted
 * automatically. Remove unwanted ones by hand. Nothing else is changed by a
 * capture, so there is nothing to roll back.
 */

export type ProfileSource = (durationMs: number) => Promise<CpuProfile>;

export type CaptureReason = "manual" | "memory-threshold";

export interface FlamegraphArtifact {
  id: string;
  reason: CaptureReason;
  createdAt: string;
  durationMs: number;
  attempts: number;
  totalSamples: number;
  topFrames: { name: string; self: number }[];
  files: { json: string; folded: string };
}

export interface FlamegraphCollectorOptions {
  outputDir: string;
  profileSource: ProfileSource;
  /** Feature gate, evaluated at each capture. */
  isEnabled: () => boolean;
  trigger?: MemoryThresholdTrigger;
  /** Profile length in ms. Defaults to 5000. */
  durationMs?: number;
  /** Attempts per capture for profile-source failures. Defaults to 2. */
  maxAttempts?: number;
  /** Base backoff in ms, doubled per attempt. Defaults to 250. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: Pick<Logger, "log" | "warn" | "error">;
}

export interface CollectorActor {
  id: string;
  roles: Role[];
}

export const MEMORY_TRIGGER_ACTOR: CollectorActor = {
  id: "system:memory-threshold",
  roles: [Role.ADMIN],
};

export class FlamegraphCollector {
  private readonly logger: Pick<Logger, "log" | "warn" | "error">;
  private readonly durationMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private inFlight = false;

  constructor(private readonly options: FlamegraphCollectorOptions) {
    this.logger = options.logger ?? new Logger(FlamegraphCollector.name);
    this.durationMs = options.durationMs ?? 5000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** Manual capture. Requires ADMIN. */
  async collect(
    actor: CollectorActor,
    durationMs?: number,
  ): Promise<FlamegraphArtifact> {
    if (!actor.roles.some((role) => hasRole(role, Role.ADMIN))) {
      throw new ForbiddenException("Flamegraph capture requires ADMIN");
    }
    return this.capture("manual", durationMs ?? this.durationMs);
  }

  /**
   * Feed a heap sample. Captures when the trigger fires. Never throws: a failed
   * automatic capture is logged, and the caller's monitoring loop carries on.
   */
  async onMemorySample(sample: HeapSample): Promise<FlamegraphArtifact | null> {
    const trigger = this.options.trigger;
    if (!trigger) return null;
    if (trigger.evaluate(sample) !== "fire") return null;

    try {
      const artifact = await this.capture("memory-threshold", this.durationMs);
      this.logger.warn(
        `memory threshold reached; flamegraph ${artifact.id} written (${artifact.totalSamples} samples)`,
      );
      return artifact;
    } catch (error) {
      this.logger.error(
        `memory-triggered flamegraph capture failed: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async capture(
    reason: CaptureReason,
    durationMs: number,
  ): Promise<FlamegraphArtifact> {
    if (!this.options.isEnabled()) {
      throw new ForbiddenException("Profiling is disabled");
    }
    if (this.inFlight) {
      throw new ConflictException(
        "A flamegraph capture is already in progress",
      );
    }

    this.inFlight = true;
    try {
      const { profile, attempts } = await this.profileWithRetry(durationMs);
      const graph = buildFlamegraph(profile);
      return this.persist(reason, durationMs, attempts, graph, profile);
    } finally {
      this.inFlight = false;
    }
  }

  private async profileWithRetry(
    durationMs: number,
  ): Promise<{ profile: CpuProfile; attempts: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return {
          profile: await this.options.profileSource(durationMs),
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `flamegraph profile attempt ${attempt}/${this.maxAttempts} failed: ${errorMessage(error)}`,
        );
        if (attempt < this.maxAttempts && this.retryDelayMs > 0) {
          await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError;
  }

  private persist(
    reason: CaptureReason,
    durationMs: number,
    attempts: number,
    graph: FlamegraphNode,
    profile: CpuProfile,
  ): FlamegraphArtifact {
    const createdAt = new Date(this.now());
    const id = `flame-${createdAt.getTime()}-${randomBytes(4).toString("hex")}`;
    const dir = this.options.outputDir;
    const files = {
      json: path.join(dir, `${id}.flamegraph.json`),
      folded: path.join(dir, `${id}.folded`),
    };

    const artifact: FlamegraphArtifact = {
      id,
      reason,
      createdAt: createdAt.toISOString(),
      durationMs,
      attempts,
      totalSamples: graph.value,
      topFrames: topSelfFrames(graph, 10),
      files,
    };

    fs.mkdirSync(dir, { recursive: true });
    const written: string[] = [];
    try {
      writeAtomic(
        files.json,
        JSON.stringify({
          artifact,
          profileWindow: {
            startTime: profile.startTime,
            endTime: profile.endTime,
          },
          root: graph,
        }),
      );
      written.push(files.json);
      writeAtomic(files.folded, toFoldedStacks(graph));
      written.push(files.folded);
    } catch (error) {
      for (const file of written) fs.rmSync(file, { force: true });
      throw error;
    }
    return artifact;
  }
}

function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

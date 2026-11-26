import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  PreconditionFailedException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { Role, normalizeRole } from "../common/guard/roles.enum";
import { SandboxConfigService } from "./sandbox.config";
import { DEFAULT_SANDBOX_SEED } from "./sandbox.constants";
import {
  DEFAULT_SANDBOX_SCENARIO,
  SandboxScenario,
  isSandboxScenario,
} from "./sandbox.scenarios";

export interface SandboxScenarioState {
  activeScenario: SandboxScenario;
  seed: string;
  sequenceCounter: number;
  records: Array<{
    kind: "create" | "sign" | "submit" | "status" | "refund";
    id: string;
    payload: Record<string, unknown>;
    timestamp: string;
  }>;
  customState?: Record<string, unknown>;
}

export interface SandboxSnapshot {
  snapshotId: string;
  label: string;
  createdAt: string;
  createdBy: string;
  state: SandboxScenarioState;
  checksum: string;
}

export interface SandboxSnapshotSummary {
  snapshotId: string;
  label: string;
  createdAt: string;
  createdBy: string;
  seed: string;
  activeScenario: SandboxScenario;
  recordsCount: number;
  checksum: string;
}

export interface SandboxActorContext {
  id: string;
  roles: string[];
}

export interface SnapshotRestoreResult {
  snapshotId: string;
  restoredAt: string;
  previousSeed: string;
  restoredSeed: string;
  recordsCount: number;
  rolledBack?: boolean;
}

export interface DeterministicResetResult {
  previousSeed: string;
  currentSeed: string;
  sequenceCounter: number;
  resetAt: string;
  recordsCleared: number;
}

/**
 * Computes a deterministic SHA-256 digest over the serialized sandbox state.
 */
export function computeStateChecksum(state: SandboxScenarioState): string {
  const normalized = JSON.stringify({
    scenario: state.activeScenario,
    seed: state.seed,
    seq: state.sequenceCounter,
    records: state.records.map((r) => ({
      kind: r.kind,
      id: r.id,
      timestamp: r.timestamp,
    })),
    custom: state.customState || {},
  });
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Sandbox Scenario State Snapshotter and Deterministic Seed Reset (#520).
 *
 * Provides in-memory snapshotting, state rollback, export/import with integrity
 * verification, and deterministic seed resets for scenario testing.
 */
@Injectable()
export class SandboxSnapshotService {
  private readonly logger = new Logger(SandboxSnapshotService.name);
  private readonly snapshotStore = new Map<string, SandboxSnapshot>();

  // Active in-memory sandbox runtime state
  private activeSeed: string;
  private activeScenario: SandboxScenario;
  private sequenceCounter = 0;
  private records: SandboxScenarioState["records"] = [];
  private customState: Record<string, unknown> = {};

  constructor(private readonly sandboxConfig: SandboxConfigService) {
    const cfg = this.sandboxConfig.get();
    this.activeSeed = cfg.seed || DEFAULT_SANDBOX_SEED;
    this.activeScenario = cfg.scenario || DEFAULT_SANDBOX_SCENARIO;
  }

  /** Current active seed in the sandbox runtime */
  getActiveSeed(): string {
    return this.activeSeed;
  }

  /** Current active scenario in the sandbox runtime */
  getActiveScenario(): SandboxScenario {
    return this.activeScenario;
  }

  /** Sequence counter for deterministically ordered actions */
  getSequenceCounter(): number {
    return this.sequenceCounter;
  }

  /** Records an action in the sandbox state log */
  recordAction(
    kind: SandboxScenarioState["records"][0]["kind"],
    id: string,
    payload: Record<string, unknown> = {},
  ): void {
    this.sequenceCounter++;
    this.records.push({
      kind,
      id,
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Captures the current sandbox scenario runtime state into an immutable snapshot.
   * Requires ADMIN or TESTER role.
   */
  async createSnapshot(
    label = "default-snapshot",
    actor: SandboxActorContext,
  ): Promise<SandboxSnapshot> {
    this.sandboxConfig.assertEnabled();
    this.assertAuthorizedActor(actor);

    const stateCopy: SandboxScenarioState = {
      activeScenario: this.activeScenario,
      seed: this.activeSeed,
      sequenceCounter: this.sequenceCounter,
      records: JSON.parse(JSON.stringify(this.records)),
      customState: JSON.parse(JSON.stringify(this.customState)),
    };

    const checksum = computeStateChecksum(stateCopy);
    const snapshotId = `sbx-snap:${createHash("sha256")
      .update(`${this.activeSeed}:${Date.now()}:${label}`)
      .digest("hex")
      .slice(0, 16)}`;

    const snapshot: SandboxSnapshot = {
      snapshotId,
      label,
      createdAt: new Date().toISOString(),
      createdBy: actor.id,
      state: stateCopy,
      checksum,
    };

    this.snapshotStore.set(snapshotId, snapshot);
    this.logger.log(
      `Sandbox snapshot "${snapshotId}" ("${label}") created by ${actor.id} with checksum ${checksum.slice(0, 8)}`,
    );

    return snapshot;
  }

  /**
   * Restores the sandbox scenario runtime state from a snapshot.
   * Includes rollback safety: if restore fails or checksum is invalid, rolls back.
   * Requires ADMIN or TESTER role.
   */
  async restoreSnapshot(
    snapshotId: string,
    actor: SandboxActorContext,
  ): Promise<SnapshotRestoreResult> {
    this.sandboxConfig.assertEnabled();
    this.assertAuthorizedActor(actor);

    const snapshot = this.snapshotStore.get(snapshotId);
    if (!snapshot) {
      throw new NotFoundException(`Snapshot "${snapshotId}" not found`);
    }

    // Verify integrity checksum before restoring
    const expectedChecksum = computeStateChecksum(snapshot.state);
    if (snapshot.checksum !== expectedChecksum) {
      throw new BadRequestException(
        `Snapshot integrity check failed: expected checksum ${expectedChecksum.slice(
          0,
          8,
        )}, got ${snapshot.checksum.slice(0, 8)}`,
      );
    }

    // Take backup of current state for rollback protection
    const backupState: SandboxScenarioState = {
      activeScenario: this.activeScenario,
      seed: this.activeSeed,
      sequenceCounter: this.sequenceCounter,
      records: JSON.parse(JSON.stringify(this.records)),
      customState: JSON.parse(JSON.stringify(this.customState)),
    };

    const previousSeed = this.activeSeed;

    try {
      this.activeScenario = snapshot.state.activeScenario;
      this.activeSeed = snapshot.state.seed;
      this.sequenceCounter = snapshot.state.sequenceCounter;
      this.records = JSON.parse(JSON.stringify(snapshot.state.records));
      this.customState = JSON.parse(
        JSON.stringify(snapshot.state.customState || {}),
      );

      this.logger.log(
        `Sandbox state restored from snapshot "${snapshotId}" by ${actor.id}`,
      );

      return {
        snapshotId,
        restoredAt: new Date().toISOString(),
        previousSeed,
        restoredSeed: this.activeSeed,
        recordsCount: this.records.length,
        rolledBack: false,
      };
    } catch (err) {
      // Rollback to prior state if application fails
      this.activeScenario = backupState.activeScenario;
      this.activeSeed = backupState.seed;
      this.sequenceCounter = backupState.sequenceCounter;
      this.records = backupState.records;
      this.customState = backupState.customState || {};

      this.logger.error(
        `Failed to restore snapshot "${snapshotId}". State rolled back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );

      throw new BadRequestException(
        `Restore failed and was safely rolled back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Resets the sandbox deterministic seed, clearing action logs and resetting sequence counters.
   * Guarantees deterministic repeatability for scenario testing.
   * Requires ADMIN or TESTER role.
   */
  async resetSeed(
    newSeed?: string,
    actor?: SandboxActorContext,
  ): Promise<DeterministicResetResult> {
    this.sandboxConfig.assertEnabled();
    if (actor) {
      this.assertAuthorizedActor(actor);
    }

    const previousSeed = this.activeSeed;
    const recordsCleared = this.records.length;

    const chosenSeed =
      newSeed && newSeed.trim() ? newSeed.trim() : DEFAULT_SANDBOX_SEED;

    this.activeSeed = chosenSeed;
    this.sequenceCounter = 0;
    this.records = [];
    this.customState = {};

    this.logger.log(
      `Deterministic seed reset from "${previousSeed}" to "${chosenSeed}" (${recordsCleared} records cleared)`,
    );

    return {
      previousSeed,
      currentSeed: chosenSeed,
      sequenceCounter: 0,
      resetAt: new Date().toISOString(),
      recordsCleared,
    };
  }

  /**
   * Lists available snapshots.
   */
  listSnapshots(): SandboxSnapshotSummary[] {
    return Array.from(this.snapshotStore.values()).map((s) => ({
      snapshotId: s.snapshotId,
      label: s.label,
      createdAt: s.createdAt,
      createdBy: s.createdBy,
      seed: s.state.seed,
      activeScenario: s.state.activeScenario,
      recordsCount: s.state.records.length,
      checksum: s.checksum,
    }));
  }

  /**
   * Exports a snapshot as a serialized JSON string.
   */
  exportSnapshot(snapshotId: string): string {
    const snapshot = this.snapshotStore.get(snapshotId);
    if (!snapshot) {
      throw new NotFoundException(`Snapshot "${snapshotId}" not found`);
    }
    return JSON.stringify(snapshot, null, 2);
  }

  /**
   * Imports a snapshot from serialized JSON, verifying schema and checksum.
   */
  importSnapshot(
    serialized: string,
    actor: SandboxActorContext,
  ): SandboxSnapshot {
    this.sandboxConfig.assertEnabled();
    this.assertAuthorizedActor(actor);

    let parsed: SandboxSnapshot;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new BadRequestException("Invalid snapshot JSON payload");
    }

    if (!parsed.snapshotId || !parsed.state || !parsed.checksum) {
      throw new BadRequestException("Malformed snapshot structure");
    }

    const computed = computeStateChecksum(parsed.state);
    if (computed !== parsed.checksum) {
      throw new BadRequestException("Imported snapshot checksum validation failed");
    }

    this.snapshotStore.set(parsed.snapshotId, parsed);
    this.logger.log(
      `Imported snapshot "${parsed.snapshotId}" successfully (by ${actor.id})`,
    );
    return parsed;
  }

  /**
   * Deletes a snapshot from store.
   */
  deleteSnapshot(snapshotId: string, actor: SandboxActorContext): boolean {
    this.sandboxConfig.assertEnabled();
    this.assertAuthorizedActor(actor);
    return this.snapshotStore.delete(snapshotId);
  }

  private assertAuthorizedActor(actor: SandboxActorContext): void {
    if (!actor || !actor.roles || !Array.isArray(actor.roles)) {
      throw new ForbiddenException(
        "Missing actor context or roles for sandbox management",
      );
    }
    const roles = actor.roles.map((r) => normalizeRole(r));
    const isAuthorized =
      roles.includes(Role.ADMIN) ||
      roles.some((r) => r.toUpperCase() === "TESTER");
    if (!isAuthorized) {
      throw new ForbiddenException(
        "Only ADMIN or TESTER roles may manage sandbox state and seed resets",
      );
    }
  }
}

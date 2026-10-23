import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  CheckpointStore,
  EventReplayEngine,
  EventSource,
  InMemoryCheckpointStore,
  InMemoryProjectionStore,
  ProjectionDefinition,
  ProjectionStore,
  PublishedProjection,
  ReplayOptions,
  ReplayReport,
} from "./event-replay";
import { DEFAULT_UPCASTERS, EventUpcasterRegistry } from "./event-upcaster";

/** Provider tokens so deployments can bind durable stores. */
export const PROJECTION_CHECKPOINT_STORE = "PROJECTION_CHECKPOINT_STORE";
export const PROJECTION_STORE = "PROJECTION_STORE";

export interface RegisteredProjection {
  projection: ProjectionDefinition<any>;
  source: EventSource;
}

export interface ProjectionStatus {
  name: string;
  /** Version defined in code. */
  version: number;
  /** Version currently published, or null when never rebuilt. */
  activeVersion: number | null;
  activeSequence: number | null;
  activeStateHash: string | null;
  /** True when the published version is behind the code: a rebuild is due. */
  stale: boolean;
  running: boolean;
}

/**
 * Registry + operator facade for projection rebuilds (#278).
 *
 * Modules that own a projection call `register()` with the projection and an
 * ordered event source. Operators then rebuild, dry-run or roll back through
 * the admin controller or the `events:replay` CLI. Stores default to
 * in-memory; bind {@link PROJECTION_CHECKPOINT_STORE} / {@link PROJECTION_STORE}
 * to durable implementations to survive restarts.
 */
@Injectable()
export class ProjectionReplayService {
  private readonly registered = new Map<string, RegisteredProjection>();
  private readonly engine: EventReplayEngine;
  private readonly store: ProjectionStore;

  constructor(
    @Optional()
    @Inject(PROJECTION_CHECKPOINT_STORE)
    checkpoints?: CheckpointStore,
    @Optional() @Inject(PROJECTION_STORE) store?: ProjectionStore,
  ) {
    const upcasters = new EventUpcasterRegistry();
    DEFAULT_UPCASTERS.forEach((upcaster) => upcasters.register(upcaster));
    this.store = store ?? new InMemoryProjectionStore();
    this.engine = new EventReplayEngine(
      checkpoints ?? new InMemoryCheckpointStore(),
      this.store,
      upcasters,
    );
  }

  register(projection: ProjectionDefinition<any>, source: EventSource): void {
    if (this.registered.has(projection.name)) {
      throw new Error(`Projection '${projection.name}' is already registered`);
    }
    this.registered.set(projection.name, { projection, source });
  }

  async list(): Promise<ProjectionStatus[]> {
    return Promise.all(
      [...this.registered.keys()].map((name) => this.status(name)),
    );
  }

  async status(name: string): Promise<ProjectionStatus> {
    const { projection } = this.get(name);
    const active = await this.store.getActive(name);
    return {
      name,
      version: projection.version,
      activeVersion: active?.version ?? null,
      activeSequence: active?.sequence ?? null,
      activeStateHash: active?.stateHash ?? null,
      stale: active?.version !== projection.version,
      running: this.engine.isRunning(name),
    };
  }

  rebuild(name: string, options: ReplayOptions = {}): Promise<ReplayReport> {
    const { projection, source } = this.get(name);
    return this.engine.rebuild(projection, source, options);
  }

  rollback(name: string): Promise<PublishedProjection | null> {
    this.get(name);
    return this.engine.rollback(name);
  }

  getActive(name: string): Promise<PublishedProjection | null> {
    this.get(name);
    return this.store.getActive(name);
  }

  private get(name: string): RegisteredProjection {
    const found = this.registered.get(name);
    if (!found) throw new NotFoundException(`Unknown projection '${name}'`);
    return found;
  }
}

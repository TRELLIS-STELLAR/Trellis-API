import {
  DomainEventEnvelope,
  DomainEventRegistry,
} from "../domain-event-schema";

/**
 * Schema upcasting for replay (#278).
 *
 * Stored events keep the schema version they were produced with forever.
 * Projections are written against one version per event, so before an event is
 * applied it is upcast step by step (`1.0 → 2.0 → 3.0`) to the version the
 * projection declares. Every step is a pure function registered once; the
 * resulting envelope is re-validated against the target schema so a bad
 * upcaster fails loudly instead of corrupting a projection.
 */
export interface EventUpcaster {
  eventName: string;
  fromVersion: string;
  toVersion: string;
  upcast(payload: Record<string, unknown>): Record<string, unknown>;
}

export class UpcastError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly fromVersion: string,
    public readonly targetVersion: string,
    message: string,
  ) {
    super(message);
    this.name = "UpcastError";
  }
}

export interface UpcastResult<T = Record<string, unknown>> {
  event: DomainEventEnvelope<T>;
  /** Versions passed through, e.g. `["1.0", "2.0"]`; empty when unchanged. */
  path: string[];
}

export class EventUpcasterRegistry {
  private readonly steps = new Map<string, EventUpcaster>(); // `${name}@${from}` -> step

  constructor(
    private readonly schemas: DomainEventRegistry = DomainEventRegistry.getInstance(),
  ) {}

  register(upcaster: EventUpcaster): this {
    if (upcaster.fromVersion === upcaster.toVersion) {
      throw new Error(
        `Upcaster for ${upcaster.eventName} must change the version`,
      );
    }
    const key = `${upcaster.eventName}@${upcaster.fromVersion}`;
    if (this.steps.has(key)) {
      // One unambiguous path per version keeps replay deterministic.
      throw new Error(`Duplicate upcaster for ${key}`);
    }
    this.steps.set(key, upcaster);
    return this;
  }

  /** Upcasts `event` to `targetVersion`. Never mutates the input. */
  upcast<T = Record<string, unknown>>(
    event: DomainEventEnvelope,
    targetVersion: string,
  ): UpcastResult<T> {
    if (event.schemaVersion === targetVersion) {
      return { event: event as DomainEventEnvelope<T>, path: [] };
    }

    let current: DomainEventEnvelope = {
      ...event,
      payload: structuredClone(event.payload),
    };
    const path = [event.schemaVersion];
    const seen = new Set<string>([event.schemaVersion]);

    while (current.schemaVersion !== targetVersion) {
      const step = this.steps.get(
        `${current.eventName}@${current.schemaVersion}`,
      );
      if (!step) {
        throw new UpcastError(
          event.eventName,
          event.schemaVersion,
          targetVersion,
          `No upcast path from ${event.eventName} v${current.schemaVersion} to v${targetVersion}`,
        );
      }
      if (seen.has(step.toVersion)) {
        throw new UpcastError(
          event.eventName,
          event.schemaVersion,
          targetVersion,
          `Upcaster cycle for ${event.eventName} at v${step.toVersion}`,
        );
      }
      current = {
        ...current,
        schemaVersion: step.toVersion,
        payload: step.upcast(structuredClone(current.payload)),
      };
      seen.add(step.toVersion);
      path.push(step.toVersion);
    }

    // The upcast payload must satisfy the target schema exactly as a freshly
    // produced event would.
    if (this.schemas.getSchema(current.eventName, targetVersion)) {
      this.schemas.validateProducerEvent(current);
    }
    return { event: current as DomainEventEnvelope<T>, path };
  }
}

/** Upcasters for the schemas registered by default in {@link DomainEventRegistry}. */
export const DEFAULT_UPCASTERS: EventUpcaster[] = [
  {
    // v2.0 added a required `kycTier`. Users created before tiers existed were
    // never verified, which is exactly what `unverified` means downstream.
    eventName: "user.created",
    fromVersion: "1.0",
    toVersion: "2.0",
    upcast: (payload) => ({
      ...payload,
      kycTier: payload.kycTier ?? "unverified",
    }),
  },
];

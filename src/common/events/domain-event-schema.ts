/**
 * Structured Domain Event Schemas and Versioned Consumers for Trellis API (#116).
 * Ensures stable payload schemas, producer-side validation, explicit schema versions,
 * and consumer fallback mechanisms.
 */

export interface DomainEventEnvelope<T = any> {
  eventId: string;
  eventName: string;
  schemaVersion: string; // Explicit version, e.g. "1.0", "2.0"
  timestamp: string;
  producer: string;
  payload: T;
}

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface FieldDefinition {
  name: string;
  type: FieldType;
  required: boolean;
}

export interface DomainEventSchema {
  eventName: string;
  version: string;
  fields: FieldDefinition[];
}

export class DomainEventValidationError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly schemaVersion: string,
    public readonly missingOrInvalidFields: string[],
  ) {
    super(
      `Domain event validation failed for '${eventName}' (v${schemaVersion}): ` +
        `Invalid or missing fields: ${missingOrInvalidFields.join(', ')}`,
    );
    this.name = 'DomainEventValidationError';
  }
}

export class UnknownEventVersionError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly schemaVersion: string,
  ) {
    super(
      `Unknown or unsupported schema version '${schemaVersion}' for event '${eventName}'.`,
    );
    this.name = 'UnknownEventVersionError';
  }
}

/**
 * Registry holding event schemas and producer-side validation logic.
 */
export class DomainEventRegistry {
  private static instance: DomainEventRegistry;
  private schemas: Map<string, Map<string, DomainEventSchema>> = new Map();

  public static getInstance(): DomainEventRegistry {
    if (!DomainEventRegistry.instance) {
      DomainEventRegistry.instance = new DomainEventRegistry();
      DomainEventRegistry.instance.registerDefaultSchemas();
    }
    return DomainEventRegistry.instance;
  }

  public registerSchema(schema: DomainEventSchema): void {
    if (!this.schemas.has(schema.eventName)) {
      this.schemas.set(schema.eventName, new Map());
    }
    this.schemas.get(schema.eventName)!.set(schema.version, schema);
  }

  public getSchema(eventName: string, version: string): DomainEventSchema | undefined {
    return this.schemas.get(eventName)?.get(version);
  }

  public validateProducerEvent(event: DomainEventEnvelope): void {
    if (!event.eventName || !event.schemaVersion || !event.payload) {
      throw new DomainEventValidationError(
        event.eventName || 'UNKNOWN',
        event.schemaVersion || 'UNKNOWN',
        ['envelope_structure'],
      );
    }

    const schema = this.getSchema(event.eventName, event.schemaVersion);
    if (!schema) {
      throw new UnknownEventVersionError(event.eventName, event.schemaVersion);
    }

    const missingOrInvalid: string[] = [];

    for (const field of schema.fields) {
      const val = event.payload[field.name];

      if (field.required && (val === undefined || val === null || val === '')) {
        missingOrInvalid.push(field.name);
        continue;
      }

      if (val !== undefined && val !== null) {
        if (field.type === 'array' && !Array.isArray(val)) {
          missingOrInvalid.push(`${field.name} (expected array)`);
        } else if (field.type !== 'array' && typeof val !== field.type) {
          missingOrInvalid.push(`${field.name} (expected ${field.type})`);
        }
      }
    }

    if (missingOrInvalid.length > 0) {
      throw new DomainEventValidationError(
        event.eventName,
        event.schemaVersion,
        missingOrInvalid,
      );
    }
  }

  private registerDefaultSchemas(): void {
    // Default core event schemas
    this.registerSchema({
      eventName: 'user.created',
      version: '1.0',
      fields: [
        { name: 'userId', type: 'string', required: true },
        { name: 'email', type: 'string', required: true },
        { name: 'role', type: 'string', required: true },
      ],
    });

    this.registerSchema({
      eventName: 'user.created',
      version: '2.0',
      fields: [
        { name: 'userId', type: 'string', required: true },
        { name: 'email', type: 'string', required: true },
        { name: 'role', type: 'string', required: true },
        { name: 'kycTier', type: 'string', required: true },
      ],
    });

    this.registerSchema({
      eventName: 'payment.completed',
      version: '1.0',
      fields: [
        { name: 'transactionId', type: 'string', required: true },
        { name: 'amount', type: 'number', required: true },
        { name: 'currency', type: 'string', required: true },
      ],
    });
  }
}

/**
 * Producer class responsible for validating and publishing domain events.
 */
export class DomainEventProducer {
  constructor(
    private registry: DomainEventRegistry = DomainEventRegistry.getInstance(),
    private publishTransport?: (event: DomainEventEnvelope) => Promise<void> | void,
  ) {}

  public async publish(event: DomainEventEnvelope): Promise<DomainEventEnvelope> {
    // Producer-side schema validation
    this.registry.validateProducerEvent(event);

    if (this.publishTransport) {
      await this.publishTransport(event);
    }
    return event;
  }
}

export type EventHandler<T = any> = (event: DomainEventEnvelope<T>) => Promise<any> | any;

/**
 * Versioned Consumer with fallback capabilities for older or drift versions.
 */
export class VersionedDomainEventConsumer {
  private handlers: Map<string, Map<string, EventHandler>> = new Map();
  private fallbackHandlers: Map<string, EventHandler> = new Map();

  public registerHandler(
    eventName: string,
    schemaVersion: string,
    handler: EventHandler,
  ): void {
    if (!this.handlers.has(eventName)) {
      this.handlers.set(eventName, new Map());
    }
    this.handlers.get(eventName)!.set(schemaVersion, handler);
  }

  public registerFallbackHandler(eventName: string, handler: EventHandler): void {
    this.fallbackHandlers.set(eventName, handler);
  }

  public async consume(event: DomainEventEnvelope): Promise<{
    handled: boolean;
    result: any;
    usedFallback: boolean;
  }> {
    const versionMap = this.handlers.get(event.eventName);
    const handler = versionMap?.get(event.schemaVersion);

    if (handler) {
      const result = await handler(event);
      return { handled: true, result, usedFallback: false };
    }

    // Try fallback handler if specific version handler is missing or unknown
    const fallback = this.fallbackHandlers.get(event.eventName);
    if (fallback) {
      const result = await fallback(event);
      return { handled: true, result, usedFallback: true };
    }

    throw new UnknownEventVersionError(event.eventName, event.schemaVersion);
  }
}

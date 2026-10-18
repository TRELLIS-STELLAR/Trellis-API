import {
  DomainEventRegistry,
  DomainEventProducer,
  VersionedDomainEventConsumer,
  DomainEventEnvelope,
  DomainEventValidationError,
  UnknownEventVersionError,
} from './domain-event-schema';

describe('Structured Domain Event Schema with Versioned Consumers (#116)', () => {
  let registry: DomainEventRegistry;
  let producer: DomainEventProducer;
  let consumer: VersionedDomainEventConsumer;

  beforeEach(() => {
    registry = DomainEventRegistry.getInstance();
    producer = new DomainEventProducer(registry);
    consumer = new VersionedDomainEventConsumer();
  });

  it('should validate and publish a valid domain event with explicit schema version', async () => {
    const validEvent: DomainEventEnvelope = {
      eventId: 'evt-101',
      eventName: 'user.created',
      schemaVersion: '1.0',
      timestamp: new Date().toISOString(),
      producer: 'user-service',
      payload: {
        userId: 'u-123',
        email: 'alice@trellis.example',
        role: 'user',
      },
    };

    const published = await producer.publish(validEvent);
    expect(published).toBe(validEvent);
    expect(published.schemaVersion).toBe('1.0');
  });

  it('should reject event publishing when missing a required payload field (producer-side validation)', async () => {
    const invalidEvent: DomainEventEnvelope = {
      eventId: 'evt-102',
      eventName: 'user.created',
      schemaVersion: '1.0',
      timestamp: new Date().toISOString(),
      producer: 'user-service',
      payload: {
        userId: 'u-123',
        // missing email and role
      },
    };

    await expect(producer.publish(invalidEvent)).rejects.toThrow(
      DomainEventValidationError,
    );
  });

  it('should handle unknown version with UnknownEventVersionError', async () => {
    const unknownVersionEvent: DomainEventEnvelope = {
      eventId: 'evt-103',
      eventName: 'user.created',
      schemaVersion: '99.0', // non-existent version
      timestamp: new Date().toISOString(),
      producer: 'user-service',
      payload: {
        userId: 'u-123',
        email: 'test@example.com',
        role: 'user',
      },
    };

    await expect(producer.publish(unknownVersionEvent)).rejects.toThrow(
      UnknownEventVersionError,
    );
  });

  it('should invoke exact version handler when available', async () => {
    const v1Handler = jest.fn().mockReturnValue('v1_processed');
    consumer.registerHandler('user.created', '1.0', v1Handler);

    const event: DomainEventEnvelope = {
      eventId: 'evt-104',
      eventName: 'user.created',
      schemaVersion: '1.0',
      timestamp: new Date().toISOString(),
      producer: 'user-service',
      payload: { userId: 'u-1', email: 'a@b.com', role: 'user' },
    };

    const res = await consumer.consume(event);
    expect(res.handled).toBe(true);
    expect(res.usedFallback).toBe(false);
    expect(res.result).toBe('v1_processed');
    expect(v1Handler).toHaveBeenCalledWith(event);
  });

  it('should fallback to consumer fallback handler when specific version handler is missing', async () => {
    const fallbackHandler = jest.fn().mockReturnValue('fallback_processed');
    consumer.registerFallbackHandler('user.created', fallbackHandler);

    const eventV2: DomainEventEnvelope = {
      eventId: 'evt-105',
      eventName: 'user.created',
      schemaVersion: '2.0',
      timestamp: new Date().toISOString(),
      producer: 'user-service',
      payload: { userId: 'u-2', email: 'b@b.com', role: 'user', kycTier: 'TIER_2' },
    };

    const res = await consumer.consume(eventV2);
    expect(res.handled).toBe(true);
    expect(res.usedFallback).toBe(true);
    expect(res.result).toBe('fallback_processed');
    expect(fallbackHandler).toHaveBeenCalledWith(eventV2);
  });
});

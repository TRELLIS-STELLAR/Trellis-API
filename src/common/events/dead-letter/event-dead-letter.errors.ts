/** Raised when replaying or discarding a dead letter that does not exist. */
export class DeadLetterNotFoundError extends Error {
  constructor(public readonly deadLetterId: string) {
    super(`Dead letter '${deadLetterId}' was not found`);
    this.name = "DeadLetterNotFoundError";
  }
}

/** Raised when the requester may not perform an operator action. */
export class DeadLetterAuthorizationError extends Error {
  constructor(message = "Only ADMIN or MAINTAINER may recover dead letters") {
    super(message);
    this.name = "DeadLetterAuthorizationError";
  }
}

/** Raised when replaying an event that no longer has a registered handler. */
export class DomainEventHandlerNotFoundError extends Error {
  constructor(eventName: string, handlerName: string) {
    super(`No handler '${handlerName}' registered for event '${eventName}'`);
    this.name = "DomainEventHandlerNotFoundError";
  }
}

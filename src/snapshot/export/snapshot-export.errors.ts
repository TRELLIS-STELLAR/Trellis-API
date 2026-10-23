/** Errors raised by the snapshot export service. */

export class SnapshotExportAuthorizationError extends Error {
  constructor(message = "Not authorised to access this snapshot export") {
    super(message);
    this.name = "SnapshotExportAuthorizationError";
  }
}

/**
 * Raised when the export could not be produced because a dependency (the
 * signing-key provider) was temporarily unavailable after retries. The
 * controller maps this to HTTP 503 with a `Retry-After` header.
 */
export class SnapshotExportRetryableError extends Error {
  constructor(
    message = "Snapshot export signing key provider is temporarily unavailable",
    public readonly retryAfterSeconds = 1,
  ) {
    super(message);
    this.name = "SnapshotExportRetryableError";
  }
}

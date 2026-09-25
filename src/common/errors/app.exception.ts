import { HttpException, HttpStatus } from "@nestjs/common";
import { ErrorCode, ErrorDomain } from "./error-codes";
import { getErrorTaxonomy } from "./error-taxonomy";

export interface ErrorResponse {
  statusCode: number;
  errorCode: ErrorCode;
  domain?: ErrorDomain;
  message: string | object;
  recoveryGuidance?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  correlationId: string;
  timestamp: string;
  path: string;
  errors?: Record<string, string[]>;
}

export class AppException extends HttpException {
  public readonly errorCode: ErrorCode;
  public readonly domain: ErrorDomain;
  public readonly retryable: boolean;
  public readonly retryAfterSeconds?: number;
  public readonly recoveryGuidance: string;

  constructor(
    message: string,
    status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    errorCode: ErrorCode = ErrorCode.INTERNAL_ERROR,
    options?: {
      domain?: ErrorDomain;
      retryable?: boolean;
      retryAfterSeconds?: number;
      recoveryGuidance?: string;
    },
  ) {
    super(message, status);
    this.errorCode = errorCode;

    const taxonomy = getErrorTaxonomy(errorCode);
    this.domain = options?.domain ?? taxonomy.domain;
    this.retryable = options?.retryable ?? taxonomy.retryable;
    this.retryAfterSeconds =
      options?.retryAfterSeconds ?? taxonomy.retryAfterSeconds;
    this.recoveryGuidance =
      options?.recoveryGuidance ?? taxonomy.recoveryGuidance;
  }
}

export class NotFoundException extends AppException {
  constructor(message = "Resource not found") {
    super(message, HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND);
  }
}

export class UnauthorizedException extends AppException {
  constructor(message = "Unauthorized") {
    super(message, HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED);
  }
}

export class ForbiddenException extends AppException {
  constructor(message = "Forbidden") {
    super(message, HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN);
  }
}

export class BadRequestException extends AppException {
  constructor(message = "Bad request") {
    super(message, HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR);
  }
}

export class ConflictException extends AppException {
  constructor(message = "Resource conflict") {
    super(message, HttpStatus.CONFLICT, ErrorCode.CONFLICT);
  }
}

export class RateLimitException extends AppException {
  constructor(message = "Too many requests", retryAfterSeconds = 60) {
    super(message, HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED, {
      retryable: true,
      retryAfterSeconds,
    });
  }
}

// ---------------------------------------------------------------------------
// Domain-Specific Exceptions (Settlement, Payment, Blockchain, Reconciliation)
// ---------------------------------------------------------------------------

export class SettlementFailedException extends AppException {
  constructor(message = "Stellar settlement execution failed") {
    super(message, HttpStatus.BAD_REQUEST, ErrorCode.SETTLEMENT_FAILED, {
      domain: ErrorDomain.SETTLEMENT,
      retryable: false,
    });
  }
}

export class SettlementTimeoutException extends AppException {
  constructor(
    message = "Settlement confirmation timed out on network",
    retryAfterSeconds = 5,
  ) {
    super(message, HttpStatus.GATEWAY_TIMEOUT, ErrorCode.SETTLEMENT_TIMEOUT, {
      domain: ErrorDomain.SETTLEMENT,
      retryable: true,
      retryAfterSeconds,
    });
  }
}

export class InsufficientFundsException extends AppException {
  constructor(message = "Insufficient funds for payment") {
    super(message, HttpStatus.BAD_REQUEST, ErrorCode.INSUFFICIENT_FUNDS, {
      domain: ErrorDomain.SETTLEMENT,
      retryable: false,
    });
  }
}

export class DuplicatePaymentException extends AppException {
  constructor(message = "Duplicate payment submission detected") {
    super(
      message,
      HttpStatus.CONFLICT,
      ErrorCode.DUPLICATE_PAYMENT_SUBMISSION,
      {
        domain: ErrorDomain.PAYMENT,
        retryable: false,
      },
    );
  }
}

export class ReconciliationMismatchException extends AppException {
  constructor(message = "Reconciliation mismatch detected") {
    super(message, HttpStatus.CONFLICT, ErrorCode.RECONCILIATION_MISMATCH, {
      domain: ErrorDomain.RECONCILIATION,
      retryable: false,
    });
  }
}

export class StellarNetworkException extends AppException {
  constructor(
    message = "Stellar network communication error",
    retryAfterSeconds = 5,
  ) {
    super(message, HttpStatus.BAD_GATEWAY, ErrorCode.STELLAR_NETWORK_ERROR, {
      domain: ErrorDomain.BLOCKCHAIN,
      retryable: true,
      retryAfterSeconds,
    });
  }
}

export class OptimizationFailedException extends AppException {
  constructor(
    message = "Portfolio optimization calculation failed",
    retryAfterSeconds = 3,
  ) {
    super(
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.OPTIMIZATION_FAILED,
      {
        domain: ErrorDomain.PORTFOLIO,
        retryable: true,
        retryAfterSeconds,
      },
    );
  }
}

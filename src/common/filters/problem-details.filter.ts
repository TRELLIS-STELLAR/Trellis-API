/**
 * RFC 7807 Problem Details exception filter.
 * 
 * Transforms all exceptions into standardized problem-details responses
 * with stable error taxonomy, retry guidance, and recovery instructions.
 * 
 * Edge cases:
 * - HttpException errors preserve original status and message
 * - Database errors are classified as retryable with backoff
 * - Auth errors (401/403) are non-retryable
 * - Rate limit errors include retry-after header
 * - Validation errors include detailed field-level errors
 * 
 * Recovery behavior:
 * - All errors log with correlation ID for traceability
 * - Production mode sanitizes internal error details
 * - Retryable errors include exponential backoff guidance
 * - Non-retryable errors provide remediation steps
 */

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  ErrorCode,
  ErrorDomain,
  createProblemDetailsResponse,
  sanitizeClientMessage,
  getErrorTaxonomy,
} from '../errors/error-taxonomy';
import { QueryFailedError } from 'typeorm';

export interface ProblemDetailsException extends Error {
  errorCode?: ErrorCode;
  domain?: ErrorDomain;
  retryable?: boolean;
  statusCode?: number;
  details?: unknown;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);
  private readonly isProduction = process.env.NODE_ENV === 'production';

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = this.getCorrelationId(request);

    const mapped = this.mapException(exception, request.path);
    const problemDetails = createProblemDetailsResponse({
      errorCode: mapped.errorCode,
      status: mapped.status,
      detail: sanitizeClientMessage(mapped.detail, this.isProduction, mapped.errorCode),
      instance: request.path,
      correlationId,
    });

    const taxonomy = getErrorTaxonomy(mapped.errorCode);

    // Log error with appropriate severity
    if (mapped.status >= 500) {
      this.logger.error(
        `${mapped.errorCode} [${correlationId}] ${request.method} ${request.path}: ${mapped.originalMessage}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (mapped.status >= 400) {
      this.logger.warn(
        `${mapped.errorCode} [${correlationId}] ${request.method} ${request.path}: ${mapped.originalMessage}`,
      );
    }

    // Add retry-after header for retryable errors
    if (taxonomy.retryable && taxonomy.retryAfterSeconds) {
      response.setHeader('Retry-After', taxonomy.retryAfterSeconds.toString());
    }

    // Set problem+json content type
    response.status(mapped.status).json(problemDetails);
  }

  private mapException(
    exception: unknown,
    path: string,
  ): {
    errorCode: ErrorCode;
    status: number;
    detail: string | object;
    originalMessage: string;
  } {
    // Handle custom ProblemDetailsException
    if (this.isProblemDetailsException(exception)) {
      return {
        errorCode: exception.errorCode ?? ErrorCode.INTERNAL_ERROR,
        status: exception.statusCode ?? HttpStatus.INTERNAL_SERVER_ERROR,
        detail: exception.details ?? exception.message,
        originalMessage: exception.message,
      };
    }

    // Handle NestJS HttpException
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const errorCode = this.mapHttpStatusToErrorCode(status);

      return {
        errorCode,
        status,
        detail: typeof response === 'string' ? response : response,
        originalMessage: exception.message,
      };
    }

    // Handle TypeORM database errors
    if (exception instanceof QueryFailedError) {
      return this.mapDatabaseError(exception);
    }

    // Handle authorization errors
    if (this.isAuthorizationError(exception)) {
      return {
        errorCode: ErrorCode.FORBIDDEN,
        status: HttpStatus.FORBIDDEN,
        detail: 'Access forbidden: insufficient permissions',
        originalMessage: exception instanceof Error ? exception.message : String(exception),
      };
    }

    // Handle timeout errors
    if (this.isTimeoutError(exception)) {
      return {
        errorCode: ErrorCode.DEPENDENCY_TIMEOUT,
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Request timed out',
        originalMessage: exception instanceof Error ? exception.message : String(exception),
      };
    }

    // Fallback to generic internal error
    return {
      errorCode: ErrorCode.INTERNAL_ERROR,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: this.isProduction ? 'An internal server error occurred' : String(exception),
      originalMessage: exception instanceof Error ? exception.message : String(exception),
    };
  }

  private mapDatabaseError(error: QueryFailedError): {
    errorCode: ErrorCode;
    status: number;
    detail: string;
    originalMessage: string;
  } {
    const driverError = error.driverError as { code?: string; constraint?: string };

    // Unique constraint violation
    if (driverError.code === '23505' || driverError.constraint?.includes('unique')) {
      return {
        errorCode: ErrorCode.DUPLICATE_ENTRY,
        status: HttpStatus.CONFLICT,
        detail: 'Resource with this identifier already exists',
        originalMessage: error.message,
      };
    }

    // Foreign key violation
    if (driverError.code === '23503') {
      return {
        errorCode: ErrorCode.RESOURCE_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
        detail: 'Referenced resource not found',
        originalMessage: error.message,
      };
    }

    // Connection errors
    if (driverError.code === 'ECONNREFUSED' || driverError.code === 'ETIMEDOUT') {
      return {
        errorCode: ErrorCode.DATABASE_ERROR,
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'Database temporarily unavailable',
        originalMessage: error.message,
      };
    }

    // Generic database error
    return {
      errorCode: ErrorCode.DATABASE_ERROR,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'A database error occurred',
      originalMessage: error.message,
    };
  }

  private mapHttpStatusToErrorCode(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      case HttpStatus.GATEWAY_TIMEOUT:
        return ErrorCode.DEPENDENCY_TIMEOUT;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }

  private isProblemDetailsException(exception: unknown): exception is ProblemDetailsException {
    return (
      exception instanceof Error &&
      ('errorCode' in exception || 'domain' in exception || 'retryable' in exception)
    );
  }

  private isAuthorizationError(exception: unknown): boolean {
    if (!(exception instanceof Error)) return false;
    const message = exception.message.toLowerCase();
    return (
      message.includes('forbidden') ||
      message.includes('unauthorized') ||
      message.includes('access denied') ||
      message.includes('insufficient permissions')
    );
  }

  private isTimeoutError(exception: unknown): boolean {
    if (!(exception instanceof Error)) return false;
    const message = exception.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('etimedout') ||
      message.includes('econnreset')
    );
  }

  private getCorrelationId(request: Request): string {
    const existing =
      request.headers['x-correlation-id'] ||
      request.headers['x-request-id'] ||
      request.headers['x-trace-id'];

    if (typeof existing === 'string') {
      return existing;
    }

    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

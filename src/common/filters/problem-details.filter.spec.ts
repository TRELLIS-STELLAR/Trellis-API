import { ProblemDetailsFilter } from './problem-details.filter';
import { HttpException, HttpStatus, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common';
import { ErrorCode } from '../errors/error-taxonomy';
import { QueryFailedError } from 'typeorm';

describe('ProblemDetailsFilter', () => {
  let filter: ProblemDetailsFilter;
  let mockResponse: any;
  let mockRequest: any;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new ProblemDetailsFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };
    mockRequest = {
      path: '/api/test',
      method: 'GET',
      headers: {},
    };
    mockHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as any;
  });

  describe('Normal path - HttpException mapping', () => {
    it('maps BadRequestException to VALIDATION_ERROR', () => {
      const exception = new BadRequestException('Invalid input');
      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.VALIDATION_ERROR,
          status: HttpStatus.BAD_REQUEST,
          retryable: false,
        }),
      );
    });

    it('maps NotFoundException to NOT_FOUND', () => {
      const exception = new NotFoundException('Resource not found');
      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.NOT_FOUND,
          status: HttpStatus.NOT_FOUND,
        }),
      );
    });

    it('maps ForbiddenException to FORBIDDEN with non-retryable status', () => {
      const exception = new ForbiddenException('Access denied');
      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.FORBIDDEN,
          retryable: false,
        }),
      );
    });
  });

  describe('Failure path - Database errors', () => {
    it('maps unique constraint violation to DUPLICATE_ENTRY', () => {
      const dbError = new QueryFailedError('INSERT', [], new Error('duplicate key'));
      (dbError as any).driverError = { code: '23505', constraint: 'users_email_unique' };

      filter.catch(dbError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.DUPLICATE_ENTRY,
          status: HttpStatus.CONFLICT,
        }),
      );
    });

    it('maps foreign key violation to RESOURCE_NOT_FOUND', () => {
      const dbError = new QueryFailedError('INSERT', [], new Error('foreign key'));
      (dbError as any).driverError = { code: '23503' };

      filter.catch(dbError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.RESOURCE_NOT_FOUND,
        }),
      );
    });

    it('maps connection errors to DATABASE_ERROR with retryable status', () => {
      const dbError = new QueryFailedError('SELECT', [], new Error('connection refused'));
      (dbError as any).driverError = { code: 'ECONNREFUSED' };

      filter.catch(dbError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.DATABASE_ERROR,
          retryable: true,
        }),
      );
    });
  });

  describe('Retry path - Retryable errors', () => {
    it('sets Retry-After header for retryable errors', () => {
      const exception = new HttpException('Service unavailable', HttpStatus.SERVICE_UNAVAILABLE);
      filter.catch(exception, mockHost);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Retry-After', '30');
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          retryable: true,
          retryAfterSeconds: 30,
        }),
      );
    });

    it('includes exponential backoff guidance for dependency timeouts', () => {
      const timeoutError = new Error('ETIMEDOUT');
      filter.catch(timeoutError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.GATEWAY_TIMEOUT);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.DEPENDENCY_TIMEOUT,
          retryable: true,
          retryStrategy: 'exponential_backoff',
        }),
      );
    });

    it('marks timeout errors as retryable', () => {
      const exception = new Error('Request timeout');
      filter.catch(exception, mockHost);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.DEPENDENCY_TIMEOUT,
          retryable: true,
        }),
      );
    });
  });

  describe('Authorization path', () => {
    it('detects authorization errors from message content', () => {
      const authError = new Error('Access denied: insufficient permissions');
      filter.catch(authError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.FORBIDDEN,
          retryable: false,
        }),
      );
    });

    it('provides remediation guidance for authorization failures', () => {
      const exception = new ForbiddenException('Insufficient role');
      filter.catch(exception, mockHost);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          remediation: expect.stringContaining('role or permissions'),
        }),
      );
    });
  });

  describe('Edge cases', () => {
    it('generates correlation ID when not provided', () => {
      const exception = new Error('Test error');
      filter.catch(exception, mockHost);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: expect.stringMatching(/^req_\d+_[a-z0-9]+$/),
        }),
      );
    });

    it('preserves existing correlation ID from headers', () => {
      mockRequest.headers['x-correlation-id'] = 'existing-correlation-id';
      const exception = new Error('Test error');
      filter.catch(exception, mockHost);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: 'existing-correlation-id',
        }),
      );
    });

    it('sanitizes internal error messages in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const filter = new ProblemDetailsFilter();

      const exception = new Error('Sensitive internal error with credentials');
      filter.catch(exception, mockHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.detail).not.toContain('credentials');

      process.env.NODE_ENV = originalEnv;
    });

    it('handles non-Error exceptions gracefully', () => {
      const exception = 'string error';
      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.INTERNAL_ERROR,
        }),
      );
    });

    it('includes instance path from request', () => {
      mockRequest.path = '/api/portfolio/123';
      const exception = new NotFoundException();
      filter.catch(exception, mockHost);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          instance: '/api/portfolio/123',
        }),
      );
    });

    it('includes problem type URL in response', () => {
      const exception = new BadRequestException();
      filter.catch(exception, mockHost);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: expect.stringContaining('https://trellis-stellar.github.io/Trellis-API/problems/'),
        }),
      );
    });
  });

  describe('Recovery behavior', () => {
    it('provides recovery guidance for all error types', () => {
      const exception = new HttpException('Service unavailable', HttpStatus.SERVICE_UNAVAILABLE);
      filter.catch(exception, mockHost);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          remediation: expect.any(String),
        }),
      );
    });

    it('includes timestamp for temporal context', () => {
      const exception = new Error('Test');
      filter.catch(exception, mockHost);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      );
    });
  });
});

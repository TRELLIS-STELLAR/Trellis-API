import { ArgumentsHost, HttpStatus, BadRequestException as NestBadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GlobalExceptionFilter } from "./global-exception.filter";
import {
  SettlementFailedException,
  SettlementTimeoutException,
  InsufficientFundsException,
  UnauthorizedException,
  ForbiddenException,
} from "../errors/app.exception";
import { ErrorCode, ErrorDomain } from "../errors/error-codes";

describe("GlobalExceptionFilter", () => {
  let filter: GlobalExceptionFilter;
  let configService: ConfigService;
  let mockResponse: any;
  let mockRequest: any;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    configService = {
      get: jest.fn((key: string) => {
        if (key === "NODE_ENV") return "production";
        return null;
      }),
    } as unknown as ConfigService;

    filter = new GlobalExceptionFilter(configService);

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };

    mockRequest = {
      url: "/api/v1/stellar/settlement",
      method: "POST",
      headers: {},
      query: {},
      params: {},
      ip: "127.0.0.1",
    };

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  describe("Validation Errors", () => {
    it("renders structured validation error with domain and recovery guidance", () => {
      const validationError = new NestBadRequestException({
        message: ["amount must be a positive number", "recipient must be a valid address"],
        error: "Bad Request",
        statusCode: 400,
      });

      filter.catch(validationError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          errorCode: ErrorCode.VALIDATION_ERROR,
          domain: ErrorDomain.VALIDATION,
          message: "Validation failed",
          retryable: false,
          errors: {
            amount: ["amount must be a positive number"],
            recipient: ["recipient must be a valid address"],
          },
          recoveryGuidance: expect.stringContaining("Review the request body"),
          correlationId: expect.any(String),
          path: "/api/v1/stellar/settlement",
        }),
      );
    });
  });

  describe("Authorization & RBAC Errors", () => {
    it("renders unauthorized error with auth domain and login guidance", () => {
      filter.catch(new UnauthorizedException(), mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 401,
          errorCode: ErrorCode.UNAUTHORIZED,
          domain: ErrorDomain.AUTH,
          retryable: false,
          recoveryGuidance: expect.stringContaining("Bearer token"),
        }),
      );
    });

    it("renders forbidden error when permission check fails", () => {
      filter.catch(new ForbiddenException("Insufficient permissions"), mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          errorCode: ErrorCode.FORBIDDEN,
          domain: ErrorDomain.AUTH,
          retryable: false,
        }),
      );
    });
  });

  describe("Settlement & Payment Errors", () => {
    it("renders fatal settlement failure (non-retryable)", () => {
      filter.catch(
        new SettlementFailedException("Stellar sequence mismatch"),
        mockHost,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          errorCode: ErrorCode.SETTLEMENT_FAILED,
          domain: ErrorDomain.SETTLEMENT,
          retryable: false,
          message: "Stellar sequence mismatch",
        }),
      );
    });

    it("renders settlement timeout with retryability and retryAfterSeconds metadata", () => {
      filter.catch(
        new SettlementTimeoutException(
          "Stellar Horizon did not confirm transaction",
          10,
        ),
        mockHost,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.GATEWAY_TIMEOUT);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 504,
          errorCode: ErrorCode.SETTLEMENT_TIMEOUT,
          domain: ErrorDomain.SETTLEMENT,
          retryable: true,
          retryAfterSeconds: 10,
          recoveryGuidance: expect.stringContaining("Verify transaction status"),
        }),
      );
    });

    it("renders insufficient funds error with funding guidance", () => {
      filter.catch(
        new InsufficientFundsException("Account lacks balance for 100 XLM"),
        mockHost,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          errorCode: ErrorCode.INSUFFICIENT_FUNDS,
          domain: ErrorDomain.SETTLEMENT,
          retryable: false,
          recoveryGuidance: expect.stringContaining("Ensure the source wallet holds sufficient balance"),
        }),
      );
    });
  });

  describe("Unexpected & Internal Errors", () => {
    it("sanitizes database errors in production to avoid leaking SQL or connection details", () => {
      const rawDbError = new Error(
        "Connection refused at postgresql://postgres:password123@localhost:5432/swaptrade - SELECT * FROM users WHERE secret_key = 'abc'",
      );

      filter.catch(rawDbError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          errorCode: ErrorCode.INTERNAL_ERROR,
          domain: ErrorDomain.SYSTEM,
          message: "An internal server error occurred",
          retryable: false,
          recoveryGuidance: expect.stringContaining("quote the correlationId"),
        }),
      );
      // Ensure leaked password or SQL is NOT present in response
      const payload = mockResponse.json.mock.calls[0][0];
      expect(JSON.stringify(payload)).not.toContain("password123");
      expect(JSON.stringify(payload)).not.toContain("SELECT *");
    });

    it("preserves incoming correlationId from header", () => {
      mockRequest.headers["x-correlation-id"] = "custom-trace-uuid-1234";

      filter.catch(new Error("Crash"), mockHost);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        "x-correlation-id",
        "custom-trace-uuid-1234",
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: "custom-trace-uuid-1234",
        }),
      );
    });
  });
});

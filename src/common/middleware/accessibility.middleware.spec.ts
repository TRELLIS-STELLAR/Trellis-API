import { Test, TestingModule } from "@nestjs/testing";
import { AccessibilityMiddleware } from "../middleware/accessibility.middleware";
import { Request, Response, NextFunction } from "express";

describe("AccessibilityMiddleware", () => {
  let middleware: AccessibilityMiddleware;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AccessibilityMiddleware],
    }).compile();

    middleware = module.get<AccessibilityMiddleware>(AccessibilityMiddleware);

    mockReq = {
      headers: {},
      url: "/test",
    };
    mockRes = {
      setHeader: jest.fn(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
  });

  it("should add security headers", () => {
    middleware.use(mockReq as Request, mockRes as Response, mockNext);
    expect(mockRes.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
    expect(mockRes.setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
    expect(mockNext).toHaveBeenCalled();
  });

  it("should inject accessibility metadata into error responses", () => {
    middleware.use(mockReq as Request, mockRes as Response, mockNext);

    const errorBody = {
      statusCode: 400,
      message: "Validation failed",
      errors: { name: ["Name is required"] },
    };

    (mockRes.json as jest.Mock)(errorBody);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        _accessibility: {
          description: "Validation failed",
          suggestion: "Check the request body for missing or invalid fields.",
        },
      }),
    );
  });

  it("should not inject accessibility metadata into successful responses", () => {
    middleware.use(mockReq as Request, mockRes as Response, mockNext);

    const successBody = {
      statusCode: 200,
      data: { id: 1 },
    };

    (mockRes.json as jest.Mock)(successBody);
    expect(mockRes.json).toHaveBeenCalledWith(successBody);
  });
});

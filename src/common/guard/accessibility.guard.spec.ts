import { Test, TestingModule } from "@nestjs/testing";
import { ACCESSIBILITY_METADATA, Accessibility, AccessibilityOptions } from "../decorators/accessibility.decorator";
import { AccessibilityGuard } from "../guard/accessibility.guard";
import { CanActivate, ExecutionContext, BadRequestException } from "@nestjs/common";

describe("AccessibilityGuard", () => {
  let guard: AccessibilityGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AccessibilityGuard],
    }).compile();

    guard = module.get<AccessibilityGuard>(AccessibilityGuard);
  });

  describe("canActivate", () => {
    it("should allow access when no accessibility metadata is set", () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {},
          }),
        }),
        getHandler: () => ({}),
      } as unknown as ExecutionContext;

      expect(guard.canActivate(mockContext)).toBe(true);
    });

    it("should allow access for non-JSON requests", () => {
      const options: AccessibilityOptions = {
        description: "Test endpoint",
        screenReaderFriendly: true,
      };

      const mockHandler = () => {};
      Reflect.defineMetadata(ACCESSIBILITY_METADATA, options, mockHandler);

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {
              accept: "text/html",
            },
          }),
        }),
        getHandler: () => mockHandler,
      } as unknown as ExecutionContext;

      expect(guard.canActivate(mockContext)).toBe(true);
    });

    it("should throw for JSON requests without screen reader header", () => {
      const options: AccessibilityOptions = {
        description: "Test endpoint",
        screenReaderFriendly: true,
      };

      const mockHandler = () => {};
      Reflect.defineMetadata(ACCESSIBILITY_METADATA, options, mockHandler);

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {
              accept: "application/json",
            },
          }),
        }),
        getHandler: () => mockHandler,
      } as unknown as ExecutionContext;

      expect(guard.canActivate(mockContext)).toBe(false);
      expect(() => guard.canActivate(mockContext)).toThrow(BadRequestException);
    });

    it("should allow access for JSON requests with screen reader header", () => {
      const options: AccessibilityOptions = {
        description: "Test endpoint",
        screenReaderFriendly: true,
      };

      const mockHandler = () => {};
      Reflect.defineMetadata(ACCESSIBILITY_METADATA, options, mockHandler);

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {
              accept: "application/json",
              "x-screen-reader-supported": "true",
            },
          }),
        }),
        getHandler: () => mockHandler,
      } as unknown as ExecutionContext;

      expect(guard.canActivate(mockContext)).toBe(true);
    });
  });
});

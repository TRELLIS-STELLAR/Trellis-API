import { Injectable, NestMiddleware, BadRequestException } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";

/**
 * Accessibility middleware (Issue #39).
 *
 * Ensures API responses include accessibility-friendly headers and
 * validates that error responses include structured error descriptions.
 */
@Injectable()
export class AccessibilityMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Add accessibility headers
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id, X-Correlation-Id");

    // Wrap res.json to inject accessibility metadata for error responses
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      if (body && typeof body === "object" && body.statusCode >= 400) {
        const accessibleBody = {
          ...body,
          _accessibility: {
            description: body.message || "An error occurred",
            fieldErrors: body.errors || {},
            suggestion: this.getSuggestion(body.statusCode),
          },
        };
        return originalJson(accessibleBody);
      }
      return originalJson(body);
    };

    next();
  }

  private getSuggestion(statusCode: number): string {
    switch (statusCode) {
      case 400:
        return "Check the request body for missing or invalid fields.";
      case 401:
        return "Provide a valid authorization token.";
      case 403:
        return "You do not have permission to access this resource.";
      case 404:
        return "The requested resource was not found.";
      case 429:
        return "Too many requests. Please retry after some time.";
      default:
        return "Contact support if the problem persists.";
    }
  }
}

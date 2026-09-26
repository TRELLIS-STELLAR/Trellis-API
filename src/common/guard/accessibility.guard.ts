import { Injectable, CanActivate, ExecutionContext, BadRequestException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ACCESSIBILITY_METADATA, getAccessibilityOptions } from "../decorators/accessibility.decorator";

@Injectable()
export class AccessibilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = getAccessibilityOptions(context.getHandler());
    if (!options) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const acceptHeader = request.headers.accept;

    if (options.screenReaderFriendly && acceptHeader && acceptHeader.includes("application/json")) {
      if (!request.headers["x-screen-reader-supported"]) {
        throw new BadRequestException({
          message: "Screen reader support required",
          _accessibility: {
            description: options.description,
            suggestion: "Set X-Screen-Reader-Supported: true header to indicate assistive technology usage.",
          },
        });
      }
    }

    return true;
  }
}

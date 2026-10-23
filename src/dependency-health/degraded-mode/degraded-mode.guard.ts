import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AppException } from "../../common/errors/app.exception";
import { ErrorCode } from "../../common/errors/error-codes";
import { DependencyDegradedModeService } from "./degraded-mode.service";
import { DegradedModeCapabilityBlockedError } from "./degraded-mode.errors";
import { DegradedCapability } from "./degraded-mode.types";
import { REQUIRES_CAPABILITY_KEY } from "./requires-capability.decorator";

/**
 * Enforces the degraded mode at the request boundary (issue #267).
 *
 * Registered globally after the application's auth guards. Routes without
 * `@RequiresCapability` return immediately, without evaluating the mode. A
 * blocked route gets a user-safe 503 `SERVICE_UNAVAILABLE` and a `Retry-After`
 * header: the message names only the capability, never the failing
 * dependency or its diagnostics, which stay in the operator-only mode endpoints
 * and the server log.
 */
@Injectable()
export class DegradedModeGuard implements CanActivate {
  private readonly logger = new Logger(DegradedModeGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly degradedMode: DependencyDegradedModeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const capability = this.reflector.getAllAndOverride<DegradedCapability>(
      REQUIRES_CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!capability) return true;
    try {
      await this.degradedMode.assertCapabilityEnabled(capability);
      return true;
    } catch (error) {
      if (!(error instanceof DegradedModeCapabilityBlockedError)) throw error;
      this.logger.warn(`Blocked '${capability}' request: ${error.reason}`);
      const blocked = new AppException(
        `The ${capability} service is temporarily unavailable. Please retry shortly.`,
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_UNAVAILABLE,
      );
      // RFC 9110 §10.2.3: delay-seconds tells clients when to retry a 503.
      context
        .switchToHttp()
        .getResponse()
        .setHeader?.("Retry-After", String(blocked.retryAfterSeconds));
      throw blocked;
    }
  }
}

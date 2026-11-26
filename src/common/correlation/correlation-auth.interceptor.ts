import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { getCorrelationId } from "./correlation-context";

/**
 * Interceptor that logs correlation IDs during authorization flows.
 * This helps trace authentication and authorization decisions across the request lifecycle.
 * 
 * Applied automatically to all routes protected by authentication guards.
 */
@Injectable()
export class CorrelationAuthInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CorrelationAuthInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const correlationId = getCorrelationId();
    
    const authType = request.authType || "unknown";
    const userId = request.user?.id || "anonymous";
    
    this.logger.log({
      correlationId,
      authType,
      userId,
      path: request.path,
      method: request.method,
      message: "Authorization flow initiated",
    });

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log({
            correlationId,
            authType,
            userId,
            path: request.path,
            message: "Authorization flow completed successfully",
          });
        },
        error: (error) => {
          this.logger.error({
            correlationId,
            authType,
            userId,
            path: request.path,
            error: error.message,
            message: "Authorization flow failed",
          });
        },
      }),
    );
  }
}

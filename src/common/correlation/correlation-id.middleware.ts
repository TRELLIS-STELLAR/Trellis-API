import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  resolveInboundCorrelationId,
  runWithCorrelation,
} from "./correlation-context";

/**
 * First middleware in the chain. Resolves one validated correlation ID per
 * request, echoes it on the response before any guard can reject the request,
 * and rewrites the inbound ID headers so the existing consumers
 * (HttpLoggingMiddleware, TracingInterceptor, RequestTimingMiddleware,
 * GlobalExceptionFilter) all observe the same sanitized value.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const resolved = resolveInboundCorrelationId(
      req.headers as Record<string, unknown>,
    );
    const { correlationId } = resolved;

    req.headers[CORRELATION_ID_HEADER] = correlationId;
    req.headers[REQUEST_ID_HEADER] = correlationId;
    (req as any).correlationId = correlationId;
    (req as any).requestId = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    res.setHeader(REQUEST_ID_HEADER, correlationId);

    runWithCorrelation(resolved, () => next());
  }
}

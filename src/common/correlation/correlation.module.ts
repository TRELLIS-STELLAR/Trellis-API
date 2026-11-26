import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { CorrelationAuthInterceptor } from "./correlation-auth.interceptor";
import { CorrelationHttpInterceptor } from "./correlation-http.interceptor";

/**
 * Module providing end-to-end correlation ID infrastructure.
 * 
 * Exports:
 * - CorrelationAuthInterceptor: Tracks correlation through auth flows
 * - CorrelationHttpInterceptor: Propagates correlation to outbound HTTP calls
 * 
 * The CorrelationIdMiddleware should be registered in AppModule's configure() method.
 */
@Module({
  imports: [HttpModule],
  providers: [CorrelationAuthInterceptor, CorrelationHttpInterceptor],
  exports: [CorrelationAuthInterceptor, CorrelationHttpInterceptor],
})
export class CorrelationModule {}

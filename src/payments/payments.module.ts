import { HttpModule } from "@nestjs/axios";
import {
  MiddlewareConsumer,
  Module,
  NestModule,
  OnModuleInit,
  RequestMethod,
} from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DiscoveryModule, DiscoveryService, Reflector } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Horizon } from "@stellar/stellar-sdk";
import { GrantfoxAdapter } from "./adapters/grantfox/grantfox.adapter";
import { StellarAdapter } from "./adapters/stellar/stellar.adapter";
import {
  DEFAULT_HORIZON_URL,
  STELLAR_HORIZON_SERVER,
} from "./adapters/stellar/stellar.constants";
import { PAYMENT_PROCESSOR_METADATA } from "./decorators/register-payment-processor.decorator";
import { IPaymentProcessor } from "./interfaces/payment-processor.interface";
import { PaymentProcessorFactory } from "./payment-processor.factory";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PaymentProcessorRegistry } from "./registry/payment-processor.registry";
import { StellarPaymentsController } from "./stellar-payments.controller";
import { PaymentWebhookService } from "./webhooks/payment-webhook.service";
import { PaymentWebhooksController } from "./webhooks/payment-webhooks.controller";
import { RawBodyMiddleware } from "./webhooks/raw-body.middleware";
import { WebhookSignatureGuard } from "./webhooks/webhook-signature.guard";
import { WebhookSignatureService } from "./webhooks/webhook-signature.service";

/**
 * Wires the payment-processor plugin system.
 *
 * Imports only Config/Http/Discovery (no TypeORM/Bull/Redis) so the module
 * boots standalone in integration tests. Adapters tagged with
 * `@RegisterPaymentProcessor()` are auto-registered on init — adding a new
 * processor means adding one provider here (or anywhere Nest can discover it),
 * with no change to the registry, factory, controller, or this init logic.
 *
 * The Stellar Horizon `Server` is provided via {@link STELLAR_HORIZON_SERVER}
 * so tests can override it with an in-memory fake (no network I/O offline).
 */
@Module({
  imports: [ConfigModule, HttpModule, DiscoveryModule],
  // Static segments MUST precede dynamic ones: both
  // `payments/webhooks/:provider` and `payments/stellar/{submit,status}` would
  // otherwise be shadowed by the generic `payments/:id/{submit,status}` routes
  // (Express matches in registration order). See the notes in
  // stellar-payments.controller.ts and webhooks/payment-webhooks.controller.ts.
  controllers: [
    PaymentWebhooksController,
    StellarPaymentsController,
    PaymentsController,
  ],
  providers: [
    PaymentProcessorRegistry,
    PaymentProcessorFactory,
    PaymentsService,
    WebhookSignatureService,
    PaymentWebhookService,
    WebhookSignatureGuard,
    RawBodyMiddleware,
    StellarAdapter,
    GrantfoxAdapter,
    {
      provide: STELLAR_HORIZON_SERVER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>(
          "STELLAR_HORIZON_URL",
          DEFAULT_HORIZON_URL,
        );
        return new Horizon.Server(url);
      },
    },
  ],
  exports: [PaymentProcessorRegistry, PaymentProcessorFactory, PaymentsService],
})
export class PaymentsModule implements OnModuleInit, NestModule {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly registry: PaymentProcessorRegistry,
  ) {}

  /**
   * Preserve the exact bytes of a webhook delivery before any guard runs.
   *
   * Scoped to the webhook route so the rest of the API keeps its parsed body
   * and no other endpoint pays the cost of retaining a second copy.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RawBodyMiddleware).forRoutes({
      path: "payments/webhooks/:provider",
      method: RequestMethod.POST,
    });
  }

  /**
   * Discover every provider tagged `@RegisterPaymentProcessor()` and register
   * it. Matching only on our metadata key keeps this from picking up the DeFi
   * protocol adapters (which lack the key).
   */
  onModuleInit(): void {
    for (const wrapper of this.discoveryService.getProviders()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) {
        continue;
      }
      const isProcessor = this.reflector.get<boolean>(
        PAYMENT_PROCESSOR_METADATA,
        metatype,
      );
      if (isProcessor) {
        this.registry.register(instance as IPaymentProcessor);
      }
    }
  }
}

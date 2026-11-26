import { Module } from "@nestjs/common";
import { BackgroundWorkerController } from "./background-worker.controller";
import { BackgroundWorkerService } from "./background-worker.service";
import { ConcurrencyLimiterService } from "./concurrency-limiter.service";
import { BullModule } from "@nestjs/bull";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { EventEmitterModule } from "@nestjs/event-emitter";

/**
 * Workers module for delayed and retryable background jobs with dead-letter
 * inspection and safe retry tooling.
 */
@Module({
  imports: [
    BullModule.registerQueueAsync({
      name: "background-jobs",
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get<string>("REDIS_HOST", "localhost"),
          port: configService.get<number>("REDIS_PORT", 6379),
          password: configService.get<string>("REDIS_PASSWORD"),
        },
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 200,
          attempts: 3,
        },
      }),
    }),
    EventEmitterModule.forRoot(),
  ],
  controllers: [BackgroundWorkerController],
  providers: [BackgroundWorkerService, ConcurrencyLimiterService],
  exports: [BackgroundWorkerService, ConcurrencyLimiterService],
})
export class WorkersModule {}

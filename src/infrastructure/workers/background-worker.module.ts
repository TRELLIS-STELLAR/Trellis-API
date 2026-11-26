import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { BackgroundWorkerService } from "./background-worker.service";
import { ConcurrencyLimiterService } from "./concurrency-limiter.service";

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
  providers: [BackgroundWorkerService, ConcurrencyLimiterService],
  exports: [BackgroundWorkerService, ConcurrencyLimiterService],
})
export class BackgroundWorkerModule {}

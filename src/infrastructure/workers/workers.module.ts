import { Module } from "@nestjs/common";
import { BackgroundWorkerController } from "./background-worker.controller";
import { BackgroundWorkerService } from "./background-worker.service";
import { DeadLetterInspectionController } from "./dead-letter-inspection.controller";
import { DeadLetterInspectionService } from "./dead-letter-inspection.service";
import { BullModule } from "@nestjs/bull";
import { ConfigModule, ConfigService } from "@nestjs/config";

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
  ],
  controllers: [BackgroundWorkerController, DeadLetterInspectionController],
  providers: [BackgroundWorkerService, DeadLetterInspectionService],
  exports: [BackgroundWorkerService, DeadLetterInspectionService],
})
export class WorkersModule {}

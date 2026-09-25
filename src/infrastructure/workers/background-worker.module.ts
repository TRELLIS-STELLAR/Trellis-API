import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BackgroundWorkerService } from "./background-worker.service";

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
  providers: [BackgroundWorkerService],
  exports: [BackgroundWorkerService],
})
export class BackgroundWorkerModule {}

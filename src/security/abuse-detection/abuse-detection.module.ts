import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AbuseDetectionController } from "./abuse-detection.controller";
import { AbuseDetectionGuard } from "./abuse-detection.guard";
import { AbuseDetectionService } from "./abuse-detection.service";

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [AbuseDetectionController],
  providers: [AbuseDetectionService, AbuseDetectionGuard],
  exports: [AbuseDetectionService, AbuseDetectionGuard],
})
export class AbuseDetectionModule {}

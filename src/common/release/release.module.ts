import { Module } from "@nestjs/common";
import { ReleaseChecklistController } from "./release-checklist.controller";
import { ReleaseChecklistService } from "./release-checklist.service";

@Module({
  controllers: [ReleaseChecklistController],
  providers: [ReleaseChecklistService],
  exports: [ReleaseChecklistService],
})
export class ReleaseModule {}

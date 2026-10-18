import { Module } from "@nestjs/common";
import { AuthModule } from "../../../core/auth/auth.module";
import { ProjectionReplayController } from "./projection-replay.controller";
import { ProjectionReplayService } from "./projection-replay.service";

/**
 * Versioned event replay for rebuilding projections (#278). Exports
 * `ProjectionReplayService` so owning modules can register their projections.
 */
@Module({
  imports: [AuthModule],
  controllers: [ProjectionReplayController],
  providers: [ProjectionReplayService],
  exports: [ProjectionReplayService],
})
export class ProjectionReplayModule {}

import { Module } from "@nestjs/common";
import { DependencyHealthController } from "./dependency-health.controller";
import { DependencyHealthService } from "./dependency-health.service";
import { AuthModule } from "../core/auth/auth.module";
import { HealthModule } from "../health/health.module";
import { PauseControlModule } from "../infrastructure/pause-control/pause-control.module";
import { PublicStatusController } from "../health/public-status.controller";
import { PublicStatusService } from "../health/public-status.service";

/**
 * Dependency health checks for the external services, networks and
 * configuration assumptions Trellis relies on, plus the safe public-status
 * model for degraded, paused, and maintenance states.
 *
 * Issue: #124
 */
@Module({
  imports: [AuthModule, HealthModule, PauseControlModule],
  controllers: [DependencyHealthController, PublicStatusController],
  providers: [DependencyHealthService, PublicStatusService],
  exports: [DependencyHealthService, PublicStatusService],
})
export class DependencyHealthModule {}

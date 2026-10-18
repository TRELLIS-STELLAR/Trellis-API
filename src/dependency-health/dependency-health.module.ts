import { Module } from "@nestjs/common";
import { DependencyHealthController } from "./dependency-health.controller";
import { DependencyHealthService } from "./dependency-health.service";
import { AuthModule } from "../core/auth/auth.module";
import { HealthModule } from "../health/health.module";
import { PauseControlModule } from "../infrastructure/pause-control/pause-control.module";
import { PublicStatusController } from "../health/public-status.controller";
import { PublicStatusService } from "../health/public-status.service";
import { PublicHealthController } from "../health/public-health.controller";
import { PublicHealthService } from "../health/public-health.service";
import { AdminConfigAuditModule } from "../infrastructure/audit/admin-config/admin-config-audit.module";

/**
 * Dependency health checks for the external services, networks and
 * configuration assumptions Trellis relies on, plus the safe public-status
 * model for degraded, paused, and maintenance states.
 *
 * Issue: #124
 */
@Module({
  imports: [
    AuthModule,
    HealthModule,
    PauseControlModule,
    AdminConfigAuditModule,
  ],
  controllers: [
    DependencyHealthController,
    PublicStatusController,
    PublicHealthController,
  ],
  providers: [
    DependencyHealthService,
    PublicStatusService,
    PublicHealthService,
  ],
  exports: [DependencyHealthService, PublicStatusService, PublicHealthService],
})
export class DependencyHealthModule {}

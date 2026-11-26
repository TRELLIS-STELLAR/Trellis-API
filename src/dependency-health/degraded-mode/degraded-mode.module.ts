import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { AuthModule } from "../../core/auth/auth.module";
import { DependencyHealthModule } from "../dependency-health.module";
import { DegradedModeController } from "./degraded-mode.controller";
import { DependencyDegradedModeService } from "./degraded-mode.service";
import { DegradedModeGuard } from "./degraded-mode.guard";
import { FallbackHandlerService } from "./fallback-handler.service";
import { RecoveryDetectorService } from "./recovery-detector.service";
import { UserStatusController } from "./user-status.controller";

/**
 * Degraded-mode behaviour derived from dependency health (issue #355).
 *
 * Depends on `DependencyHealthModule` for the report. Other modules can inject
 * `DependencyDegradedModeService` and call `assertCapabilityEnabled()` to guard
 * a capability without duplicating the policy, or mark a route with
 * `@RequiresCapability()` and let the global `DegradedModeGuard` enforce it.
 * 
 * New additions for dependency outage fallback and recovery UX:
 * - FallbackHandlerService: Implements graceful degradation strategies
 * - RecoveryDetectorService: Monitors recovery and triggers actions
 * - UserStatusController: Public-facing status endpoint
 */
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    DependencyHealthModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [DegradedModeController, UserStatusController],
  providers: [
    DependencyDegradedModeService,
    FallbackHandlerService,
    RecoveryDetectorService,
    { provide: APP_GUARD, useClass: DegradedModeGuard },
  ],
  exports: [
    DependencyDegradedModeService,
    FallbackHandlerService,
    RecoveryDetectorService,
  ],
})
export class DegradedModeModule {}

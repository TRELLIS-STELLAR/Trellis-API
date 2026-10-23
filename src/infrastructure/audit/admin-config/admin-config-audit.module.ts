import { Module } from "@nestjs/common";
import { SensitiveActionAuditModule } from "../sensitive-actions/sensitive-action-audit.module";
import { AdminConfigAuditService } from "./admin-config-audit.service";

/**
 * Fail-closed audit evidence for administrative configuration changes (#280).
 * Import this into any module whose admin routes change configuration.
 */
@Module({
  imports: [SensitiveActionAuditModule],
  providers: [AdminConfigAuditService],
  exports: [AdminConfigAuditService],
})
export class AdminConfigAuditModule {}

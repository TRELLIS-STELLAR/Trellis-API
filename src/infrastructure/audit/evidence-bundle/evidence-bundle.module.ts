import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLog } from "../entities/audit-log.entity";
import { SensitiveActionEvent } from "../entities/sensitive-action-event.entity";
import { SensitiveActionChainHead } from "../entities/sensitive-action-chain-head.entity";
import { ExportSigningService } from "../algorithms/export-signing.service";
import { SensitiveActionAuditModule } from "../sensitive-actions/sensitive-action-audit.module";
import { PrivacyPreserverService } from "./privacy-preserver.service";
import { EvidenceCollectors } from "./collectors/evidence-collectors";
import { EvidenceBundleService } from "./evidence-bundle.service";
import { EvidenceBundleController } from "./evidence-bundle.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AuditLog,
      SensitiveActionEvent,
      SensitiveActionChainHead,
    ]),
    SensitiveActionAuditModule,
  ],
  controllers: [EvidenceBundleController],
  providers: [
    PrivacyPreserverService,
    EvidenceCollectors,
    EvidenceBundleService,
    ExportSigningService,
  ],
  exports: [
    EvidenceBundleService,
    PrivacyPreserverService,
    EvidenceCollectors,
  ],
})
export class EvidenceBundleModule {}

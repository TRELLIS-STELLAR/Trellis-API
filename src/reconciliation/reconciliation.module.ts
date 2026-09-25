import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ReconciliationController } from "./reconciliation.controller";
import { ReconciliationService } from "./reconciliation.service";
import { HorizonPollingService } from "./horizon-polling.service";
import { ReconciliationAudit } from "./entities/reconciliation-audit.entity";
import { ReconciliationInvoice } from "./entities/reconciliation-invoice.entity";
import { StellarTransaction } from "./entities/stellar-transaction.entity";
import { FeatureFlagsService } from "../config/feature-flags.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReconciliationAudit,
      ReconciliationInvoice,
      StellarTransaction,
    ]),
  ],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, HorizonPollingService, FeatureFlagsService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}

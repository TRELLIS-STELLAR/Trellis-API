import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { OracleController } from "./oracle.controller";
import { OracleService } from "./services/oracle.service";
import { PayloadSigningService } from "./services/payload-signing.service";
import { NonceManagementService } from "./services/nonce-management.service";
import { SubmitterService } from "./services/submitter.service";
import { SubmissionBatchService } from "./services/submission-batch.service";
import { SubmissionVerifierService } from "./submission-verifier.service";
import { PriceFeedService } from "./services/price-feed.service";
import { PriceFeedController } from "./price-feed.controller";
import { SignedPayload } from "./entities/signed-payload.entity";
import { SubmissionNonce } from "./entities/submission-nonce.entity";
import { PriceRecord } from "./entities/price-record.entity";
import { AuditModule } from "src/infrastructure/audit/audit.module";
import { SubmissionHistory } from "./entities/submission-history.entity";
import { SubmissionHistoryService } from "./services/submission-history.service";
import { SubmissionHistoryController } from "./submission-history.controller";
import { StellarOracleAdapter } from "./services/stellar-oracle.adapter";

/**
 * Oracle Module
 * Provides services for signing and submitting verified payloads on-chain
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SignedPayload,
      SubmissionNonce,
      PriceRecord,
      SubmissionHistory,
    ]),
    ConfigModule,
    AuditModule,
  ],
  controllers: [
    OracleController,
    PriceFeedController,
    SubmissionHistoryController,
  ],
  providers: [
    StellarOracleAdapter,
    SubmissionHistoryService,
    OracleService,
    PayloadSigningService,
    NonceManagementService,
    SubmitterService,
    SubmissionBatchService,
    SubmissionVerifierService,
    PriceFeedService,
  ],
  exports: [
    SubmissionHistoryService,
    OracleService,
    PayloadSigningService,
    NonceManagementService,
    SubmitterService,
    SubmissionBatchService,
    SubmissionVerifierService,
    PriceFeedService,
  ],
})
export class OracleModule {}

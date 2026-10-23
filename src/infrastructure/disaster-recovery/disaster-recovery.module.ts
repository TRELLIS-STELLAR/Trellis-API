import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DisasterRecoveryValidatorService } from "./disaster-recovery-validator.service";
import { IncidentDrillService } from "./incident-drill.service";
import { RollbackVerificationService } from "./rollback-verifier.service";

@Module({
  imports: [TypeOrmModule],
  providers: [
    DisasterRecoveryValidatorService,
    IncidentDrillService,
    RollbackVerificationService,
  ],
  exports: [
    DisasterRecoveryValidatorService,
    IncidentDrillService,
    RollbackVerificationService,
  ],
})
export class DisasterRecoveryModule {}

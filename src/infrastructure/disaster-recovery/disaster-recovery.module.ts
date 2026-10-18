import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DisasterRecoveryValidatorService } from './disaster-recovery-validator.service';
import { IncidentDrillService } from './incident-drill.service';

@Module({
  imports: [TypeOrmModule],
  providers: [DisasterRecoveryValidatorService, IncidentDrillService],
  exports: [DisasterRecoveryValidatorService, IncidentDrillService],
})
export class DisasterRecoveryModule {}
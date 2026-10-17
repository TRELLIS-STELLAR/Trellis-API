import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PolicySimulationService } from "./policy-simulation.service";
import { PolicyController } from "./policy.controller";
import { PolicyService } from "./policy.service";

@Module({
  imports: [ConfigModule],
  controllers: [PolicyController],
  providers: [PolicyService, PolicySimulationService],
  exports: [PolicyService, PolicySimulationService],
})
export class PolicyModule {}


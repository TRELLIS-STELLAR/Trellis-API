import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { RiskManagementService } from "./risk-management.service";
import { RiskManagementController } from "./risk-management.controller";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { RiskManagementHealthIndicator } from "./risk-management.health";
import { ExplainableRiskScoringService } from "./explainable-risk-scoring.service";

@Module({
  imports: [EventEmitterModule.forRoot()],
  controllers: [RiskManagementController],
  providers: [
    RiskManagementService,
    CircuitBreakerService,
    RiskManagementHealthIndicator,
    // Issue #568: explainable risk scoring for high-impact actions
    ExplainableRiskScoringService,
  ],
  exports: [
    RiskManagementService,
    CircuitBreakerService,
    RiskManagementHealthIndicator,
    ExplainableRiskScoringService,
  ],
})
export class RiskManagementModule {}

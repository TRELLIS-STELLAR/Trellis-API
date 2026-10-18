import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Portfolio } from "src/investment/portfolio/entities/portfolio.entity";
import { PortfolioOwnerGuard } from "src/investment/portfolio/guards/portfolio-owner.guard";
import { RebalancingService } from "./services/rebalancing.service";
import { TargetAllocationsController } from "./controllers/target-allocations.controller";

@Module({
  imports: [TypeOrmModule.forFeature([Portfolio])],
  controllers: [TargetAllocationsController],
  providers: [RebalancingService, PortfolioOwnerGuard],
})
export class PortfolioModule {}

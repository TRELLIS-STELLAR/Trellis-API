import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { PortfolioOwnerGuard } from "src/investment/portfolio/guards/portfolio-owner.guard";
import { RebalancingService } from "src/portfolio/services/rebalancing.service";

@Controller("portfolio/:portfolioId/allocations")
@UseGuards(PortfolioOwnerGuard)
export class TargetAllocationsController {
  constructor(private readonly rebalancingService: RebalancingService) {}

  @Post()
  set(
    @Param("portfolioId", ParseUUIDPipe) portfolioId: string,
    @Body() allocations: Record<string, number>,
  ) {
    return this.rebalancingService.setTargetAllocations(
      portfolioId,
      allocations,
    );
  }

  @Get()
  get(@Param("portfolioId", ParseUUIDPipe) portfolioId: string) {
    return this.rebalancingService.getTargetAllocations(portfolioId);
  }

  @Get("history")
  history(@Param("portfolioId", ParseUUIDPipe) portfolioId: string) {
    return this.rebalancingService.getTargetAllocationHistory(portfolioId);
  }
}

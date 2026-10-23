import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { PortfolioOwnerGuard } from "src/investment/portfolio/guards/portfolio-owner.guard";
import { RebalancingService } from "src/portfolio/services/rebalancing.service";

@Controller("portfolio/:portfolioId/allocations")
@UseGuards(PortfolioOwnerGuard)
export class TargetAllocationsController {
  constructor(private readonly rebalancingService: RebalancingService) {}

  /** `baseVersion` opts into deterministic merging of concurrent edits. */
  @Post()
  set(
    @Param("portfolioId", ParseUUIDPipe) portfolioId: string,
    @Body() allocations: Record<string, number>,
    @Query("baseVersion", new ParseIntPipe({ optional: true }))
    baseVersion?: number,
  ) {
    return this.rebalancingService.setTargetAllocations(
      portfolioId,
      allocations,
      baseVersion,
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

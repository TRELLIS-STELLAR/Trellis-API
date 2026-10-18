import { Controller, Get, Post, Query, Res, HttpStatus } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags, ApiQuery } from "@nestjs/swagger";
import { Response } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { SkipKyc } from "../../common/decorators/skip-kyc.decorator";
import { SyntheticJourneyMonitorService } from "./synthetic-journey.service";
import { SyntheticJourneyReport } from "./synthetic-journey.types";

/**
 * Controller exposing Synthetic Journey Monitoring endpoints.
 *
 * GET  /monitoring/synthetic/status   — Fetches the latest synthetic journey report
 * POST /monitoring/synthetic/run      — Triggers an on-demand synthetic run immediately
 */
@ApiTags("Monitoring")
@Controller("monitoring/synthetic")
@Public()
@SkipKyc()
export class SyntheticJourneyController {
  private readonly syntheticMonitorService: SyntheticJourneyMonitorService;

  constructor(syntheticMonitorService: SyntheticJourneyMonitorService) {
    this.syntheticMonitorService = syntheticMonitorService;
  }

  @Get("status")
  @ApiOperation({
    summary: "Get latest synthetic journey report",
    description:
      "Returns the most recent end-to-end synthetic happy path journey report including latency, status, and dependency blame attribution.",
  })
  @ApiResponse({ status: 200, description: "Synthetic journey report" })
  async getStatus(): Promise<SyntheticJourneyReport> {
    return this.syntheticMonitorService.getLatestReport();
  }

  @Post("run")
  @ApiOperation({
    summary: "Trigger synthetic journey run on-demand",
    description:
      "Runs the full synthetic end-to-end happy path flow and returns latency metrics and dependency blame diagnostics.",
  })
  @ApiQuery({ name: "simulateFailureStep", required: false, type: String })
  @ApiResponse({ status: 200, description: "Executed synthetic journey report" })
  async runJourney(
    @Res({ passthrough: true }) res: Response,
    @Query("simulateFailureStep") simulateFailureStep?: string,
  ): Promise<SyntheticJourneyReport> {
    const report = await this.syntheticMonitorService.runJourney({
      trigger: "MANUAL",
      simulateFailureStep,
    });

    if (report.status === "FAILED") {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    } else if (report.status === "DEGRADED") {
      res.status(HttpStatus.OK);
    }

    return report;
  }
}

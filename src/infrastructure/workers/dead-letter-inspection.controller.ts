import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { DeadLetterInspectionService, DeadLetterFilter, BatchRetryResult } from "./dead-letter-inspection.service";
import { JwtAuthGuard } from "src/core/auth/guards/jwt-auth.guard";
import { RolesGuard } from "src/core/auth/guards/roles.guard";
import { Roles } from "src/core/auth/decorators/roles.decorator";
import { CurrentUser } from "src/core/auth/decorators/current-user.decorator";

interface User {
  sub: string;
  email?: string;
  role?: string;
}

@ApiTags("dead-letter-queue")
@Controller("api/v1/dead-letter")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class DeadLetterInspectionController {
  private readonly logger = new Logger(DeadLetterInspectionController.name);

  constructor(private readonly inspectionService: DeadLetterInspectionService) {}

  @Get("stats")
  @ApiOperation({ summary: "Get dead-letter queue statistics" })
  @ApiResponse({ status: 200, description: "Statistics retrieved successfully" })
  async getStats() {
    return this.inspectionService.getDeadLetterStats();
  }

  @Get("jobs")
  @ApiOperation({ summary: "List dead-lettered jobs with optional filters" })
  @ApiQuery({ name: "type", required: false, description: "Filter by job type" })
  @ApiQuery({ name: "errorPattern", required: false, description: "Regex pattern to match errors" })
  @ApiQuery({ name: "minAge", required: false, description: "Minimum age in hours" })
  @ApiQuery({ name: "maxAge", required: false, description: "Maximum age in hours" })
  @ApiQuery({ name: "limit", required: false, description: "Maximum number of results" })
  @ApiResponse({ status: 200, description: "Jobs listed successfully" })
  async listJobs(
    @Query("type") type?: string,
    @Query("errorPattern") errorPattern?: string,
    @Query("minAge") minAge?: string,
    @Query("maxAge") maxAge?: string,
    @Query("limit") limit?: string
  ) {
    const filter: DeadLetterFilter = {
      type,
      errorPattern,
      minAge: minAge ? parseInt(minAge, 10) : undefined,
      maxAge: maxAge ? parseInt(maxAge, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    };

    return this.inspectionService.listDeadLetterJobs(filter);
  }

  @Get("jobs/:id")
  @ApiOperation({ summary: "Get detailed information about a dead-lettered job" })
  @ApiResponse({ status: 200, description: "Job details retrieved successfully" })
  @ApiResponse({ status: 404, description: "Job not found or not in dead-letter queue" })
  async getJobDetails(@Param("id") id: string) {
    const job = await this.inspectionService.getDeadLetterJobDetails(id);
    
    if (!job) {
      throw new HttpException("Job not found or not in dead-letter queue", HttpStatus.NOT_FOUND);
    }

    return job;
  }

  @Post("jobs/:id/retry")
  @Roles("operator", "admin")
  @ApiOperation({
    summary: "Safely retry a single dead-lettered job",
    description: "Requires operator or admin role",
  })
  @ApiResponse({ status: 200, description: "Job retried successfully" })
  @ApiResponse({ status: 404, description: "Job not found or not retryable" })
  @ApiResponse({ status: 403, description: "Insufficient permissions" })
  async retryJob(@Param("id") id: string, @CurrentUser() user: User) {
    const requestedBy = user.email || user.sub;
    
    const retriedJob = await this.inspectionService.safeRetryJob(id, requestedBy);
    
    if (!retriedJob) {
      throw new HttpException(
        "Job not found or not in a retryable state",
        HttpStatus.NOT_FOUND
      );
    }

    this.logger.log(`Job ${id} retried by ${requestedBy}`);
    
    return {
      success: true,
      job: retriedJob,
      message: `Job ${id} has been queued for retry`,
    };
  }

  @Post("batch-retry")
  @Roles("operator", "admin")
  @ApiOperation({
    summary: "Batch retry multiple dead-lettered jobs",
    description: "Requires operator or admin role. Supports dry-run mode.",
  })
  @ApiResponse({ status: 200, description: "Batch retry completed" })
  @ApiResponse({ status: 403, description: "Insufficient permissions" })
  async batchRetry(
    @Body()
    body: {
      filter?: DeadLetterFilter;
      dryRun?: boolean;
    },
    @CurrentUser() user: User
  ): Promise<BatchRetryResult> {
    const requestedBy = user.email || user.sub;
    const { filter = {}, dryRun = false } = body;

    this.logger.log(
      `Batch retry ${dryRun ? "(dry run) " : ""}requested by ${requestedBy} with filter: ${JSON.stringify(filter)}`
    );

    return this.inspectionService.batchRetryJobs(filter, requestedBy, dryRun);
  }

  @Post("purge")
  @Roles("admin")
  @ApiOperation({
    summary: "Purge old dead-lettered jobs",
    description: "Requires admin role. Destructive operation - use with caution!",
  })
  @ApiResponse({ status: 200, description: "Purge completed" })
  @ApiResponse({ status: 403, description: "Insufficient permissions" })
  async purgeOldJobs(
    @Body()
    body: {
      olderThanHours: number;
      dryRun?: boolean;
    },
    @CurrentUser() user: User
  ) {
    const requestedBy = user.email || user.sub;
    const { olderThanHours, dryRun = false } = body;

    if (olderThanHours < 24) {
      throw new HttpException(
        "Cannot purge jobs less than 24 hours old",
        HttpStatus.BAD_REQUEST
      );
    }

    this.logger.warn(
      `Purge ${dryRun ? "(dry run) " : ""}requested by ${requestedBy} for jobs older than ${olderThanHours} hours`
    );

    return this.inspectionService.purgeOldDeadLetterJobs(olderThanHours, requestedBy, dryRun);
  }
}

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Logger,
  NotFoundException,
  HttpCode,
  Req,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from "@nestjs/swagger";
import { RetrySchedulerService } from "./retry-scheduler.service";
import {
  ScheduleRetryDto,
  RetryDeadLetterDto,
  RetryDeadLettersDto,
} from "./dto/schedule-retry.dto";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { Roles, Role } from "src/common/decorators/roles.decorator";
import { RolesGuard } from "src/common/guard/roles.guard";

@ApiTags("Retry Scheduler")
@ApiBearerAuth()
@Controller("retry-scheduler")
@UseGuards(JwtAuthGuard, RolesGuard)
export class RetrySchedulerController {
  private readonly logger = new Logger(RetrySchedulerController.name);

  constructor(private readonly retryService: RetrySchedulerService) {}

  @Get("dead-letters")
  @Roles(Role.MAINTAINER)
  @ApiOperation({ summary: "List dead-lettered operations" })
  @ApiResponse({ status: 200, description: "Dead letters retrieved" })
  @ApiQuery({ name: "limit", type: Number, required: false })
  @ApiQuery({ name: "offset", type: Number, required: false })
  async getDeadLetters(
    @Query("limit") limit?: number,
    @Query("offset") offset?: number,
  ) {
    const { items, total } = await this.retryService.getDeadLetters(
      limit || 50,
      offset || 0,
    );
    return { success: true, deadLetters: items, total };
  }

  @Get("failures")
  @Roles(Role.MAINTAINER)
  @ApiOperation({
    summary: "Filter unresolved partial failures for operations triage",
  })
  @ApiResponse({
    status: 200,
    description: "Unresolved failure summaries retrieved",
  })
  @ApiQuery({ name: "operationType", required: false, type: String })
  @ApiQuery({ name: "search", required: false, type: String })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiQuery({ name: "offset", required: false, type: Number })
  async getFailureDashboard(
    @Query("operationType") operationType?: string,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    const parsedOffset = offset === undefined ? undefined : Number(offset);
    const result = await this.retryService.getFailureDashboard({
      operationType,
      search,
      limit:
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined,
      offset:
        parsedOffset !== undefined && Number.isFinite(parsedOffset)
          ? parsedOffset
          : undefined,
    });
    return { success: true, ...result };
  }

  @Get("operations/:operationId")
  @Roles(Role.MAINTAINER)
  @ApiOperation({ summary: "Get operation retry status" })
  @ApiResponse({ status: 200, description: "Operation status retrieved" })
  @ApiParam({ name: "operationId", description: "Operation ID" })
  async getOperationStatus(@Param("operationId") operationId: string) {
    const operation = await this.retryService.getOperationStatus(operationId);
    if (!operation) {
      throw new NotFoundException(`Operation ${operationId} not found`);
    }
    return { success: true, operation };
  }

  @Post("dead-letters/:operationId/retry")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Manually retry a dead-lettered operation" })
  @ApiResponse({ status: 200, description: "Operation re-queued for retry" })
  @ApiParam({ name: "operationId", description: "Operation ID" })
  @ApiResponse({
    status: 409,
    description: "Failure was non-retryable; resend with force",
  })
  async retryDeadLetter(
    @Param("operationId") operationId: string,
    @Body() dto: RetryDeadLetterDto,
    @Req() req: { user?: { id?: string } },
  ) {
    const operation = await this.retryService.retryDeadLetter(
      operationId,
      dto.maxAttempts,
      { actor: req.user?.id, reason: dto.reason, force: dto.force },
    );
    if (!operation) {
      throw new NotFoundException(
        `Dead-lettered operation ${operationId} not found`,
      );
    }
    this.logger.log(`Dead-lettered operation ${operationId} retried via API`);
    return { success: true, operation };
  }

  @Post("dead-letters/retry")
  @HttpCode(200)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      "Re-queue the oldest retryable dead letters with a per-item report",
  })
  @ApiResponse({ status: 200, description: "Per-operation retry outcomes" })
  async retryDeadLetters(
    @Body() dto: RetryDeadLettersDto,
    @Req() req: { user?: { id?: string } },
  ) {
    const result = await this.retryService.retryDeadLetters(
      { operationType: dto.operationType, limit: dto.limit },
      { actor: req.user?.id, reason: dto.reason },
    );
    this.logger.log(
      `Bulk dead-letter retry re-queued ${result.requeued}/${result.requested} operations`,
    );
    return { success: true, ...result };
  }

  @Get("metrics")
  @Roles(Role.MAINTAINER)
  @ApiOperation({ summary: "Get retry scheduler metrics" })
  @ApiResponse({ status: 200, description: "Metrics retrieved" })
  async getMetrics() {
    const metrics = await this.retryService.getMetrics();
    return { success: true, metrics };
  }

  @Post("operations")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Schedule an operation for retry management" })
  @ApiResponse({ status: 201, description: "Operation scheduled" })
  async scheduleOperation(@Body() dto: ScheduleRetryDto) {
    const operation = await this.retryService.schedule(dto);
    this.logger.log(`Operation ${dto.operationId} scheduled via API`);
    return { success: true, operation };
  }
}

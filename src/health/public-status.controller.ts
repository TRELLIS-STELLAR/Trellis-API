import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Response } from "express";
import { Public } from "../common/decorators/public.decorator";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "../core/auth/guards/admin-two-factor.guard";
import { RolesGuard } from "../common/guard/roles.guard";
import { Roles } from "../common/guard/roles.decorator";
import { Role } from "../common/guard/roles.enum";
import { Idempotent } from "../common/idempotency/idempotency.decorator";
import {
  AdminActionContext,
  PublicStatusService,
} from "./public-status.service";
import {
  ClearComponentDegradationDto,
  ClearMaintenanceWindowDto,
  DeclareComponentDegradationDto,
  PublicSystemStatusDto,
  SetMaintenanceWindowDto,
} from "./dto/public-status.dto";
import {
  OperatorSystemStatusView,
  UiStatusBannerContract,
} from "./public-status.model";

/** Actor context recorded with operator changes as audit evidence (#280). */
function actionContext(req: any): AdminActionContext {
  const userAgent = req?.headers?.["user-agent"];
  return {
    actorRole: req?.user?.role ?? undefined,
    ipAddress: req?.ip ?? undefined,
    userAgent: typeof userAgent === "string" ? userAgent : undefined,
  };
}

@ApiTags("Status")
@Controller()
export class PublicStatusController {
  constructor(private readonly publicStatusService: PublicStatusService) {}

  @Get(["status", "health/status"])
  @Public()
  @RateLimit({ level: "public-status", limit: 30, windowMs: 60_000 })
  @ApiOperation({
    summary: "Safe public system status (operational, degraded, paused, maintenance)",
    description:
      "Returns the current system state, safe component breakdown, active paused scopes, " +
      "maintenance window details, and client capability flags without exposing secrets, " +
      "internal targets, or configuration keys.",
    operationId: "getPublicSystemStatus",
  })
  @ApiResponse({
    status: 200,
    description: "System is operational, degraded, or partially paused",
    type: PublicSystemStatusDto,
  })
  @ApiResponse({
    status: 503,
    description: "System is in full maintenance mode or global pause",
    type: PublicSystemStatusDto,
  })
  async getPublicStatus(
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicSystemStatusDto> {
    const status = await this.publicStatusService.getPublicStatus();

    if (res?.setHeader) {
      res.setHeader("X-Trellis-System-Status", status.state);
      if (status.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(status.retryAfterSeconds));
      }
    }

    if (status.httpStatusCode === 503 && res?.status) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return status;
  }

  @Get(["status/ui-banner", "health/status/ui-banner"])
  @Public()
  @RateLimit({ level: "public-status-ui", limit: 30, windowMs: 60_000 })
  @ApiOperation({
    summary: "UI status banner and capability contract",
    description:
      "Returns the XSS-sanitized UI banner descriptor, capability flags, and WebSocket " +
      "event envelope for frontend applications.",
    operationId: "getPublicUiStatusBanner",
  })
  @ApiResponse({ status: 200, description: "UI status banner contract" })
  async getUiBanner(): Promise<UiStatusBannerContract> {
    return this.publicStatusService.getUiBannerContract();
  }

  @Get(["status/operator", "health/status/operator"])
  @UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Operator system status and recovery diagnostics",
    description:
      "Returns the full operator status view including sanitized dependency diagnostics, " +
      "active pause metadata, background worker deferral state, transition history, " +
      "and rollback/recovery runbook steps. Secret values are always redacted.",
    operationId: "getOperatorSystemStatus",
  })
  @ApiQuery({
    name: "refresh",
    required: false,
    type: Boolean,
    description: "Bypass dependency health cache",
  })
  @ApiResponse({ status: 200, description: "Operator status view" })
  async getOperatorStatus(
    @Query("refresh") refresh?: string,
  ): Promise<OperatorSystemStatusView> {
    const refreshDependencies = refresh === "true" || refresh === "1";
    return this.publicStatusService.getOperatorStatus({ refreshDependencies });
  }

  @Post("status/maintenance")
  @HttpCode(HttpStatus.OK)
  // A retried request (same Idempotency-Key) replays the stored response
  // instead of applying the change and recording evidence twice.
  @Idempotent()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Activate a scheduled or emergency maintenance window",
    operationId: "activateMaintenanceWindow",
  })
  @ApiResponse({ status: 200, description: "Maintenance window activated" })
  async activateMaintenance(
    @Body() dto: SetMaintenanceWindowDto,
    @Req() req: any,
  ): Promise<OperatorSystemStatusView> {
    const actorId = req?.user?.id ?? "admin";
    const actorRole = req?.user?.role ?? "ADMIN";
    return this.publicStatusService.activateMaintenance(
      dto,
      actorId,
      actorRole,
      new Date(),
      actionContext(req),
    );
  }

  @Post("status/maintenance/clear")
  @HttpCode(HttpStatus.OK)
  // A retried request (same Idempotency-Key) replays the stored response
  // instead of applying the change and recording evidence twice.
  @Idempotent()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Clear active maintenance window and resume normal status evaluation",
    operationId: "clearMaintenanceWindow",
  })
  @ApiResponse({ status: 200, description: "Maintenance window cleared" })
  async clearMaintenance(
    @Body() dto: ClearMaintenanceWindowDto,
    @Req() req: any,
  ): Promise<OperatorSystemStatusView> {
    const actorId = req?.user?.id ?? "admin";
    const actorRole = req?.user?.role ?? "ADMIN";
    return this.publicStatusService.clearMaintenance(
      dto.reason,
      actorId,
      actorRole,
      new Date(),
      actionContext(req),
    );
  }

  @Post("status/degradation")
  @HttpCode(HttpStatus.OK)
  // A retried request (same Idempotency-Key) replays the stored response
  // instead of applying the change and recording evidence twice.
  @Idempotent()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Declare partial component degradation",
    operationId: "declareComponentDegradation",
  })
  @ApiResponse({ status: 200, description: "Component degradation declared" })
  async declareDegradation(
    @Body() dto: DeclareComponentDegradationDto,
    @Req() req: any,
  ): Promise<OperatorSystemStatusView> {
    const actorId = req?.user?.id ?? "admin";
    return this.publicStatusService.declareComponentDegradation(
      dto,
      actorId,
      new Date(),
      actionContext(req),
    );
  }

  @Post("status/degradation/clear")
  @HttpCode(HttpStatus.OK)
  // A retried request (same Idempotency-Key) replays the stored response
  // instead of applying the change and recording evidence twice.
  @Idempotent()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Clear declared component degradation",
    operationId: "clearComponentDegradation",
  })
  @ApiResponse({ status: 200, description: "Component degradation cleared" })
  async clearDegradation(
    @Body() dto: ClearComponentDegradationDto,
    @Req() req: any,
  ): Promise<OperatorSystemStatusView> {
    const actorId = req?.user?.id ?? "admin";
    return this.publicStatusService.clearComponentDegradation(
      dto.componentId,
      dto.reason ?? "Component recovered",
      actorId,
      new Date(),
      actionContext(req),
    );
  }
}

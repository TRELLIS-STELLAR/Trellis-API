import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guard/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { Role } from "../../common/guard/roles.enum";
import { AdminTwoFactorGuard } from "./guards/admin-two-factor.guard";
import { ImpersonationService } from "./impersonation.service";
import { AllowImpersonation } from "./decorators/allow-impersonation.decorator";
import {
  StartImpersonationDto,
  StopImpersonationDto,
  ImpersonationSessionResponseDto,
  SupportNoticeResponseDto,
} from "./dto/impersonation.dto";

export { StartImpersonationDto, StopImpersonationDto };

@ApiTags("Authentication")
@Controller("auth/impersonate")
export class ImpersonationController {
  constructor(private readonly impersonationService: ImpersonationService) {}

  @Post("start")
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Start a time-bounded, scoped maintainer impersonation / support access session (Admin only)",
    description:
      "Initiates a support session with immutable hash-chained audit logging, automatic expiration, and user-safe notifications.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Support session started successfully",
    type: ImpersonationSessionResponseDto,
  })
  async startImpersonation(
    @Request() req,
    @Body() dto: StartImpersonationDto,
  ) {
    const adminId = req.user.sub || req.user.id;
    return this.impersonationService.startImpersonation(
      adminId,
      dto.targetUserId,
      req.ip,
      req.headers["user-agent"],
      {
        reason: dto.reason,
        ticketId: dto.ticketId,
        durationMinutes: dto.durationMinutes,
        scopes: dto.scopes,
      },
    );
  }

  @Post("stop")
  @HttpCode(HttpStatus.OK)
  @AllowImpersonation()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Stop an impersonation session",
    description:
      "Revokes the session token, commits the termination event to the immutable audit trail, and clears active session notices.",
  })
  async stopImpersonation(
    @Request() req,
    @Body() dto: StopImpersonationDto,
  ) {
    const adminId = req.user.impersonatorId || req.user.sub || req.user.id;
    return this.impersonationService.stopImpersonation(
      adminId,
      dto.targetUserId,
      req.ip,
      req.headers["user-agent"],
      {
        reason: dto.reason,
        jti: req.user.jti,
      },
    );
  }

  @Get("active-notice")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get user-safe support session notices for the authenticated user",
    description:
      "Returns privacy-filtered notice information indicating whether a support session is active on the account, including granted scopes and expiration time without exposing maintainer PII.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Active support notice information",
    type: SupportNoticeResponseDto,
  })
  async getActiveNotice(@Request() req): Promise<SupportNoticeResponseDto> {
    const userId = req.user.sub || req.user.id;
    return this.impersonationService.getActiveNotice(userId);
  }
}

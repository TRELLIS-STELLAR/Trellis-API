import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiProperty } from "@nestjs/swagger";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guard/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { Role } from "../../common/guard/roles.enum";
import { AdminTwoFactorGuard } from "./guards/admin-two-factor.guard";
import { ImpersonationService } from "./impersonation.service";
import { AllowImpersonation } from "./decorators/allow-impersonation.decorator";

export class StartImpersonationDto {
  @ApiProperty({ description: "User ID to impersonate" })
  targetUserId: string;
}

export class StopImpersonationDto {
  @ApiProperty({ description: "Impersonated User ID" })
  targetUserId: string;
}

@ApiTags("Authentication")
@Controller("auth/impersonate")
export class ImpersonationController {
  constructor(private readonly impersonationService: ImpersonationService) {}

  @Post("start")
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Start an impersonation session (Admin only)" })
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
    );
  }

  @Post("stop")
  @HttpCode(HttpStatus.OK)
  @AllowImpersonation()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Stop an impersonation session" })
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
    );
  }
}

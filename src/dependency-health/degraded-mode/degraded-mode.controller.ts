import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request } from "express";
import { JwtAuthGuard } from "../../core/auth/jwt.guard";
import { RolesGuard } from "../../common/guard/roles.guard";
import { Roles } from "../../common/guard/roles.decorator";
import { Role } from "../../common/guard/roles.enum";
import { DependencyDegradedModeService } from "./degraded-mode.service";
import { DegradedModeAuthorizationError } from "./degraded-mode.errors";
import { ManualDegradedModeDto } from "./dto/degraded-mode.dto";
import { DegradedCapability } from "./degraded-mode.types";

/**
 * Degraded-mode surface (issue #355).
 *
 * Read endpoints are available to operators (MAINTAINER/ADMIN); changing the
 * manual override is ADMIN-only. The decision is derived from the dependency
 * health report, so this controller is intentionally read-mostly.
 */
@ApiTags("Dependency health")
@ApiBearerAuth()
@Controller("api/v1/dependency-mode")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DegradedModeController {
  constructor(private readonly service: DependencyDegradedModeService) {}

  @Get()
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @ApiOperation({ summary: "Current operating mode derived from dependency health" })
  @ApiResponse({ status: 200, description: "Degraded-mode decision" })
  async current() {
    const decision = await this.service.getMode();
    return {
      decision,
      capabilities: this.service.listCapabilities(decision),
    };
  }

  @Get("capabilities")
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @ApiOperation({ summary: "Per-capability availability under the current mode" })
  async capabilities() {
    const decision = await this.service.getMode();
    return { level: decision.level, capabilities: this.service.listCapabilities(decision) };
  }

  @Post("manual")
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Activate a manual degraded-mode window (ADMIN only)" })
  @ApiResponse({ status: 200, description: "Updated degraded-mode decision" })
  @ApiResponse({ status: 403, description: "Requester is not an ADMIN" })
  async activate(@Body() dto: ManualDegradedModeDto, @Req() req: Request) {
    try {
      const decision = await this.service.activateManualDegradation(
        {
          level: dto.level,
          reason: dto.reason,
          disabledCapabilities: dto.disabledCapabilities as DegradedCapability[] | undefined,
        },
        this.requester(req),
      );
      return { decision, capabilities: this.service.listCapabilities(decision) };
    } catch (error) {
      if (error instanceof DegradedModeAuthorizationError) {
        throw new ForbiddenException(error.message);
      }
      throw error;
    }
  }

  @Delete("manual")
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Clear the manual degraded-mode window (ADMIN only)" })
  @ApiResponse({ status: 200, description: "Updated degraded-mode decision" })
  @ApiResponse({ status: 403, description: "Requester is not an ADMIN" })
  async clear(@Req() req: Request) {
    try {
      const decision = await this.service.clearManualDegradation(this.requester(req));
      return { decision, capabilities: this.service.listCapabilities(decision) };
    } catch (error) {
      if (error instanceof DegradedModeAuthorizationError) {
        throw new ForbiddenException(error.message);
      }
      throw error;
    }
  }

  private requester(req: Request): { id: string; role: string } {
    const user = (req as any).user ?? {};
    const role = user.role ?? (Array.isArray(user.roles) ? user.roles[0] : undefined);
    return { id: String(user.id ?? user.sub ?? "anonymous"), role: String(role ?? "") };
  }
}

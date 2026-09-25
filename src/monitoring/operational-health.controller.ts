import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "../core/auth/guards/admin-two-factor.guard";
import { RolesGuard } from "../common/guard/roles.guard";
import { Roles } from "../common/guard/roles.decorator";
import { Role } from "../common/guard/roles.enum";
import { OperationalHealthService } from "./operational-health.service";

@ApiTags("Monitoring")
@Controller("monitoring")
@UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class OperationalHealthController {
  constructor(private readonly health: OperationalHealthService) {}

  @Get("operational-health")
  @ApiOperation({ summary: "Get an admin-only operational health report" })
  getReport(@Query("staleAfterHours") staleAfterHours?: string) {
    const hours = staleAfterHours ? Number(staleAfterHours) : 24;
    return this.health.getReport(Number.isFinite(hours) && hours > 0 ? hours : 24);
  }
}
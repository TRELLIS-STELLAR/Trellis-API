
import { Controller, Get, Post, Param, Body, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "../core/auth/guards/admin-two-factor.guard";
import { RolesGuard } from "../common/guard/roles.guard";
import { Roles } from "../common/guard/roles.decorator";
import { Role } from "../common/guard/roles.enum";
import { PartialFailureService } from "./partial-failure.service";
import { PartialFailure } from "./entities/partial-failure.entity";

@ApiTags("Monitoring")
@Controller("monitoring/partial-failures")
@UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class PartialFailureController {
  constructor(private readonly service: PartialFailureService) {}

  @Get()
  @ApiOperation({ summary: "Get unresolved partial failures dashboard report" })
  getDashboard() {
    return this.service.getDashboardReport();
  }
  
  @Post(":id/resolve")
  @ApiOperation({ summary: "Mark a partial failure as resolved" })
  resolveFailure(@Param("id") id: string) {
    return this.service.resolveFailure(id);
  }
  
  @Post(":id/ignore")
  @ApiOperation({ summary: "Mark a partial failure as ignored" })
  ignoreFailure(@Param("id") id: string) {
    return this.service.ignoreFailure(id);
  }
}

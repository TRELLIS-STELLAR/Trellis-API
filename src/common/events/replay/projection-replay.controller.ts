import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { JwtAuthGuard } from "../../../core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "../../../core/auth/guards/admin-two-factor.guard";
import { RolesGuard } from "../../guard/roles.guard";
import { Roles } from "../../guard/roles.decorator";
import { Role } from "../../guard/roles.enum";
import { Idempotent } from "../../idempotency/idempotency.decorator";
import { ReplayInProgressError } from "./event-replay";
import { ProjectionReplayService } from "./projection-replay.service";

export class RebuildProjectionDto {
  @ApiPropertyOptional({
    description: "Rebuild and report without publishing.",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description: "Resume from the last checkpoint.",
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  resume?: boolean;

  @ApiPropertyOptional({ enum: ["halt", "skip"], default: "halt" })
  @IsOptional()
  @IsIn(["halt", "skip"])
  onPoisonEvent?: "halt" | "skip";

  @ApiPropertyOptional({
    description: "Checkpoint interval in events.",
    default: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  checkpointEvery?: number;
}

class ProjectionNameParam {
  @ApiProperty({ example: "user-directory" })
  name: string;
}

/**
 * Operator surface for versioned projection rebuilds (#278).
 *
 * Rebuilding reads the whole event history, so every route is ADMIN-only with
 * the admin second factor, like the other operator controls.
 */
@ApiTags("Projections")
@ApiBearerAuth()
@Controller("admin/projections")
@UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
@Roles(Role.ADMIN)
export class ProjectionReplayController {
  constructor(private readonly replay: ProjectionReplayService) {}

  @Get()
  @ApiOperation({
    summary: "List projections with published version and staleness",
    operationId: "listProjections",
  })
  list() {
    return this.replay.list();
  }

  @Post(":name/rebuild")
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: "Rebuild a projection from the event history",
    description:
      "Replays every stored event in order, upcasting old schema versions, into a new state for " +
      "the projection's current version. The live version is only switched when the rebuild " +
      "completes; `outcome: halted` means a poison event stopped it and nothing was published.",
    operationId: "rebuildProjection",
  })
  @ApiResponse({ status: 200, description: "Replay report" })
  @ApiResponse({ status: 404, description: "Unknown projection" })
  @ApiResponse({
    status: 409,
    description: "A rebuild of this projection is already running",
  })
  async rebuild(
    @Param() params: ProjectionNameParam,
    @Body() dto: RebuildProjectionDto,
  ) {
    try {
      return await this.replay.rebuild(params.name, dto ?? {});
    } catch (error) {
      if (error instanceof ReplayInProgressError)
        throw new ConflictException(error.message);
      throw error;
    }
  }

  @Post(":name/rollback")
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: "Restore the previously published projection version",
    operationId: "rollbackProjection",
  })
  @ApiResponse({ status: 200, description: "Restored projection" })
  @ApiResponse({ status: 409, description: "No previous version to restore" })
  async rollback(@Param() params: ProjectionNameParam) {
    const restored = await this.replay.rollback(params.name);
    if (!restored)
      throw new ConflictException(
        `No previous version of '${params.name}' to restore`,
      );
    return {
      projection: restored.projection,
      version: restored.version,
      sequence: restored.sequence,
      stateHash: restored.stateHash,
    };
  }
}

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request, Response } from "express";
import { JwtAuthGuard } from "../../core/auth/jwt.guard";
import { RolesGuard } from "../../common/guard/roles.guard";
import { Roles } from "../../common/guard/roles.decorator";
import { Role } from "../../common/guard/roles.enum";
import { SnapshotExportService } from "./snapshot-export.service";
import { SnapshotExportAuthorizationError, SnapshotExportRetryableError } from "./snapshot-export.errors";
import { SnapshotExportRequester } from "./snapshot-export.types";
import { VerifySnapshotExportDto } from "./dto/snapshot-export.dto";

/**
 * Signed state snapshot export (issue #356).
 *
 * Export turns a stored snapshot into a canonicalised, hashed, HMAC-signed
 * document suitable for audit storage and later independent verification.
 */
@ApiTags("Snapshots")
@ApiBearerAuth()
@Controller("api/v1/snapshots")
export class SnapshotExportController {
  constructor(private readonly exportService: SnapshotExportService) {}

  @Post(":snapshotId/export")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @ApiOperation({
    summary: "Export a snapshot as a signed document for audit/debugging",
  })
  @ApiResponse({ status: 201, description: "Signed export document" })
  @ApiResponse({ status: 404, description: "Snapshot not found" })
  @ApiResponse({ status: 503, description: "Signing key provider temporarily unavailable" })
  async export(
    @Param("snapshotId") snapshotId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const requester = this.requester(req);
    try {
      const document = await this.exportService.exportSnapshot(snapshotId, requester);
      res.status(HttpStatus.CREATED);
      return document;
    } catch (error) {
      if (error instanceof SnapshotExportRetryableError) {
        res.status(HttpStatus.SERVICE_UNAVAILABLE);
        res.set("Retry-After", String(error.retryAfterSeconds));
        return { error: "EXPORT_RETRYABLE", message: error.message, retryAfterSeconds: error.retryAfterSeconds };
      }
      if (error instanceof SnapshotExportAuthorizationError) {
        throw new ForbiddenException(error.message);
      }
      throw error;
    }
  }

  @Get("exports")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.MAINTAINER)
  @ApiOperation({ summary: "List snapshot exports (metadata only)" })
  list(@Req() req: Request) {
    return this.exportService.listExports(this.requester(req));
  }

  @Get("exports/:exportId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiOperation({ summary: "Retrieve a snapshot export by id" })
  get(@Param("exportId") exportId: string, @Req() req: Request) {
    return this.exportService.getExport(exportId, this.requester(req));
  }

  @Post("exports/verify")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiOperation({ summary: "Verify a snapshot export signature and payload hash" })
  verify(@Body() dto: VerifySnapshotExportDto, @Req() req: Request) {
    return this.exportService.verifyExport(dto.exportId, this.requester(req));
  }

  private requester(req: Request): SnapshotExportRequester {
    const user = (req as any).user ?? {};
    const role = user.role ?? (Array.isArray(user.roles) ? user.roles[0] : undefined);
    return { id: String(user.id ?? user.sub ?? "anonymous"), role: String(role ?? "") };
  }
}

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Res,
  ParseUUIDPipe,
} from "@nestjs/common";
import { Response } from "express";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { AuditLogService } from "./audit-log.service";
import {
  QueryAuditLogDto,
  ExportAuditLogDto,
  VerifyDeletionDto,
} from "./dto/query-audit-log.dto";
import {
  AuditLogResponseDto,
  AuditLogListResponseDto,
} from "./dto/audit-log-response.dto";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { ComplianceOfficerGuard } from "./guards/compliance-officer.guard";

@ApiTags("Audit Logs")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ComplianceOfficerGuard)
@Controller("audit-logs")
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @ApiOperation({
    summary: "Search and filter audit logs",
    description:
      "Full-text search with filters by user, action, IP, and date range. Paginated, 100 records per page max.",
  })
  @ApiResponse({ status: 200, type: AuditLogListResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async query(
    @Query() query: QueryAuditLogDto,
  ): Promise<AuditLogListResponseDto> {
    return this.auditLogService.query(query);
  }

  @Get("retention/preview")
  @ApiOperation({
    summary: "Preview eligible and protected records for audit retention purge",
    description: "Read-only preview reporting candidate record counts and IDs before deletion.",
  })
  @ApiResponse({ status: 200, description: "Retention preview report" })
  @ApiResponse({ status: 403, description: "Forbidden - Compliance Officer required" })
  async previewRetention() {
    return this.auditLogService.previewRetention();
  }

  @Post("retention/enforce")
  @ApiOperation({
    summary: "Manually trigger retention enforcement for expired audit records",
    description:
      "Permanently purges unprotected audit logs older than retention cutoff (7 years). Protected records with active holds/disputes are preserved.",
  })
  @ApiResponse({ status: 200, description: "Retention enforcement report" })
  @ApiResponse({ status: 403, description: "Forbidden - Compliance Officer required" })
  async enforceRetention() {
    return this.auditLogService.enforceRetention();
  }

  @Post("retention/verify")
  @ApiOperation({
    summary: "Verify deletion of purged audit records",
    description:
      "Verifies that specified audit log IDs no longer exist in the repository.",
  })
  @ApiResponse({ status: 200, description: "Deletion verification result" })
  @ApiResponse({ status: 403, description: "Forbidden - Compliance Officer required" })
  async verifyDeletion(@Body() dto?: VerifyDeletionDto) {
    return this.auditLogService.verifyDeletion(dto?.ids ?? []);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get audit log by ID" })
  @ApiParam({ name: "id", type: "string" })
  @ApiResponse({ status: 200, type: AuditLogResponseDto })
  @ApiResponse({ status: 404, description: "Audit log not found" })
  async getById(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<AuditLogResponseDto> {
    return this.auditLogService.findById(id);
  }

  @Get("export")
  @ApiOperation({
    summary: "Bulk export audit logs",
    description:
      "Exports up to 100,000 records for a date range as signed JSON or CSV.",
  })
  @ApiResponse({ status: 200, description: "Export with integrity signature" })
  async export(
    @Query() query: ExportAuditLogDto,
    @Res() res: Response,
  ): Promise<void> {
    const { payload, signature } =
      query.format === "csv"
        ? await this.auditLogService.exportToCsv(query)
        : await this.auditLogService.exportToJson(query);

    const ext = query.format === "csv" ? "csv" : "json";
    res.setHeader(
      "Content-Type",
      query.format === "csv" ? "text/csv" : "application/json",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-logs-${Date.now()}.${ext}"`,
    );
    res.setHeader("X-Signature", signature);
    res.send(payload);
  }
}

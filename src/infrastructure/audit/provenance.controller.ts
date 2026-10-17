import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  Res,
  NotFoundException,
  ParseUUIDPipe,
  HttpStatus,
  HttpCode,
  ForbiddenException,
  Req,
} from "@nestjs/common";
import { Request, Response } from "express";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { ProvenanceService } from "./provenance.service";
import {
  QueryProvenanceDto,
  ExportProvenanceDto,
} from "./dto/query-provenance.dto";
import {
  ProvenanceResponseDto,
  ProvenanceListResponseDto,
  ProvenanceVerificationResultDto,
  ProvenanceTimelineResponseDto,
} from "./dto/provenance-response.dto";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { ProvenanceAccessGuard } from "./guards/provenance-access.guard";
import { Role, normalizeRole } from "src/common/guard/roles.enum";

@ApiTags("Provenance")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ProvenanceAccessGuard)
@Controller("provenance")
export class ProvenanceController {
  constructor(private readonly provenanceService: ProvenanceService) {}

  @Get()
  @ApiOperation({
    summary: "Query provenance records",
    description:
      "Get a paginated list of provenance records with optional filters",
  })
  @ApiResponse({
    status: 200,
    description: "List of provenance records retrieved successfully",
    type: ProvenanceListResponseDto,
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async queryProvenance(
    @Query() query: QueryProvenanceDto,
  ): Promise<ProvenanceListResponseDto> {
    return this.provenanceService.queryProvenance(query);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get provenance record by ID",
    description: "Retrieve a single provenance record by its unique identifier",
  })
  @ApiParam({ name: "id", description: "Provenance record ID", type: "string" })
  @ApiResponse({
    status: 200,
    description: "Provenance record retrieved successfully",
    type: ProvenanceResponseDto,
  })
  @ApiResponse({ status: 404, description: "Provenance record not found" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden - can only export own records" })
  async getProvenanceById(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ProvenanceResponseDto> {
    return this.provenanceService.getProvenanceById(id);
  }

  @Get(":id/export")
  @ApiOperation({
    summary: "Export provenance record",
    description: "Export a provenance record in JSON or CSV format",
  })
  @ApiParam({ name: "id", description: "Provenance record ID", type: "string" })
  @ApiQuery({
    name: "format",
    required: false,
    enum: ["json", "csv"],
    description: "Export format",
  })
  @ApiResponse({
    status: 200,
    description: "Provenance record exported successfully",
  })
  @ApiResponse({ status: 404, description: "Provenance record not found" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async exportProvenance(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() exportDto: ExportProvenanceDto,
    @Req() req: Request & { user?: { id?: string; role?: string } },
    @Res() res: Response,
  ): Promise<void> {
    const format = exportDto.format || "json";
    const record = await this.provenanceService.getProvenanceById(id);
    this.assertCanExportUser(req.user, record.userId);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (format === "csv") {
      const csv = await this.provenanceService.exportProvenanceRecordToCsv(id);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="provenance-${id}.csv"`,
      );
      res.send(csv);
    } else {
      const json = JSON.stringify(record, null, 2);
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="provenance-${id}.json"`,
      );
      res.send(json);
    }
  }

  @Post(":id/verify")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Verify provenance record signature",
    description: "Verify the cryptographic signature of a provenance record",
  })
  @ApiParam({ name: "id", description: "Provenance record ID", type: "string" })
  @ApiResponse({
    status: 200,
    description: "Signature verification result",
    type: ProvenanceVerificationResultDto,
  })
  @ApiResponse({ status: 404, description: "Provenance record not found" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async verifySignature(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ProvenanceVerificationResultDto> {
    return this.provenanceService.verifySignature(id);
  }

  @Get("agents/:agentId")
  @ApiOperation({
    summary: "Get provenance for an agent",
    description: "Get all provenance records for a specific agent",
  })
  @ApiParam({ name: "agentId", description: "Agent ID", type: "string" })
  @ApiResponse({
    status: 200,
    description: "Agent provenance records retrieved successfully",
    type: ProvenanceListResponseDto,
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getProvenanceByAgentId(
    @Param("agentId") agentId: string,
    @Query() query: QueryProvenanceDto,
  ): Promise<ProvenanceListResponseDto> {
    return this.provenanceService.getProvenanceByAgentId(agentId, query);
  }

  @Get("agents/:agentId/timeline")
  @ApiOperation({
    summary: "Get agent provenance timeline",
    description:
      "Get chronological timeline of provenance records for an agent",
  })
  @ApiParam({ name: "agentId", description: "Agent ID", type: "string" })
  @ApiQuery({
    name: "fromDate",
    required: false,
    description: "Start date for timeline (ISO 8601)",
  })
  @ApiQuery({
    name: "toDate",
    required: false,
    description: "End date for timeline (ISO 8601)",
  })
  @ApiResponse({
    status: 200,
    description: "Agent provenance timeline retrieved successfully",
    type: ProvenanceTimelineResponseDto,
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getProvenanceTimeline(
    @Param("agentId") agentId: string,
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
  ): Promise<ProvenanceTimelineResponseDto> {
    return this.provenanceService.getProvenanceTimeline(
      agentId,
      fromDate,
      toDate,
    );
  }

  @Get("users/:userId")
  @ApiOperation({
    summary: "Get provenance for a user",
    description:
      "Get all provenance records for a specific user (admin or self only)",
  })
  @ApiParam({ name: "userId", description: "User ID", type: "string" })
  @ApiResponse({
    status: 200,
    description: "User provenance records retrieved successfully",
    type: ProvenanceListResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: "Forbidden - can only access own records",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getProvenanceByUserId(
    @Param("userId", ParseUUIDPipe) userId: string,
    @Query() query: QueryProvenanceDto,
  ): Promise<ProvenanceListResponseDto> {
    return this.provenanceService.getProvenanceByUserId(userId, query);
  }

  @Get("export/bulk")
  @ApiOperation({
    summary: "Bulk export provenance records",
    description: "Export multiple provenance records in CSV format",
  })
  @ApiQuery({
    name: "agentId",
    required: false,
    description: "Filter by agent ID",
  })
  @ApiQuery({
    name: "userId",
    required: false,
    description: "Filter by user ID",
  })
  @ApiQuery({
    name: "fromDate",
    required: false,
    description: "Filter records from this date",
  })
  @ApiQuery({
    name: "toDate",
    required: false,
    description: "Filter records to this date",
  })
  @ApiResponse({
    status: 200,
    description: "Provenance records exported successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden - can only export own records" })
  async bulkExportProvenance(
    @Query() query: QueryProvenanceDto,
    @Req() req: Request & { user?: { id?: string; role?: string } },
    @Res() res: Response,
  ): Promise<void> {
    const isAdmin = normalizeRole(req.user?.role) === Role.ADMIN;
    if (!isAdmin && !req.user?.id) {
      throw new ForbiddenException("An authenticated user is required for export");
    }
    // Non-admin exports are always restricted to the authenticated owner.
    const exportQuery = isAdmin ? query : { ...query, userId: req.user!.id };

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="provenance-export-${Date.now()}.csv"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const abortController = new AbortController();
    const abort = () => abortController.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once("aborted", abort);
    res.once("close", onClose);

    try {
      for await (const chunk of this.provenanceService.streamProvenanceCsv(
        exportQuery,
        undefined,
        abortController.signal,
      )) {
        if (abortController.signal.aborted) return;
        if (!res.write(chunk)) {
          await waitForDrainOrAbort(res, abortController.signal);
        }
        if (abortController.signal.aborted) return;
      }
      if (!abortController.signal.aborted) res.end();
    } catch (error) {
      if (!abortController.signal.aborted) {
        if (res.headersSent) res.destroy(error as Error);
        else throw error;
      }
    } finally {
      req.off("aborted", abort);
      res.off("close", onClose);
    }
  }

  private assertCanExportUser(
    user: { id?: string; role?: string } | undefined,
    recordUserId: string | undefined,
  ): void {
    if (normalizeRole(user?.role) === Role.ADMIN) return;
    if (!user?.id || recordUserId !== user.id) {
      throw new ForbiddenException("You can only export your own provenance records");
    }
  }
}

function waitForDrainOrAbort(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    if (signal.aborted) return resolve();
    response.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

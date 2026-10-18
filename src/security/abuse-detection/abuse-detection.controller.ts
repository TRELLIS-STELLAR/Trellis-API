import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Role, Roles } from "src/common/decorators/roles.decorator";
import { RolesGuard } from "src/common/guard/roles.guard";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { AbuseDetectionService } from "./abuse-detection.service";
import {
  AbuseActorContext,
  AbuseAssessmentResult,
  AbuseDetectionMetricsSnapshot,
  AbuseReviewRecord,
} from "./abuse-detection.types";
import {
  EvaluateAbuseRiskDto,
  QueryAbuseReviewsDto,
  ResolveAbuseReviewDto,
} from "./dto/abuse-detection.dto";

@ApiTags("Abuse Detection")
@ApiBearerAuth()
@Controller("security/abuse-detection")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AbuseDetectionController {
  constructor(private readonly abuseDetectionService: AbuseDetectionService) {}

  @Post("evaluate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Evaluate a high-impact operation for abuse risk",
    description:
      "Returns an explainable risk assessment with composite score, risk level, disposition, and remediation steps without throwing on elevated risk.",
  })
  @ApiResponse({ status: 200, description: "Abuse risk assessment result" })
  @ApiResponse({ status: 401, description: "Authentication required" })
  evaluate(
    @Body() dto: EvaluateAbuseRiskDto,
    @Req() request?: any,
  ): AbuseAssessmentResult {
    return this.abuseDetectionService.evaluateDto(
      dto,
      this.extractPrincipalContext(request),
    );
  }

  @Post("assert")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Evaluate and enforce abuse disposition for a high-impact operation",
    description:
      "Evaluates risk and throws HTTP 403 with explainable signals when step-up verification, manual review, or a hard block is triggered.",
  })
  @ApiResponse({ status: 200, description: "Operation allowed to proceed" })
  @ApiResponse({
    status: 403,
    description: "Operation requires step-up, manual review, or is blocked",
  })
  assertProceedable(
    @Body() dto: EvaluateAbuseRiskDto,
    @Req() request?: any,
  ): AbuseAssessmentResult {
    const assessment = this.abuseDetectionService.evaluateDto(
      dto,
      this.extractPrincipalContext(request),
    );
    return this.abuseDetectionService.assertProceedable(assessment);
  }

  @Get("reviews")
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: "List queued or resolved high-risk operation review items",
  })
  @ApiResponse({ status: 200, description: "Abuse review items" })
  listReviews(@Query() query: QueryAbuseReviewsDto): {
    data: AbuseReviewRecord[];
    count: number;
  } {
    const data = this.abuseDetectionService.listReviews({
      status: query?.status,
      actorId: query?.actorId,
    });
    return { data, count: data.length };
  }

  @Get("reviews/:reviewId")
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: "Get details of a specific abuse review record",
  })
  @ApiParam({ name: "reviewId", description: "Review identifier" })
  @ApiResponse({ status: 200, description: "Abuse review record" })
  @ApiResponse({ status: 404, description: "Review record not found" })
  getReview(@Param("reviewId") reviewId: string): AbuseReviewRecord {
    return this.abuseDetectionService.getReview(reviewId);
  }

  @Post("reviews/:reviewId/resolve")
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Approve or reject a high-risk operation queued for manual review",
  })
  @ApiParam({ name: "reviewId", description: "Review identifier" })
  @ApiResponse({ status: 200, description: "Resolved review record" })
  @ApiResponse({ status: 400, description: "Invalid resolution state or reason" })
  @ApiResponse({ status: 404, description: "Review record not found" })
  resolveReview(
    @Param("reviewId") reviewId: string,
    @Body() dto: ResolveAbuseReviewDto,
    @Req() request?: any,
  ): AbuseReviewRecord {
    const operatorId =
      String(request?.user?.id ?? request?.user?.sub ?? "operator");
    return this.abuseDetectionService.resolveReview(
      reviewId,
      dto.decision,
      operatorId,
      dto.reason,
    );
  }

  @Get("metrics")
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: "Get telemetry snapshot for risk-scored abuse detection",
  })
  @ApiResponse({ status: 200, description: "Abuse detection telemetry snapshot" })
  getMetrics(): AbuseDetectionMetricsSnapshot {
    return this.abuseDetectionService.getMetricsSnapshot();
  }

  private extractPrincipalContext(
    request?: any,
  ): Partial<AbuseActorContext> {
    const user = request?.user ?? {};
    const headers = request?.headers ?? {};
    const actorId = String(
      user.id ?? user.sub ?? user.address ?? request?.ip ?? "anonymous",
    );

    const stepUpHeader =
      headers["x-step-up-verified"] ??
      headers["x-totp-token"] ??
      headers["x-2fa-token"];

    const stepUpVerified =
      user.twoFactorVerified === true ||
      user.stepUpVerified === true ||
      stepUpHeader === "true" ||
      (typeof stepUpHeader === "string" && stepUpHeader.trim().length >= 6);

    const xff = headers["x-forwarded-for"];
    const ipAddress =
      typeof xff === "string" && xff.trim()
        ? xff.split(",")[0].trim()
        : request?.ip;

    return {
      actorId,
      actorRole: user.role,
      tenantId: user.tenantId,
      sessionId: user.sessionId,
      ipAddress,
      userAgent:
        typeof headers["user-agent"] === "string"
          ? headers["user-agent"]
          : undefined,
      stepUpVerified: stepUpVerified ? true : undefined,
      isImpersonated:
        user.isImpersonated === true || Boolean(user.impersonatorId),
      impersonatorId: user.impersonatorId,
      reviewApprovalToken:
        typeof headers["x-review-approval-token"] === "string"
          ? headers["x-review-approval-token"]
          : undefined,
    };
  }
}

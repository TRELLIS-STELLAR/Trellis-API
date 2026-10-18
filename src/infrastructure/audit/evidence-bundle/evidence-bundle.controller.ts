import {
  Body,
  Controller,
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
import { JwtAuthGuard } from "../../../core/auth/jwt.guard";
import { ComplianceOfficerGuard } from "../guards/compliance-officer.guard";
import { EvidenceBundleService } from "./evidence-bundle.service";
import {
  EvidenceBundle,
  GenerateEvidenceBundleDto,
  VerifyEvidenceBundleDto,
  BundleVerificationResult,
} from "./interfaces/evidence-bundle.interface";

@ApiTags("Audit Evidence Bundles")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ComplianceOfficerGuard)
@Controller("audit-trail/evidence-bundles")
export class EvidenceBundleController {
  constructor(private readonly bundleService: EvidenceBundleService) {}

  @Post("generate")
  @ApiOperation({
    summary: "Generate a privacy-preserving audit evidence bundle",
    description:
      "Compiles multi-domain telemetry and audit evidence across auth, portfolio, DeFi, notifications, observability, and audit trails. Redacts secrets/PII while preserving verifiable hashes, timestamps, and IDs. Cryptographically signs the bundle with HMAC-SHA256.",
  })
  @ApiResponse({
    status: 201,
    description: "Evidence bundle generated and signed successfully.",
  })
  @ApiResponse({
    status: 400,
    description: "Invalid request parameters (missing caseId).",
  })
  @ApiResponse({
    status: 403,
    description: "Forbidden. Access restricted to Admin and Compliance Officers.",
  })
  async generate(
    @Body() dto: GenerateEvidenceBundleDto,
    @Req() req: Request & { user?: Record<string, string> },
  ): Promise<EvidenceBundle> {
    const operator = {
      actorId:
        req.user?.id ?? req.user?.userId ?? req.user?.sub ?? "compliance-officer",
      actorRole: req.user?.role,
      actorType: "maintainer",
    };

    return this.bundleService.generateBundle(dto, operator);
  }

  @Post("verify")
  @ApiOperation({
    summary: "Verify cryptographic integrity and provenance of an evidence bundle",
    description:
      "Recomputes the canonical bundle hash, verifies the HMAC-SHA256 signature, validates audit trail hash chain continuity, and checks temporal monotonicity.",
  })
  @ApiResponse({
    status: 200,
    description: "Evidence bundle verification report.",
  })
  @ApiResponse({
    status: 400,
    description: "Malformed bundle structure.",
  })
  async verify(
    @Body() dto: VerifyEvidenceBundleDto,
  ): Promise<BundleVerificationResult> {
    return this.bundleService.verifyBundle(dto.bundle);
  }
}

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  ABUSE_HIGH_IMPACT_METADATA_KEY,
  ABUSE_RESPONSE_HEADERS,
} from "./abuse-detection.constants";
import { AbuseDetectionService } from "./abuse-detection.service";
import {
  AbuseActorContext,
  HighImpactOperationInput,
  HighImpactOperationKind,
} from "./abuse-detection.types";

export interface HighImpactOperationMetadata {
  kind: HighImpactOperationKind;
  amountField?: string;
  assetField?: string;
  destinationField?: string;
  portfolioIdField?: string;
  adapterIdField?: string;
  slippageBpsField?: string;
  portfolioExitFractionField?: string;
  recordCountField?: string;
}

/**
 * Marks a controller handler as a high-impact operation subject to
 * risk-scored abuse detection via {@link AbuseDetectionGuard}.
 */
export const HighImpactOperation = (metadata: HighImpactOperationMetadata) =>
  SetMetadata(ABUSE_HIGH_IMPACT_METADATA_KEY, metadata);

@Injectable()
export class AbuseDetectionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abuseDetectionService: AbuseDetectionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata =
      this.reflector.getAllAndOverride<HighImpactOperationMetadata>(
        ABUSE_HIGH_IMPACT_METADATA_KEY,
        [context.getHandler(), context.getClass()],
      );

    if (!metadata) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<any>();
    const response = http.getResponse<any>();

    const actor = this.extractActorContext(request);
    const operation = this.extractOperationInput(metadata, request);

    const assessment = this.abuseDetectionService.evaluateOperation(
      operation,
      actor,
    );

    request.abuseAssessment = assessment;

    if (response && typeof response.setHeader === "function") {
      response.setHeader(
        ABUSE_RESPONSE_HEADERS.ASSESSMENT_ID,
        assessment.assessmentId,
      );
      response.setHeader(
        ABUSE_RESPONSE_HEADERS.RISK_SCORE,
        String(assessment.score),
      );
      response.setHeader(
        ABUSE_RESPONSE_HEADERS.RISK_LEVEL,
        assessment.riskLevel,
      );
      response.setHeader(
        ABUSE_RESPONSE_HEADERS.DISPOSITION,
        assessment.disposition,
      );
      response.setHeader(
        ABUSE_RESPONSE_HEADERS.REQUIRED_ACTION,
        assessment.requiredAction,
      );
    }

    this.abuseDetectionService.assertProceedable(assessment);
    return true;
  }

  private extractActorContext(request: any): AbuseActorContext {
    const user = request?.user ?? {};
    const headers = request?.headers ?? {};
    const body = request?.body ?? {};

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
      body.stepUpVerified === true ||
      stepUpHeader === "true" ||
      (typeof stepUpHeader === "string" && stepUpHeader.trim().length >= 6);

    const reviewApprovalToken =
      (typeof headers["x-review-approval-token"] === "string"
        ? headers["x-review-approval-token"]
        : undefined) ?? body.reviewApprovalToken;

    const deviceFingerprint =
      (typeof headers["x-device-fingerprint"] === "string"
        ? headers["x-device-fingerprint"]
        : undefined) ?? body.deviceFingerprint;

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
      deviceFingerprint,
      userAgent:
        typeof headers["user-agent"] === "string"
          ? headers["user-agent"]
          : undefined,
      accountAgeDays:
        typeof user.accountAgeDays === "number"
          ? user.accountAgeDays
          : body.accountAgeDays,
      mfaEnabled:
        typeof user.mfaEnabled === "boolean"
          ? user.mfaEnabled
          : body.mfaEnabled,
      stepUpVerified,
      isImpersonated:
        user.isImpersonated === true || Boolean(user.impersonatorId),
      impersonatorId: user.impersonatorId,
      minutesSinceLastCredentialChange:
        typeof user.minutesSinceLastCredentialChange === "number"
          ? user.minutesSinceLastCredentialChange
          : body.minutesSinceLastCredentialChange,
      knownDevicesOrIps: user.knownDevicesOrIps ?? body.knownDevicesOrIps,
      verifiedDestinations:
        user.verifiedDestinations ?? body.verifiedDestinations,
      reviewApprovalToken,
    };
  }

  private extractOperationInput(
    metadata: HighImpactOperationMetadata,
    request: any,
  ): HighImpactOperationInput {
    const body = request?.body ?? {};
    const params = request?.params ?? {};
    const headers = request?.headers ?? {};

    const amountRaw = body[metadata.amountField ?? "amount"];
    const amount =
      typeof amountRaw === "number"
        ? amountRaw
        : typeof amountRaw === "string" && amountRaw.trim()
          ? Number(amountRaw)
          : undefined;

    return {
      kind: metadata.kind,
      amount: Number.isFinite(amount) ? amount : undefined,
      historicalAverageAmount:
        typeof body.historicalAverageAmount === "number"
          ? body.historicalAverageAmount
          : undefined,
      asset: body[metadata.assetField ?? "asset"],
      destination: body[metadata.destinationField ?? "destination"],
      portfolioId:
        body[metadata.portfolioIdField ?? "portfolioId"] ?? params.portfolioId,
      adapterId:
        body[metadata.adapterIdField ?? "adapterId"] ?? params.adapterId,
      slippageBps:
        typeof body[metadata.slippageBpsField ?? "slippageBps"] === "number"
          ? body[metadata.slippageBpsField ?? "slippageBps"]
          : undefined,
      portfolioExitFraction:
        typeof body[
          metadata.portfolioExitFractionField ?? "portfolioExitFraction"
        ] === "number"
          ? body[metadata.portfolioExitFractionField ?? "portfolioExitFraction"]
          : undefined,
      adapterVerified:
        typeof body.adapterVerified === "boolean"
          ? body.adapterVerified
          : undefined,
      recordOrRecipientCount:
        typeof body[metadata.recordCountField ?? "recordOrRecipientCount"] ===
        "number"
          ? body[metadata.recordCountField ?? "recordOrRecipientCount"]
          : Array.isArray(body.rows)
            ? body.rows.length
            : undefined,
      counterpartyFlagged: body.counterpartyFlagged === true,
      idempotencyKey:
        (typeof headers["idempotency-key"] === "string"
          ? headers["idempotency-key"]
          : undefined) ?? body.idempotencyKey,
    };
  }
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from "class-validator";
import { HIGH_IMPACT_OPERATION_KINDS } from "../abuse-detection.constants";
import {
  AbuseReviewStatus,
  HighImpactOperationKind,
} from "../abuse-detection.types";

export class EvaluateAbuseRiskDto {
  @ApiProperty({
    description: "High-impact operation category being evaluated",
    enum: HIGH_IMPACT_OPERATION_KINDS,
    example: "treasury_withdrawal",
  })
  @IsIn(HIGH_IMPACT_OPERATION_KINDS)
  kind!: HighImpactOperationKind;

  @ApiPropertyOptional({
    description: "Monetary or token amount involved in the operation",
    example: 12500,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({
    description: "Actor's historical average operation amount when known",
    example: 1500,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  historicalAverageAmount?: number;

  @ApiPropertyOptional({
    description: "Asset symbol or identifier",
    example: "USDC",
  })
  @IsOptional()
  @IsString()
  asset?: string;

  @ApiPropertyOptional({
    description: "Target destination wallet, contract address, or sink",
    example: "GCFX7R3EXAMPLEADDRESS",
  })
  @IsOptional()
  @IsString()
  destination?: string;

  @ApiPropertyOptional({
    description: "Target portfolio identifier when applicable",
    example: "port_01HXYZ",
  })
  @IsOptional()
  @IsString()
  portfolioId?: string;

  @ApiPropertyOptional({
    description: "Target DeFi adapter identifier when applicable",
    example: "soroswap-v1",
  })
  @IsOptional()
  @IsString()
  adapterId?: string;

  @ApiPropertyOptional({
    description: "Fraction of portfolio or DeFi position being exited (0.0 to 1.0)",
    example: 0.25,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  portfolioExitFraction?: number;

  @ApiPropertyOptional({
    description: "Slippage tolerance in basis points (e.g., 100 = 1%)",
    example: 50,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000)
  slippageBps?: number;

  @ApiPropertyOptional({
    description: "Whether the target DeFi adapter is verified in the protocol registry",
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  adapterVerified?: boolean;

  @ApiPropertyOptional({
    description: "Number of records or recipients targeted (for exports or notifications)",
    example: 25,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  recordOrRecipientCount?: number;

  @ApiPropertyOptional({
    description: "Whether the counterparty or destination is flagged on a high-risk denylist",
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  counterpartyFlagged?: boolean;

  @ApiPropertyOptional({
    description: "Idempotency or correlation key for the operation",
    example: "idem-2026-001",
  })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @ApiPropertyOptional({
    description: "Optional ISO timestamp for deterministic evaluation",
    example: "2026-10-16T10:00:00.000Z",
  })
  @IsOptional()
  @IsString()
  asOf?: string;

  @ApiPropertyOptional({
    description: "Whether a fresh step-up verification (TOTP/wallet challenge) was completed",
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  stepUpVerified?: boolean;

  @ApiPropertyOptional({
    description: "Minutes since the actor's last password, MFA, or API key mutation",
    example: 120,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minutesSinceLastCredentialChange?: number;

  @ApiPropertyOptional({
    description: "Account tenure in days",
    example: 90,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  accountAgeDays?: number;

  @ApiPropertyOptional({
    description: "Whether MFA is enrolled on the actor's account",
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  mfaEnabled?: boolean;

  @ApiPropertyOptional({
    description: "Verified destination addresses for this actor",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  verifiedDestinations?: string[];

  @ApiPropertyOptional({
    description: "Known trusted device fingerprints or IP identifiers for this actor",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  knownDevicesOrIps?: string[];

  @ApiPropertyOptional({
    description: "Device fingerprint of the current session",
    example: "dfp_trusted_laptop_01",
  })
  @IsOptional()
  @IsString()
  deviceFingerprint?: string;

  @ApiPropertyOptional({
    description: "Operator review approval token when retrying an approved high-risk operation",
    example: "rat_01HXYZ",
  })
  @IsOptional()
  @IsString()
  reviewApprovalToken?: string;
}

export class ResolveAbuseReviewDto {
  @ApiProperty({
    description: "Operator decision on the queued review item",
    enum: ["approved", "rejected"],
    example: "approved",
  })
  @IsIn(["approved", "rejected"])
  decision!: "approved" | "rejected";

  @ApiProperty({
    description: "Mandatory audit reason explaining why the operation was approved or rejected",
    example: "Verified treasury rebalance request with account owner via out-of-band confirmation.",
  })
  @IsString()
  @MinLength(10)
  reason!: string;
}

export class QueryAbuseReviewsDto {
  @ApiPropertyOptional({
    description: "Filter reviews by status",
    enum: ["pending", "approved", "rejected", "expired"],
  })
  @IsOptional()
  @IsIn(["pending", "approved", "rejected", "expired"])
  status?: AbuseReviewStatus;

  @ApiPropertyOptional({
    description: "Filter reviews by actor ID",
  })
  @IsOptional()
  @IsString()
  actorId?: string;
}

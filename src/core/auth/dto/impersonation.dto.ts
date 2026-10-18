import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsArray,
  IsEnum,
} from "class-validator";
import {
  SupportAccessScope,
  DEFAULT_IMPERSONATION_DURATION_MINUTES,
  MIN_IMPERSONATION_DURATION_MINUTES,
  MAX_IMPERSONATION_DURATION_MINUTES,
} from "../impersonation.types";

export class StartImpersonationDto {
  @ApiProperty({ description: "Target user ID to impersonate for support" })
  @IsString()
  @IsNotEmpty()
  targetUserId: string;

  @ApiPropertyOptional({
    description: "Operational reason for the support session (mandatory for immutable audit trail)",
    example: "Investigating user balance sync discrepancy from ticket SUP-1042",
  })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({
    description: "Support ticket or CRM reference ID",
    example: "SUP-1042",
  })
  @IsOptional()
  @IsString()
  ticketId?: string;

  @ApiPropertyOptional({
    description: `Session duration in minutes (min: ${MIN_IMPERSONATION_DURATION_MINUTES}, max: ${MAX_IMPERSONATION_DURATION_MINUTES}, default: ${DEFAULT_IMPERSONATION_DURATION_MINUTES})`,
    default: DEFAULT_IMPERSONATION_DURATION_MINUTES,
    minimum: MIN_IMPERSONATION_DURATION_MINUTES,
    maximum: MAX_IMPERSONATION_DURATION_MINUTES,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_IMPERSONATION_DURATION_MINUTES)
  @Max(MAX_IMPERSONATION_DURATION_MINUTES)
  durationMinutes?: number;

  @ApiPropertyOptional({
    description: "Granted support access scopes",
    enum: SupportAccessScope,
    isArray: true,
    default: [SupportAccessScope.READ_ONLY],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(SupportAccessScope, { each: true })
  scopes?: SupportAccessScope[];
}

export class StopImpersonationDto {
  @ApiProperty({ description: "Impersonated target user ID" })
  @IsString()
  @IsNotEmpty()
  targetUserId: string;

  @ApiPropertyOptional({
    description: "Reason for terminating the support access session",
    example: "Support inquiry completed",
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ImpersonationSessionResponseDto {
  @ApiProperty({ description: "Time-bounded JWT access token scoped for support access" })
  accessToken: string;

  @ApiProperty({
    description: "Target user profile context",
    example: { id: "uuid", email: "user@example.com", role: "USER", isImpersonated: true },
  })
  user: {
    id: string;
    email: string | null;
    role: string;
    isImpersonated: boolean;
  };

  @ApiProperty({
    description: "Session metadata including granted scopes and expiration timestamp",
  })
  session: {
    scopes: SupportAccessScope[];
    expiresAt: string;
    durationMinutes: number;
    ticketId?: string | null;
    userNotice: string;
  };
}

export class SupportNoticeResponseDto {
  @ApiProperty({ description: "Whether support access is currently active on the account" })
  hasActiveSupportAccess: boolean;

  @ApiPropertyOptional({
    description: "User-safe notice text suitable for client banner display without leaking admin PII",
  })
  notice: string | null;

  @ApiPropertyOptional({
    description: "Active session parameters if currently active",
  })
  session?: {
    scopes: SupportAccessScope[];
    startedAt: string;
    expiresAt: string;
    ticketId?: string | null;
  } | null;
}

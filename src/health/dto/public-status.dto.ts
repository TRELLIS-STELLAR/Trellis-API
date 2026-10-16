import {
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ALL_PUBLIC_COMPONENTS,
  PublicCapabilitiesView,
  PublicComponentId,
  PublicComponentStatusView,
  PublicMaintenanceWindowView,
  PublicPausedScopeView,
  PublicSystemState,
  PublicSystemStatusView,
} from "../public-status.model";

export class SetMaintenanceWindowDto {
  @ApiProperty({
    description:
      "Reason for entering maintenance mode. Any secret or internal host in the text is automatically redacted before public display.",
    example: "Scheduled PostgreSQL minor version upgrade and index maintenance.",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({
    description: "Scheduled start time (ISO 8601)",
    example: "2026-10-16T12:00:00.000Z",
  })
  @IsOptional()
  @IsDateString()
  scheduledStartAt?: string;

  @ApiPropertyOptional({
    description: "Estimated completion time (ISO 8601) used to compute Retry-After",
    example: "2026-10-16T13:00:00.000Z",
  })
  @IsOptional()
  @IsDateString()
  estimatedEndAt?: string;

  @ApiPropertyOptional({
    description: "Affected operational scopes (defaults to ['all'])",
    type: [String],
    example: ["all"],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  affectedScopes?: string[];
}

export class ClearMaintenanceWindowDto {
  @ApiProperty({
    description: "Audit reason for clearing the maintenance window",
    example: "Upgrade verified and readiness checks green.",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class DeclareComponentDegradationDto {
  @ApiProperty({
    enum: ALL_PUBLIC_COMPONENTS,
    description: "Target component experiencing partial degradation",
    example: "defi",
  })
  @IsIn(ALL_PUBLIC_COMPONENTS)
  componentId: PublicComponentId;

  @ApiProperty({
    description:
      "Reason for the component degradation. Sensitive values are scrubbed automatically.",
    example: "Upstream Ethereum RPC provider experiencing elevated latency.",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({
    description: "Estimated recovery timestamp (ISO 8601)",
    example: "2026-10-16T14:00:00.000Z",
  })
  @IsOptional()
  @IsDateString()
  estimatedRecoveryAt?: string;
}

export class ClearComponentDegradationDto {
  @ApiProperty({
    enum: ALL_PUBLIC_COMPONENTS,
    description: "Target component whose degradation has been resolved",
    example: "defi",
  })
  @IsIn(ALL_PUBLIC_COMPONENTS)
  componentId: PublicComponentId;

  @ApiPropertyOptional({
    description: "Audit note for clearing the component degradation",
    example: "RPC latency returned within 200ms budget.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PublicSystemStatusDto implements PublicSystemStatusView {
  @ApiProperty({
    enum: ["operational", "degraded", "paused", "maintenance"],
    example: "operational",
  })
  state: PublicSystemState;

  @ApiProperty({ enum: [200, 503], example: 200 })
  httpStatusCode: 200 | 503;

  @ApiProperty({
    example: "All systems are operational.",
    description: "Sanitized, user-safe status summary with zero secret exposure.",
  })
  summary: string;

  @ApiProperty({ example: "2026-10-16T10:00:00.000Z" })
  generatedAt: string;

  @ApiPropertyOptional({
    example: 300,
    description: "Recommended client retry delay in seconds when paused or in maintenance",
  })
  retryAfterSeconds?: number;

  @ApiPropertyOptional({ nullable: true })
  maintenanceWindow: PublicMaintenanceWindowView | null;

  @ApiProperty({ type: "array" })
  pausedScopes: PublicPausedScopeView[];

  @ApiProperty({ type: "object" })
  components: Record<PublicComponentId, PublicComponentStatusView>;

  @ApiProperty({ type: "object" })
  capabilities: PublicCapabilitiesView;
}

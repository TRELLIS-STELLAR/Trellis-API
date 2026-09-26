import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, IsEnum, IsUUID, IsObject, MaxLength, MinLength } from "class-validator";

export enum ExportFormat {
  JSON = "json",
  CSV = "csv",
  PARQUET = "parquet",
}

export enum ExportScope {
  USER_DATA = "user_data",
  PORTFOLIO = "portfolio",
  AUDIT_LOG = "audit_log",
  TRANSACTION_HISTORY = "transaction_history",
}

export class CreateExportDto {
  @ApiProperty({
    description: "Scope of data to export",
    enum: ExportScope,
    example: ExportScope.USER_DATA,
  })
  @IsEnum(ExportScope)
  scope: ExportScope;

  @ApiPropertyOptional({
    description: "Export format",
    enum: ExportFormat,
    default: ExportFormat.JSON,
    example: ExportFormat.JSON,
  })
  @IsOptional()
  @IsEnum(ExportFormat)
  format?: ExportFormat;

  @ApiPropertyOptional({
    description: "Schema version for the export",
    default: "1.0.0",
    example: "1.0.0",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  schemaVersion?: string;

  @ApiPropertyOptional({
    description: "Optional filters for the export scope",
    type: "object",
    example: { startDate: "2024-01-01", endDate: "2024-12-31" },
  })
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;

  @ApiPropertyOptional({
    description: "Retention period in days before the export expires",
    default: 7,
    example: 7,
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  retentionDays?: number;
}

export class ExportResponseDto {
  @ApiProperty({ description: "Unique export job ID", example: "export_abc123" })
  exportId: string;

  @ApiProperty({ description: "Current status of the export", example: "processing" })
  status: string;

  @ApiProperty({ description: "Schema version used for this export", example: "1.0.0" })
  schemaVersion: string;

  @ApiPropertyOptional({ description: "Download URL when ready", example: "https://..." })
  downloadUrl?: string;

  @ApiProperty({ description: "Expiration timestamp", example: "2024-01-08T00:00:00Z" })
  expiresAt: string;

  @ApiProperty({ description: "Creation timestamp", example: "2024-01-01T00:00:00Z" })
  createdAt: string;
}

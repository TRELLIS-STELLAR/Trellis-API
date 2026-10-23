import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import {
  CrossRepoClientStatus,
  CrossRepoFieldType,
  CrossRepoRequestEnvelope,
} from "../cross-repo.types";

/** Body for `POST /api/v1/cross-repo/validate`. */
export class CrossRepoValidateRequestDto implements CrossRepoRequestEnvelope {
  @ApiProperty({ example: "trellis-frontend", description: "Registered client id" })
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @ApiProperty({ example: "1.0", description: "Contract version the request was built against" })
  @IsString()
  @IsNotEmpty()
  contractVersion: string;

  @ApiProperty({ example: "oracle.submission", description: "Request type being validated" })
  @IsString()
  @IsNotEmpty()
  requestType: string;

  @ApiProperty({ description: "Request payload to validate against the contract" })
  @IsObject()
  payload: Record<string, unknown>;

  @ApiProperty({ description: "ISO timestamp the client signed the request at" })
  @IsISO8601()
  signedAt: string;

  @ApiProperty({ description: "HMAC-SHA256 hex signature over the canonical signing payload" })
  @IsString()
  @IsNotEmpty()
  signature: string;

  @ApiPropertyOptional({ description: "Idempotency key supplied by the client" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;
}

export class RegisterCrossRepoClientDto {
  @ApiProperty({ example: "trellis-frontend" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  clientId: string;

  @ApiProperty({ example: "Trellis Frontend" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  clientName: string;

  @ApiProperty({ description: "Raw HMAC secret. Shown once; stored in memory." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  secret: string;

  @ApiPropertyOptional({ type: [String], example: ["oracle:submit"] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({ type: [String], example: ["1.0"] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contractVersions?: string[];
}

export class UpdateCrossRepoClientStatusDto {
  @ApiProperty({ enum: ["active", "suspended", "revoked"] })
  @IsIn(["active", "suspended", "revoked"] as CrossRepoClientStatus[])
  status: CrossRepoClientStatus;
}

export class RegisterCrossRepoSchemaDto {
  @ApiProperty({ example: "portfolio.import" })
  @IsString()
  @IsNotEmpty()
  requestType: string;

  @ApiProperty({ example: "1.0" })
  @IsString()
  @IsNotEmpty()
  contractVersion: string;

  @ApiProperty({
    type: [Object],
    description: "Field schemas for this request type",
    example: [{ name: "source", type: "string", required: true }],
  })
  @IsArray()
  @IsObject({ each: true })
  fields: Array<{
    name: string;
    type: CrossRepoFieldType;
    required: boolean;
    pattern?: string;
    min?: number;
    max?: number;
    allowed?: Array<string | number | boolean>;
  }>;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsArray, IsIn, IsOptional, IsString, IsNotEmpty } from "class-validator";
import { DegradedModeLevel } from "../degraded-mode.types";

export class ManualDegradedModeDto {
  @ApiProperty({ enum: ["degraded", "restricted", "maintenance"] })
  @IsIn(["degraded", "restricted", "maintenance"] as DegradedModeLevel[])
  level: DegradedModeLevel;

  @ApiProperty({ example: "Database failover in progress" })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({
    type: [String],
    description: "Additional capabilities to disable beyond the level default",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Type(() => String)
  disabledCapabilities?: string[];
}

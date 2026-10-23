import { ApiProperty } from "@nestjs/swagger";

export class PublicHealthCheckDto {
  @ApiProperty({
    example: "database",
    enum: [
      "database",
      "cache",
      "external-dependencies",
      "optional-dependencies",
    ],
  })
  name: string;

  @ApiProperty({ example: "up", enum: ["up", "degraded", "down", "disabled"] })
  status: "up" | "degraded" | "down" | "disabled";

  @ApiProperty({
    example: true,
    description:
      "When true, this check being down takes the API out of service (HTTP 503).",
  })
  critical: boolean;
}

export class PublicHealthResponseDto {
  @ApiProperty({ example: "ok", enum: ["ok", "degraded", "down"] })
  status: "ok" | "degraded" | "down";

  @ApiProperty({ example: "2026-10-18T12:00:00.000Z" })
  timestamp: string;

  @ApiProperty({
    example: 3600,
    description: "Seconds since the process started.",
  })
  uptimeSeconds: number;

  @ApiProperty({ type: [PublicHealthCheckDto] })
  checks: PublicHealthCheckDto[];
}

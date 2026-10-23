import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class VerifySnapshotExportDto {
  @ApiProperty({ description: "Export document id to verify" })
  @IsString()
  @IsNotEmpty()
  exportId: string;
}

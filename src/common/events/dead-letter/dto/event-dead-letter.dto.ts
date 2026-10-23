import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { DeadLetterStatus } from "../event-dead-letter.types";

export class ListDeadLettersQueryDto {
  @ApiPropertyOptional({ enum: ["pending", "replayed", "discarded"] })
  @IsOptional()
  @IsIn(["pending", "replayed", "discarded"])
  status?: DeadLetterStatus;

  @ApiPropertyOptional({ example: "trade.settled" })
  @IsOptional()
  @IsString()
  eventName?: string;

  @ApiPropertyOptional({ example: "settlement-projection" })
  @IsOptional()
  @IsString()
  handlerName?: string;
}

export class ReplayDeadLettersDto {
  @ApiPropertyOptional({ example: "trade.settled" })
  @IsOptional()
  @IsString()
  eventName?: string;

  @ApiPropertyOptional({ example: "settlement-projection" })
  @IsOptional()
  @IsString()
  handlerName?: string;
}

export class DiscardDeadLetterDto {
  @ApiProperty({ example: "Event no longer relevant after manual reconciliation" })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

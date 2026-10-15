import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** Decimal-string amount, e.g. "10" or "10.5". No leading sign, no exponent. */
const DECIMAL_STRING = /^\d+(\.\d+)?$/;

export class CreateRateQuoteDto {
  @ApiProperty({
    description: "Source currency code (e.g. USD, EUR, GBP)",
    example: "USD",
  })
  @IsString()
  @IsNotEmpty()
  fromCurrency: string;

  @ApiProperty({
    description: "Target currency/crypto asset code (e.g. XLM, USDC, BTC, ETH)",
    example: "XLM",
  })
  @IsString()
  @IsNotEmpty()
  toCurrency: string;

  @ApiProperty({
    description: "Decimal string amount in source currency, e.g. '10.5'",
    example: "100.00",
  })
  @IsString()
  @Matches(DECIMAL_STRING, {
    message: "fromAmount must be a non-negative decimal string, e.g. '10.5'",
  })
  fromAmount: string;

  @ApiPropertyOptional({
    description: "Optional custom spot conversion rate (units of target currency per 1 unit of source currency)",
    example: 8.5,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  spotRate?: number;
}

export class RateQuoteResponseDto {
  @ApiProperty({ description: "Unique quote identifier" })
  quoteId: string;

  @ApiProperty({ description: "Source fiat currency" })
  fromCurrency: string;

  @ApiProperty({ description: "Target crypto asset currency" })
  toCurrency: string;

  @ApiProperty({ description: "Amount in source currency" })
  fromAmount: string;

  @ApiProperty({ description: "Raw spot conversion rate" })
  spotRate: number;

  @ApiProperty({ description: "Buffer percentage applied for market volatility safety (e.g. 1.0 for 1%)" })
  bufferPercent: number;

  @ApiProperty({ description: "Effective conversion rate after 1% volatility buffer" })
  effectiveRate: number;

  @ApiProperty({ description: "Calculated target amount after 1% buffer" })
  toAmount: string;

  @ApiProperty({ description: "Quote creation timestamp (milliseconds since epoch)" })
  createdAt: number;

  @ApiProperty({ description: "Quote expiration timestamp (milliseconds since epoch, 15 minutes after creation)" })
  expiresAt: number;

  @ApiProperty({ description: "Time-to-live in seconds (15-minute lock window: 900s)" })
  expiresInSeconds: number;
}

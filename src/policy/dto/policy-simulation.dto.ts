import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from "class-validator";
import {
  AnyDomainPolicy,
  PolicyDomain,
  PolicySimulationSnapshot,
} from "../policy.types";

export const POLICY_DOMAINS: PolicyDomain[] = [
  "trading",
  "defi_adapters",
  "portfolio_rebalancing",
  "auth_access",
  "notification_routing",
];

export class SimulatePolicyChangeDto {
  @ApiProperty({
    description: "Policy domain to simulate",
    enum: POLICY_DOMAINS,
    example: "trading",
  })
  @IsIn(POLICY_DOMAINS)
  domain!: PolicyDomain;

  @ApiProperty({
    description:
      "Proposed policy fields to preview against the active domain policy",
    example: {
      enabled: true,
      maxOrderAmount: 50000,
      allowedAssets: ["XLM", "USDC"],
      allowedSides: ["buy", "sell"],
    },
  })
  @IsObject()
  proposedPolicy!: Partial<AnyDomainPolicy>;

  @ApiPropertyOptional({
    description:
      "Optional baseline policy override (defaults to active configured domain policy)",
  })
  @IsOptional()
  @IsObject()
  currentPolicy?: Partial<AnyDomainPolicy>;

  @ApiPropertyOptional({
    description:
      "Optional point-in-time population and record snapshot for simulation",
  })
  @IsOptional()
  @IsObject()
  snapshot?: PolicySimulationSnapshot;

  @ApiPropertyOptional({
    description:
      "Optional ISO-8601 timestamp for deterministic simulation reproducibility",
    example: "2026-10-17T00:00:00.000Z",
  })
  @IsOptional()
  @IsString()
  asOf?: string;

  @ApiPropertyOptional({
    description: "Maximum acceptable snapshot age in seconds before flagging stale",
    example: 300,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(86400)
  maxSnapshotAgeSeconds?: number;
}

export class CommitPolicyChangeDto extends SimulatePolicyChangeDto {
  @ApiProperty({
    description:
      "Audit reason explaining why this policy change is being committed",
    example: "Lower max order limit during elevated volatility window",
  })
  @IsString()
  @MinLength(3)
  reason!: string;

  @ApiPropertyOptional({
    description:
      "Deterministic commitToken returned by POST /policy/simulations/preview (required for high-impact or irreversible changes)",
    example: "pctk:trading:0123456789abcdef01234567",
  })
  @IsOptional()
  @IsString()
  commitToken?: string;
}

export class RollbackPolicyChangeDto {
  @ApiProperty({
    description: "Audit reason for rolling back the committed policy change",
    example: "Restore previous policy after volatility window closed",
  })
  @IsString()
  @MinLength(3)
  reason!: string;
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Role, Roles } from "src/common/decorators/roles.decorator";
import { RolesGuard } from "src/common/guard/roles.guard";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import {
  CommitPolicyChangeDto,
  RollbackPolicyChangeDto,
  SimulatePolicyChangeDto,
} from "./dto/policy-simulation.dto";
import { PolicySimulationService } from "./policy-simulation.service";
import {
  DomainPolicyMap,
  PolicyCommitRecord,
  PolicyDomain,
  PolicySimulationMetricsSnapshot,
  PolicySimulationPreviewResult,
  RollbackConstraint,
} from "./policy.types";

@ApiTags("Policy Simulation")
@ApiBearerAuth()
@Controller("policy/simulations")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.MAINTAINER)
export class PolicyController {
  constructor(
    private readonly policySimulationService: PolicySimulationService,
  ) {}

  @Post("preview")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Simulate a policy change and preview affected records/users, side effects, and rollback constraints",
    description:
      "Read-only dry-run preview before committing irreversible or high-impact changes across trading, DeFi adapters, portfolio rebalancing, auth access, or notification routing.",
  })
  @ApiResponse({
    status: 200,
    description: "Deterministic policy simulation preview report",
  })
  @ApiResponse({ status: 401, description: "Authentication required" })
  @ApiResponse({ status: 403, description: "Maintainer or Admin role required" })
  preview(
    @Body() dto: SimulatePolicyChangeDto,
    @Req() request?: any,
  ): Promise<PolicySimulationPreviewResult> {
    return this.policySimulationService.preview(dto, this.extractActor(request));
  }

  @Post("assert")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Assert that a proposed policy change is valid, uses a fresh snapshot, and has a matching commitToken when high-impact",
  })
  @ApiResponse({ status: 200, description: "Policy change is safe to commit" })
  @ApiResponse({
    status: 400,
    description:
      "Blocked by invalid policy configuration, stale snapshot, or missing/mismatched commitToken",
  })
  assertProceedable(
    @Body() dto: CommitPolicyChangeDto,
    @Req() request?: any,
  ): Promise<PolicySimulationPreviewResult> {
    return this.policySimulationService.assertProceedable(
      dto,
      this.extractActor(request),
    );
  }

  @Post("commit")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Commit a simulated policy change after verifying preview preconditions and record a rollback snapshot",
  })
  @ApiResponse({
    status: 200,
    description: "Policy change committed with rollback snapshot",
  })
  @ApiResponse({
    status: 400,
    description:
      "Blocked by validation error, stale snapshot, or missing commitToken",
  })
  commit(
    @Body() dto: CommitPolicyChangeDto,
    @Req() request?: any,
  ): Promise<{
    commit: PolicyCommitRecord;
    preview: PolicySimulationPreviewResult;
  }> {
    return this.policySimulationService.commitPolicyChange(
      dto,
      this.extractActor(request),
    );
  }

  @Post("rollback/:commitId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Roll back a previously committed policy configuration and surface any manual recovery steps",
  })
  @ApiParam({ name: "commitId", description: "Commit identifier to roll back" })
  @ApiResponse({
    status: 200,
    description:
      "Policy configuration restored to previous snapshot with recovery guidance",
  })
  @ApiResponse({ status: 404, description: "Commit record not found" })
  rollback(
    @Param("commitId") commitId: string,
    @Body() dto: RollbackPolicyChangeDto,
    @Req() request?: any,
  ): {
    commit: PolicyCommitRecord;
    restoredPolicy: DomainPolicyMap[PolicyDomain];
    manualRecoveryRequired: boolean;
    recoveryConstraints: RollbackConstraint[];
  } {
    return this.policySimulationService.rollbackPolicyChange(
      commitId,
      dto.reason,
      this.extractActor(request),
    );
  }

  @Get("active")
  @ApiOperation({
    summary: "Get currently active policy configurations across all domains",
  })
  @ApiResponse({ status: 200, description: "Active domain policy map" })
  getActivePolicies(): DomainPolicyMap {
    return this.policySimulationService.getActivePolicies();
  }

  @Get("history")
  @ApiOperation({
    summary: "List committed policy changes and their rollback status",
  })
  @ApiQuery({
    name: "domain",
    required: false,
    description: "Optional policy domain filter",
  })
  @ApiResponse({ status: 200, description: "Policy commit audit history" })
  getHistory(@Query("domain") domain?: PolicyDomain): {
    data: PolicyCommitRecord[];
    count: number;
  } {
    const data = this.policySimulationService.getCommitHistory(domain);
    return { data, count: data.length };
  }

  @Get("metrics")
  @ApiOperation({
    summary: "Get observability metrics for policy simulations, commits, and rollbacks",
  })
  @ApiResponse({
    status: 200,
    description: "Policy simulation telemetry snapshot",
  })
  getMetrics(): PolicySimulationMetricsSnapshot {
    return this.policySimulationService.getMetricsSnapshot();
  }

  private extractActor(request?: any): string {
    const user = request?.user;
    return String(user?.id ?? user?.sub ?? user?.address ?? "maintainer");
  }
}

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Public } from "../common/decorators/public.decorator";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import { JwtAuthGuard } from "../core/auth/jwt.guard";
import { RolesGuard } from "../common/guard/roles.guard";
import { Roles } from "../common/guard/roles.decorator";
import { Role } from "../common/guard/roles.enum";
import { CrossRepoRequestValidationService } from "./cross-repo.service";
import {
  CrossRepoClientSummary,
  CrossRepoValidationResult,
} from "./cross-repo.types";
import {
  CrossRepoValidateRequestDto,
  RegisterCrossRepoClientDto,
  RegisterCrossRepoSchemaDto,
  UpdateCrossRepoClientStatusDto,
} from "./dto/cross-repo.dto";

/**
 * Cross-repo request validation surface (issue #353).
 *
 * `POST /api/v1/cross-repo/validate` is intentionally `@Public()`: it is a
 * machine-to-machine endpoint whose authorization is the client signature
 * verified by the service, not a user JWT. It is rate limited to avoid being
 * used as an amplifier. Client and schema administration is admin-only.
 */
@ApiTags("Cross-repo")
@Controller("api/v1/cross-repo")
export class CrossRepoController {
  constructor(private readonly service: CrossRepoRequestValidationService) {}

  @Post("validate")
  @Public()
  @RateLimit({ level: "cross-repo-validation", limit: 60, windowMs: 60_000 })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Validate a cross-repo client request",
    description:
      "Verifies the client is registered and authorised, the signature is valid, " +
      "and the payload matches the cross-repo contract. Returns a structured verdict; " +
      "a transient schema-provider failure is reported as retryable.",
  })
  @ApiResponse({ status: 200, description: "Validation verdict" })
  validate(
    @Body() dto: CrossRepoValidateRequestDto,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<CrossRepoValidationResult> {
    return this.service.validate(dto, correlationId);
  }

  @Get("clients")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List registered cross-repo clients (secret-free)" })
  @ApiResponse({ status: 200, description: "Client summaries" })
  listClients(): CrossRepoClientSummary[] {
    return this.service.listClients();
  }

  @Post("clients")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Register a cross-repo client" })
  @ApiResponse({ status: 201, description: "Client summary" })
  @HttpCode(HttpStatus.CREATED)
  registerClient(@Body() dto: RegisterCrossRepoClientDto): CrossRepoClientSummary {
    return this.service.registerClient(dto);
  }

  @Post("clients/:clientId/status")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Suspend, revoke or reactivate a cross-repo client" })
  updateClientStatus(
    @Param("clientId") clientId: string,
    @Body() dto: UpdateCrossRepoClientStatusDto,
  ): CrossRepoClientSummary {
    return this.service.updateClientStatus(clientId, dto.status);
  }

  @Post("schemas")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Register an additional cross-repo contract schema" })
  @ApiResponse({ status: 201, description: "Registered schema" })
  @HttpCode(HttpStatus.CREATED)
  registerSchema(@Body() dto: RegisterCrossRepoSchemaDto) {
    return this.service.registerSchema(dto);
  }
}

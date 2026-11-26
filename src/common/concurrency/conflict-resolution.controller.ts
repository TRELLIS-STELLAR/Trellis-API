import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import {
  ConflictResolutionService,
  EditRequest,
  EditResult,
  ConflictResolutionStrategy,
} from "./conflict-resolution.service";
import { JwtAuthGuard } from "src/core/auth/guards/jwt-auth.guard";
import { CurrentUser } from "src/core/auth/decorators/current-user.decorator";

interface User {
  sub: string;
  email?: string;
}

@ApiTags("conflict-resolution")
@Controller("api/v1/conflicts")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ConflictResolutionController {
  private readonly logger = new Logger(ConflictResolutionController.name);

  // In-memory storage for demonstration (replace with real persistence in production)
  private readonly storage = new Map<string, any>();

  constructor(private readonly resolutionService: ConflictResolutionService) {}

  @Post("resolve")
  @ApiOperation({
    summary: "Resolve edit conflicts with automatic or manual strategies",
  })
  @ApiResponse({ status: 200, description: "Edit resolved successfully" })
  @ApiResponse({ status: 409, description: "Conflict detected, manual resolution required" })
  async resolveEdit(
    @Body()
    body: {
      resourceId: string;
      resourceType: string;
      baseVersion: number;
      proposedData: any;
      strategy?: ConflictResolutionStrategy;
    },
    @CurrentUser() user: User
  ): Promise<EditResult> {
    const request: EditRequest = {
      ...body,
      userId: user.sub,
      strategy: body.strategy || ConflictResolutionStrategy.THREE_WAY_MERGE,
    };

    const key = `${body.resourceType}:${body.resourceId}`;

    // Get current state
    const getCurrentState = async () => {
      const existing = this.storage.get(key);
      if (!existing) {
        // Initialize if not exists
        return {
          ...body.proposedData,
          version: 0,
        };
      }
      return existing;
    };

    // Save state
    const saveState = async (data: any) => {
      this.storage.set(key, data);
      return data;
    };

    const result = await this.resolutionService.resolveEdit(
      request,
      getCurrentState,
      saveState
    );

    if (!result.success && result.requiresManualResolution) {
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          message: result.message,
          data: result.data,
          version: result.version,
          conflicts: result.conflicts,
          strategy: result.strategy,
        },
        HttpStatus.CONFLICT
      );
    }

    return result;
  }

  @Get("statistics")
  @ApiOperation({ summary: "Get conflict resolution statistics" })
  @ApiQuery({ name: "resourceType", required: false, description: "Filter by resource type" })
  @ApiResponse({ status: 200, description: "Statistics retrieved successfully" })
  async getStatistics(@Query("resourceType") resourceType?: string) {
    return this.resolutionService.getStatistics(resourceType);
  }

  @Get("resource/:type/:id")
  @ApiOperation({ summary: "Get current resource state" })
  @ApiResponse({ status: 200, description: "Resource retrieved successfully" })
  @ApiResponse({ status: 404, description: "Resource not found" })
  async getResource(
    @Param("type") resourceType: string,
    @Param("id") resourceId: string
  ) {
    const key = `${resourceType}:${resourceId}`;
    const resource = this.storage.get(key);

    if (!resource) {
      throw new HttpException("Resource not found", HttpStatus.NOT_FOUND);
    }

    return {
      resourceType,
      resourceId,
      data: resource,
      version: resource.version,
    };
  }

  @Post("resource/:type/:id")
  @ApiOperation({ summary: "Create or initialize a resource" })
  @ApiResponse({ status: 201, description: "Resource created successfully" })
  async createResource(
    @Param("type") resourceType: string,
    @Param("id") resourceId: string,
    @Body() data: any,
    @CurrentUser() user: User
  ) {
    const key = `${resourceType}:${resourceId}`;

    if (this.storage.has(key)) {
      throw new HttpException("Resource already exists", HttpStatus.CONFLICT);
    }

    const resource = {
      ...data,
      version: 0,
      createdBy: user.sub,
      createdAt: new Date(),
    };

    this.storage.set(key, resource);

    this.logger.log(
      `Resource created: ${resourceType}:${resourceId} by ${user.sub}`
    );

    return {
      resourceType,
      resourceId,
      data: resource,
      version: resource.version,
    };
  }
}

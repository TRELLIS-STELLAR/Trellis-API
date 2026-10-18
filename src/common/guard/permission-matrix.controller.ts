import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  UseGuards,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { Roles, Role } from "src/common/decorators/roles.decorator";
import { RolesGuard } from "src/common/guard/roles.guard";
import {
  PERMISSION_MATRIX,
  getActionsForRole,
  getSensitiveActions,
} from "./permission-matrix";
import { normalizeRole, getRolePermissions, Permission } from "./roles.enum";
import {
  PermissionDiffService,
  PermissionDiffReport,
} from "./permission-diff.service";

export class PermissionDiffDto {
  targetType: "role" | "user";
  targetId: string;
  currentRoles?: string[];
  proposedRoles?: string[];
  proposedPermissions?: Permission[];
}

@ApiTags("Permissions")
@ApiBearerAuth()
@Controller("permissions")
@UseGuards(JwtAuthGuard, RolesGuard)
export class PermissionMatrixController {
  constructor(
    private readonly permissionDiffService: PermissionDiffService,
  ) {}

  @Get("matrix")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "List all permission matrix entries" })
  @ApiResponse({ status: 200, description: "Full permission matrix" })
  getMatrix() {
    return { success: true, matrix: PERMISSION_MATRIX, total: PERMISSION_MATRIX.length };
  }

  @Get("matrix/role/:role")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "List permission matrix entries for a specific role" })
  @ApiParam({ name: "role", description: "Role name (e.g., MAINTAINER)" })
  getMatrixForRole(@Param("role") role: string) {
    const normalizedRole = normalizeRole(role);
    const entries = getActionsForRole(normalizedRole);
    return { success: true, role: normalizedRole, entries, total: entries.length };
  }

  @Get("matrix/sensitive")
  @Roles(Role.MAINTAINER)
  @ApiOperation({ summary: "List sensitive actions requiring audit" })
  @ApiResponse({ status: 200, description: "Sensitive actions list" })
  getSensitiveActions() {
    const entries = getSensitiveActions();
    return { success: true, entries, total: entries.length };
  }

  @Post("diff")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Generate a permission-diff report before applying role or policy changes" })
  @ApiBody({ type: PermissionDiffDto })
  @ApiResponse({ status: 200, description: "Permission diff report" })
  generateDiff(@Body() dto: PermissionDiffDto): PermissionDiffReport {
    if (!dto || !dto.targetType || !dto.targetId) {
      throw new BadRequestException("targetType ('role' | 'user') and targetId are required.");
    }

    if (dto.targetType === "role") {
      if (!dto.proposedPermissions || !Array.isArray(dto.proposedPermissions)) {
        throw new BadRequestException("proposedPermissions array is required for role diff.");
      }
      return this.permissionDiffService.generateRoleDiff(
        dto.targetId,
        dto.proposedPermissions,
      );
    }

    if (dto.targetType === "user") {
      if (!dto.proposedRoles || !Array.isArray(dto.proposedRoles)) {
        throw new BadRequestException("proposedRoles array is required for user diff.");
      }
      return this.permissionDiffService.generateUserRoleDiff(
        dto.targetId,
        dto.currentRoles ?? [Role.USER],
        dto.proposedRoles,
      );
    }

    throw new BadRequestException(`Invalid targetType '${dto.targetType}'. Must be 'role' or 'user'.`);
  }

  @Get("my-permissions")
  @ApiOperation({ summary: "Get current user's effective permissions and allowed actions" })
  @ApiResponse({ status: 200, description: "User permissions" })
  getMyPermissions(@Req() req: any) {
    const user = req.user;
    const rawRoles: string[] = user?.roles ?? (user?.role ? [user.role] : []);
    const userRoles = rawRoles.map((r: string) => normalizeRole(r));

    const permissions = new Set<string>();
    for (const role of userRoles) {
      for (const perm of getRolePermissions(role)) {
        permissions.add(perm);
      }
    }

    const allowedActions = getActionsForRole(
      userRoles.includes(Role.ADMIN) ? Role.ADMIN : userRoles[0] ?? Role.USER,
    ).map((e) => e.action);

    return {
      success: true,
      roles: userRoles,
      permissions: Array.from(permissions),
      allowedActions,
    };
  }
}

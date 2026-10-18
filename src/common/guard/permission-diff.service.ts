import { Injectable, BadRequestException } from "@nestjs/common";
import { Role, Permission, getRolePermissions, normalizeRole } from "./roles.enum";
import {
  PERMISSION_MATRIX,
  PermissionMatrixEntry,
  getActionsForRole,
} from "./permission-matrix";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface PermissionDiffReport {
  targetType: "role" | "user";
  targetId: string;
  currentPermissions: Permission[];
  proposedPermissions: Permission[];
  addedPermissions: Permission[];
  removedPermissions: Permission[];
  unchangedPermissions: Permission[];
  unlockedActions: string[];
  revokedActions: string[];
  riskAssessment: {
    riskLevel: RiskLevel;
    sensitiveActionsGained: string[];
    auditableActionsGained: string[];
    isPrivilegeEscalation: boolean;
    warnings: string[];
  };
  breakingChange: boolean;
  generatedAt: string;
}

export interface PolicyDiffReport {
  addedActions: string[];
  removedActions: string[];
  modifiedActions: Array<{
    action: string;
    addedRoles: Role[];
    removedRoles: Role[];
    addedPermissions: Permission[];
    removedPermissions: Permission[];
  }>;
  riskAssessment: {
    riskLevel: RiskLevel;
    warnings: string[];
  };
  generatedAt: string;
}

const CRITICAL_PERMISSIONS: Set<Permission> = new Set([
  Permission.USER_MANAGE,
  Permission.ROLE_ASSIGN,
  Permission.TRADE_EXECUTE,
  Permission.DR_EXECUTE,
  Permission.PAUSE_ACTIVATE,
  Permission.PAUSE_RESUME,
  Permission.RATE_LIMIT_MANAGE,
  Permission.SYSTEM_MAINTENANCE,
]);

@Injectable()
export class PermissionDiffService {
  /**
   * Generates a permission-diff report for a proposed change to a role's permissions.
   */
  generateRoleDiff(
    roleInput: string,
    proposedPermissions: Permission[],
  ): PermissionDiffReport {
    const role = normalizeRole(roleInput);
    const currentPermissions = getRolePermissions(role);

    return this.calculateDiff(
      "role",
      role,
      currentPermissions,
      proposedPermissions,
      role === Role.ADMIN,
    );
  }

  /**
   * Generates a permission-diff report for a user undergoing role changes.
   */
  generateUserRoleDiff(
    userId: string,
    currentRoles: string[],
    proposedRoles: string[],
  ): PermissionDiffReport {
    const normalizedCurrent = currentRoles.map((r) => normalizeRole(r));
    const normalizedProposed = proposedRoles.map((r) => normalizeRole(r));

    const currentPermsSet = new Set<Permission>();
    for (const r of normalizedCurrent) {
      for (const p of getRolePermissions(r)) {
        currentPermsSet.add(p);
      }
    }

    const proposedPermsSet = new Set<Permission>();
    for (const r of normalizedProposed) {
      for (const p of getRolePermissions(r)) {
        proposedPermsSet.add(p);
      }
    }

    const currentPermissions = Array.from(currentPermsSet);
    const proposedPermissions = Array.from(proposedPermsSet);

    const wasAdmin = normalizedCurrent.includes(Role.ADMIN);
    const isAdmin = normalizedProposed.includes(Role.ADMIN);

    return this.calculateDiff(
      "user",
      userId,
      currentPermissions,
      proposedPermissions,
      wasAdmin || isAdmin,
    );
  }

  /**
   * Compares two permission matrices (e.g. before deploying a policy update).
   */
  generatePolicyDiff(
    currentMatrix: PermissionMatrixEntry[],
    proposedMatrix: PermissionMatrixEntry[],
  ): PolicyDiffReport {
    const currentMap = new Map(currentMatrix.map((e) => [e.action, e]));
    const proposedMap = new Map(proposedMatrix.map((e) => [e.action, e]));

    const addedActions: string[] = [];
    const removedActions: string[] = [];
    const modifiedActions: PolicyDiffReport["modifiedActions"] = [];
    const warnings: string[] = [];

    for (const [action, proposedEntry] of proposedMap) {
      const currentEntry = currentMap.get(action);
      if (!currentEntry) {
        addedActions.push(action);
        if (proposedEntry.sensitive) {
          warnings.push(`New sensitive action '${action}' added to permission policy.`);
        }
      } else {
        const addedRoles = proposedEntry.allowedRoles.filter(
          (r) => !currentEntry.allowedRoles.includes(r),
        );
        const removedRoles = currentEntry.allowedRoles.filter(
          (r) => !proposedEntry.allowedRoles.includes(r),
        );
        const addedPermissions = proposedEntry.requiredPermissions.filter(
          (p) => !currentEntry.requiredPermissions.includes(p),
        );
        const removedPermissions = currentEntry.requiredPermissions.filter(
          (p) => !proposedEntry.requiredPermissions.includes(p),
        );

        if (
          addedRoles.length > 0 ||
          removedRoles.length > 0 ||
          addedPermissions.length > 0 ||
          removedPermissions.length > 0
        ) {
          modifiedActions.push({
            action,
            addedRoles,
            removedRoles,
            addedPermissions,
            removedPermissions,
          });

          if (addedRoles.includes(Role.USER) && currentEntry.sensitive) {
            warnings.push(
              `Sensitive action '${action}' was granted to the standard USER role.`,
            );
          }
        }
      }
    }

    for (const action of currentMap.keys()) {
      if (!proposedMap.has(action)) {
        removedActions.push(action);
        warnings.push(`Action '${action}' was completely removed from the policy.`);
      }
    }

    let riskLevel: RiskLevel = "LOW";
    if (warnings.length > 0) riskLevel = "MEDIUM";
    if (warnings.some((w) => w.includes("USER role") || w.includes("sensitive"))) {
      riskLevel = "HIGH";
    }

    return {
      addedActions,
      removedActions,
      modifiedActions,
      riskAssessment: {
        riskLevel,
        warnings,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  private calculateDiff(
    targetType: "role" | "user",
    targetId: string,
    currentPermissions: Permission[],
    proposedPermissions: Permission[],
    isAdminContext: boolean,
  ): PermissionDiffReport {
    const currentSet = new Set(currentPermissions);
    const proposedSet = new Set(proposedPermissions);

    const addedPermissions = proposedPermissions.filter((p) => !currentSet.has(p));
    const removedPermissions = currentPermissions.filter((p) => !proposedSet.has(p));
    const unchangedPermissions = currentPermissions.filter((p) => proposedSet.has(p));

    // Determine affected actions from PERMISSION_MATRIX
    const currentActions = this.resolveAllowedActions(currentPermissions, isAdminContext);
    const proposedActions = this.resolveAllowedActions(proposedPermissions, isAdminContext);

    const currentActionSet = new Set(currentActions);
    const proposedActionSet = new Set(proposedActions);

    const unlockedActions = proposedActions.filter((a) => !currentActionSet.has(a));
    const revokedActions = currentActions.filter((a) => !proposedActionSet.has(a));

    // Risk Assessment
    const sensitiveActionsGained: string[] = [];
    const auditableActionsGained: string[] = [];
    const warnings: string[] = [];

    const matrixMap = new Map(PERMISSION_MATRIX.map((e) => [e.action, e]));

    for (const action of unlockedActions) {
      const entry = matrixMap.get(action);
      if (entry?.sensitive) sensitiveActionsGained.push(action);
      if (entry?.auditRequired) auditableActionsGained.push(action);
    }

    const criticalPermsGained = addedPermissions.filter((p) =>
      CRITICAL_PERMISSIONS.has(p),
    );

    let isPrivilegeEscalation = false;
    let riskLevel: RiskLevel = "LOW";

    if (criticalPermsGained.length > 0 || sensitiveActionsGained.length > 0) {
      isPrivilegeEscalation = true;
      riskLevel = "HIGH";
      warnings.push(
        `Privilege escalation detected: Gained ${criticalPermsGained.length} critical permissions (${criticalPermsGained.join(", ")}) and ${sensitiveActionsGained.length} sensitive actions.`,
      );
    }

    if (sensitiveActionsGained.includes("user.manage") || sensitiveActionsGained.includes("role.assign")) {
      riskLevel = "CRITICAL";
      warnings.push("CRITICAL: Administrative identity/role management capability granted.");
    }

    if (removedPermissions.length > 0) {
      warnings.push(
        `Breaking change: ${removedPermissions.length} permissions will be revoked, locking ${revokedActions.length} actions.`,
      );
    }

    return {
      targetType,
      targetId,
      currentPermissions,
      proposedPermissions,
      addedPermissions,
      removedPermissions,
      unchangedPermissions,
      unlockedActions,
      revokedActions,
      riskAssessment: {
        riskLevel,
        sensitiveActionsGained,
        auditableActionsGained,
        isPrivilegeEscalation,
        warnings,
      },
      breakingChange: removedPermissions.length > 0 || revokedActions.length > 0,
      generatedAt: new Date().toISOString(),
    };
  }

  private resolveAllowedActions(
    permissions: Permission[],
    isAdmin: boolean,
  ): string[] {
    if (isAdmin) {
      return PERMISSION_MATRIX.map((e) => e.action);
    }

    const permSet = new Set(permissions);
    return PERMISSION_MATRIX.filter((entry) =>
      entry.requiredPermissions.every((p) => permSet.has(p)),
    ).map((e) => e.action);
  }
}

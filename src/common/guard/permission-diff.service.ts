import { Injectable, BadRequestException, ForbiddenException, Logger } from "@nestjs/common";
import { createHash } from "crypto";
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

export interface PolicyChangePreviewOptions {
  actor?: {
    id: string;
    roles: string[];
  };
  currentMatrix?: PermissionMatrixEntry[];
  proposedMatrix: PermissionMatrixEntry[];
}

export interface PolicyChangePreviewResult {
  dryRun: boolean;
  canProceed: boolean;
  requiresAdminConfirmation: boolean;
  addedActions: string[];
  removedActions: string[];
  modifiedActions: Array<{
    action: string;
    addedRoles: Role[];
    removedRoles: Role[];
    addedPermissions: Permission[];
    removedPermissions: Permission[];
  }>;
  affectedRoles: Role[];
  unlockedActionsPerRole: Record<string, string[]>;
  revokedActionsPerRole: Record<string, string[]>;
  riskAssessment: {
    riskLevel: RiskLevel;
    sensitiveActionsGained: string[];
    isPrivilegeEscalation: boolean;
    warnings: string[];
  };
  breakingChange: boolean;
  rollbackPlan: {
    reversible: boolean;
    snapshotStateDigest: string;
    previousEntriesCount: number;
    restorationInstructions: string;
    snapshotMatrix: PermissionMatrixEntry[];
  };
  previewToken: string;
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

    const isCurrentAdmin = role === Role.ADMIN;
    return this.calculateDiff(
      "role",
      role,
      currentPermissions,
      proposedPermissions,
      isCurrentAdmin,
      isCurrentAdmin,
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
      wasAdmin,
      isAdmin,
    );
  }

  /**
   * Preview permission diff and security impact before committing policy changes.
   * Enforces RBAC authorization, input schema validation, privilege escalation detection,
   * breaking change warnings, and produces a rollback plan with deterministic preview token.
   */
  previewPolicyChanges(
    options: PolicyChangePreviewOptions,
  ): PolicyChangePreviewResult {
    // 1. Authorization check: ADMIN or MAINTAINER required
    if (options.actor) {
      const roles = (options.actor.roles ?? []).map((r) => normalizeRole(r));
      const isAuthorized = roles.includes(Role.ADMIN) || roles.includes(Role.MAINTAINER);
      if (!isAuthorized) {
        throw new ForbiddenException(
          "Insufficient permissions: previewing policy changes requires ADMIN or MAINTAINER role",
        );
      }
    }

    // 2. Input validation: fail-fast on malformed policy
    const proposed = options.proposedMatrix;
    if (!proposed || !Array.isArray(proposed)) {
      throw new BadRequestException("proposedMatrix must be an array of PermissionMatrixEntry");
    }

    const seenActions = new Set<string>();
    for (const entry of proposed) {
      if (!entry || typeof entry.action !== "string" || entry.action.trim() === "") {
        throw new BadRequestException("Each proposed policy entry must specify a non-empty action identifier");
      }
      if (seenActions.has(entry.action)) {
        throw new BadRequestException(`Duplicate action '${entry.action}' in proposed policy matrix`);
      }
      seenActions.add(entry.action);

      if (!Array.isArray(entry.allowedRoles) || !Array.isArray(entry.requiredPermissions)) {
        throw new BadRequestException(`Action '${entry.action}' must define allowedRoles and requiredPermissions arrays`);
      }
    }

    const current = options.currentMatrix ?? PERMISSION_MATRIX;
    const baseDiff = this.generatePolicyDiff(current, proposed);

    // 3. Evaluate per-role impact
    const allRoles = Object.values(Role);
    const unlockedActionsPerRole: Record<string, string[]> = {};
    const revokedActionsPerRole: Record<string, string[]> = {};
    const affectedRolesSet = new Set<Role>();

    for (const role of allRoles) {
      const currentRoleActions = current
        .filter((e) => e.allowedRoles.includes(role))
        .map((e) => e.action);
      const proposedRoleActions = proposed
        .filter((e) => e.allowedRoles.includes(role))
        .map((e) => e.action);

      const curSet = new Set(currentRoleActions);
      const propSet = new Set(proposedRoleActions);

      const unlocked = proposedRoleActions.filter((a) => !curSet.has(a));
      const revoked = currentRoleActions.filter((a) => !propSet.has(a));

      if (unlocked.length > 0) {
        unlockedActionsPerRole[role] = unlocked;
        affectedRolesSet.add(role);
      }
      if (revoked.length > 0) {
        revokedActionsPerRole[role] = revoked;
        affectedRolesSet.add(role);
      }
    }

    // 4. Sensitive action analysis
    const sensitiveGained: string[] = [];
    const matrixMap = new Map(proposed.map((e) => [e.action, e]));
    for (const [action, entry] of matrixMap) {
      if (entry.sensitive && (baseDiff.addedActions.includes(action) || entry.allowedRoles.includes(Role.USER))) {
        sensitiveGained.push(action);
      }
    }

    const isPrivilegeEscalation =
      sensitiveGained.length > 0 ||
      baseDiff.riskAssessment.riskLevel === "HIGH" ||
      baseDiff.riskAssessment.riskLevel === "CRITICAL";

    const breakingChange =
      baseDiff.removedActions.length > 0 ||
      Object.keys(revokedActionsPerRole).length > 0;

    const warnings = [...baseDiff.riskAssessment.warnings];
    if (breakingChange) {
      warnings.push(`Breaking change: actions revoked across ${Object.keys(revokedActionsPerRole).length} role(s)`);
    }

    // 5. Deterministic snapshot digest & preview token
    const currentJson = JSON.stringify(current);
    const proposedJson = JSON.stringify(proposed);
    const snapshotStateDigest = createHash("sha256").update(currentJson).digest("hex");
    const previewToken = createHash("sha256").update(`${currentJson}:${proposedJson}`).digest("hex");

    return {
      dryRun: true,
      canProceed: true,
      requiresAdminConfirmation: isPrivilegeEscalation || breakingChange,
      addedActions: baseDiff.addedActions,
      removedActions: baseDiff.removedActions,
      modifiedActions: baseDiff.modifiedActions,
      affectedRoles: Array.from(affectedRolesSet),
      unlockedActionsPerRole,
      revokedActionsPerRole,
      riskAssessment: {
        riskLevel: baseDiff.riskAssessment.riskLevel,
        sensitiveActionsGained: sensitiveGained,
        isPrivilegeEscalation,
        warnings,
      },
      breakingChange,
      rollbackPlan: {
        reversible: true,
        snapshotStateDigest,
        previousEntriesCount: current.length,
        restorationInstructions: `Restore ${current.length} policy matrix entries using snapshotStateDigest ${snapshotStateDigest.substring(0, 12)}`,
        snapshotMatrix: current,
      },
      previewToken,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Preview policy changes with transient retry support when fetching policy from external store.
   */
  async previewPolicyChangesWithRetry(
    fetcher: () => Promise<PermissionMatrixEntry[]>,
    proposedMatrix: PermissionMatrixEntry[],
    actor?: { id: string; roles: string[] },
    maxRetries = 3,
  ): Promise<PolicyChangePreviewResult> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const currentMatrix = await fetcher();
        return this.previewPolicyChanges({
          actor,
          currentMatrix,
          proposedMatrix,
        });
      } catch (err: any) {
        lastError = err;
        if (err instanceof ForbiddenException || err instanceof BadRequestException) {
          throw err;
        }
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 20;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError ?? new Error("Failed to retrieve current policy after retries");
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
    isCurrentAdmin: boolean,
    isProposedAdmin: boolean = isCurrentAdmin,
  ): PermissionDiffReport {
    const currentSet = new Set(currentPermissions);
    const proposedSet = new Set(proposedPermissions);

    const addedPermissions = proposedPermissions.filter((p) => !currentSet.has(p));
    const removedPermissions = currentPermissions.filter((p) => !proposedSet.has(p));
    const unchangedPermissions = currentPermissions.filter((p) => proposedSet.has(p));

    // Determine affected actions from PERMISSION_MATRIX
    const currentActions = this.resolveAllowedActions(currentPermissions, isCurrentAdmin);
    const proposedActions = this.resolveAllowedActions(proposedPermissions, isProposedAdmin);

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

    if (
      criticalPermsGained.length > 0 ||
      sensitiveActionsGained.length > 0 ||
      (!isCurrentAdmin && isProposedAdmin)
    ) {
      isPrivilegeEscalation = true;
      riskLevel = "HIGH";
      warnings.push(
        `Privilege escalation detected: Gained ${criticalPermsGained.length} critical permissions (${criticalPermsGained.join(", ")}) and ${sensitiveActionsGained.length} sensitive actions.`,
      );
    }

    if (
      sensitiveActionsGained.includes("user.manage") ||
      sensitiveActionsGained.includes("role.assign") ||
      (!isCurrentAdmin && isProposedAdmin)
    ) {
      riskLevel = "CRITICAL";
      warnings.push("CRITICAL: Administrative identity/role management capability granted.");
    }

    const isDemotedFromAdmin = isCurrentAdmin && !isProposedAdmin;
    if (removedPermissions.length > 0 || revokedActions.length > 0 || isDemotedFromAdmin) {
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
      breakingChange:
        removedPermissions.length > 0 || revokedActions.length > 0 || isDemotedFromAdmin,
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

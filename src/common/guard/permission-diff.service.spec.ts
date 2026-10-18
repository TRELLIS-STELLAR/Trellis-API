import { PermissionDiffService } from "./permission-diff.service";
import { Role, Permission, getRolePermissions } from "./roles.enum";
import { PERMISSION_MATRIX, PermissionMatrixEntry } from "./permission-matrix";

describe("PermissionDiffService", () => {
  let service: PermissionDiffService;

  beforeEach(() => {
    service = new PermissionDiffService();
  });

  describe("Role Permission Diff", () => {
    it("should compute accurate diff when adding new permissions to a role", () => {
      const currentPerms = getRolePermissions(Role.USER);
      const proposedPerms = [
        ...currentPerms,
        Permission.PORTFOLIO_OPTIMIZE,
        Permission.TRADE_EXECUTE,
      ];

      const report = service.generateRoleDiff(Role.USER, proposedPerms);

      expect(report.targetType).toBe("role");
      expect(report.targetId).toBe(Role.USER);
      expect(report.addedPermissions).toEqual([
        Permission.PORTFOLIO_OPTIMIZE,
        Permission.TRADE_EXECUTE,
      ]);
      expect(report.removedPermissions).toHaveLength(0);
      expect(report.unchangedPermissions).toEqual(currentPerms);
      expect(report.unlockedActions).toContain("trade.execute");
      expect(report.breakingChange).toBe(false);

      // Check risk assessment
      expect(report.riskAssessment.isPrivilegeEscalation).toBe(true);
      expect(report.riskAssessment.riskLevel).toBe("HIGH");
      expect(report.riskAssessment.sensitiveActionsGained).toContain("trade.execute");
    });

    it("should detect critical privilege escalation when admin permissions are added", () => {
      const currentPerms = getRolePermissions(Role.OPERATOR);
      const proposedPerms = [...currentPerms, Permission.USER_MANAGE, Permission.ROLE_ASSIGN];

      const report = service.generateRoleDiff(Role.OPERATOR, proposedPerms);

      expect(report.riskAssessment.riskLevel).toBe("CRITICAL");
      expect(report.riskAssessment.sensitiveActionsGained).toEqual(
        expect.arrayContaining(["user.manage", "role.assign"]),
      );
      expect(report.riskAssessment.warnings.some((w) => w.includes("CRITICAL"))).toBe(true);
    });

    it("should detect breaking changes when permissions are revoked", () => {
      const currentPerms = getRolePermissions(Role.MAINTAINER);
      // Revoke system maintenance
      const proposedPerms = currentPerms.filter((p) => p !== Permission.SYSTEM_MAINTENANCE);

      const report = service.generateRoleDiff(Role.MAINTAINER, proposedPerms);

      expect(report.removedPermissions).toContain(Permission.SYSTEM_MAINTENANCE);
      expect(report.breakingChange).toBe(true);
      expect(report.riskAssessment.warnings.some((w) => w.includes("Breaking change"))).toBe(true);
    });

    it("should report zero additions and removals for identical permission sets", () => {
      const currentPerms = getRolePermissions(Role.USER);
      const report = service.generateRoleDiff(Role.USER, [...currentPerms]);

      expect(report.addedPermissions).toHaveLength(0);
      expect(report.removedPermissions).toHaveLength(0);
      expect(report.unlockedActions).toHaveLength(0);
      expect(report.revokedActions).toHaveLength(0);
      expect(report.breakingChange).toBe(false);
      expect(report.riskAssessment.riskLevel).toBe("LOW");
    });
  });

  describe("User Role Diff", () => {
    it("should calculate user permission diff when promoting USER to OPERATOR", () => {
      const report = service.generateUserRoleDiff(
        "usr-12345",
        [Role.USER],
        [Role.USER, Role.OPERATOR],
      );

      expect(report.targetType).toBe("user");
      expect(report.targetId).toBe("usr-12345");
      expect(report.addedPermissions).toContain(Permission.TRADE_EXECUTE);
      expect(report.unlockedActions).toContain("trade.execute");
    });

    it("should flag breaking change when demoting from ADMIN to USER", () => {
      const report = service.generateUserRoleDiff(
        "usr-admin",
        [Role.ADMIN],
        [Role.USER],
      );

      expect(report.breakingChange).toBe(true);
      expect(report.removedPermissions.length).toBeGreaterThan(0);
      expect(report.revokedActions.length).toBeGreaterThan(0);
    });
  });

  describe("Policy Matrix Diff", () => {
    it("should detect added and removed actions in matrix policies", () => {
      const currentMatrix: PermissionMatrixEntry[] = [
        {
          action: "trade.read",
          description: "Read trades",
          requiredPermissions: [Permission.TRADE_READ],
          allowedRoles: [Role.USER],
          scope: "own",
          sensitive: false,
          auditRequired: false,
        },
      ];

      const proposedMatrix: PermissionMatrixEntry[] = [
        {
          action: "trade.read",
          description: "Read trades",
          requiredPermissions: [Permission.TRADE_READ],
          allowedRoles: [Role.USER, Role.OPERATOR],
          scope: "own",
          sensitive: false,
          auditRequired: false,
        },
        {
          action: "admin.wipe",
          description: "Wipe data",
          requiredPermissions: [Permission.SYSTEM_MAINTENANCE],
          allowedRoles: [Role.ADMIN],
          scope: "global",
          sensitive: true,
          auditRequired: true,
        },
      ];

      const report = service.generatePolicyDiff(currentMatrix, proposedMatrix);

      expect(report.addedActions).toEqual(["admin.wipe"]);
      expect(report.modifiedActions).toHaveLength(1);
      expect(report.modifiedActions[0].action).toBe("trade.read");
      expect(report.modifiedActions[0].addedRoles).toEqual([Role.OPERATOR]);
      expect(report.riskAssessment.warnings.some((w) => w.includes("New sensitive action"))).toBe(true);
    });
  });
});

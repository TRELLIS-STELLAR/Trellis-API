import { PermissionDiffService } from "./permission-diff.service";
import { Role, Permission, getRolePermissions } from "./roles.enum";
import { PERMISSION_MATRIX, PermissionMatrixEntry } from "./permission-matrix";

describe("PermissionDiffService", () => {
  let service: PermissionDiffService;

  beforeEach(() => {
    service = new PermissionDiffService();
  });

  describe("Issue #571 permission-diff preview contract", () => {
    const matrix: PermissionMatrixEntry[] = [
      {
        action: "orders.create",
        description: "Create an order",
        requiredPermissions: [Permission.TRADE_EXECUTE],
        allowedRoles: [Role.OPERATOR],
        scope: "own",
        sensitive: false,
        auditRequired: false,
      },
    ];

    it("returns a dry-run diff without mutating the active matrix", () => {
      const result = service.previewPolicyChanges({
        actor: { id: "maintainer-571", roles: ["MAINTAINER"] },
        currentMatrix: matrix,
        proposedMatrix: [...matrix, {
          action: "audit.export",
          description: "Export audit records",
          requiredPermissions: [Permission.AUDIT_READ],
          allowedRoles: [Role.MAINTAINER],
          scope: "global",
          sensitive: true,
          auditRequired: true,
        }],
      });

      expect(result.dryRun).toBe(true);
      expect(result.addedActions).toEqual(["audit.export"]);
      expect(result.rollbackPlan.snapshotMatrix).toEqual(matrix);
      expect(matrix).toHaveLength(1);
    });

    it("fails closed for an unauthorized preview caller", () => {
      expect(() => service.previewPolicyChanges({
        actor: { id: "user-571", roles: ["USER"] },
        currentMatrix: matrix,
        proposedMatrix: matrix,
      })).toThrow("requires ADMIN or MAINTAINER role");
    });

    it("rejects malformed and duplicate policy actions before diffing", () => {
      expect(() => service.previewPolicyChanges({
        actor: { id: "admin-571", roles: ["ADMIN"] },
        proposedMatrix: [{ ...matrix[0], action: "" }],
      })).toThrow("non-empty action identifier");
      expect(() => service.previewPolicyChanges({
        actor: { id: "admin-571", roles: ["ADMIN"] },
        proposedMatrix: [matrix[0], matrix[0]],
      })).toThrow("Duplicate action");
    });
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

  describe("Permission-Diff Preview Before Policy Changes (#482)", () => {
    const baseCurrentMatrix: PermissionMatrixEntry[] = [
      {
        action: "orders.create",
        description: "Submit trade order",
        requiredPermissions: [Permission.TRADE_EXECUTE],
        allowedRoles: [Role.USER, Role.OPERATOR],
        scope: "own",
        sensitive: false,
        auditRequired: false,
      },
      {
        action: "system.maintenance",
        description: "Execute system maintenance",
        requiredPermissions: [Permission.SYSTEM_MAINTENANCE],
        allowedRoles: [Role.ADMIN],
        scope: "global",
        sensitive: true,
        auditRequired: true,
      },
    ];

    it("Normal Path: previews added, removed, modified actions and rollback plan", () => {
      const proposedMatrix: PermissionMatrixEntry[] = [
        {
          action: "orders.create",
          description: "Submit trade order",
          requiredPermissions: [Permission.TRADE_EXECUTE],
          allowedRoles: [Role.USER], // removed OPERATOR
          scope: "own",
          sensitive: false,
          auditRequired: false,
        },
        {
          action: "audit.export",
          description: "Export audit logs",
          requiredPermissions: [Permission.AUDIT_READ],
          allowedRoles: [Role.MAINTAINER, Role.ADMIN],
          scope: "global",
          sensitive: true,
          auditRequired: true,
        },
      ]; // removed system.maintenance

      const result = service.previewPolicyChanges({
        actor: { id: "admin-1", roles: ["ADMIN"] },
        currentMatrix: baseCurrentMatrix,
        proposedMatrix,
      });

      expect(result.dryRun).toBe(true);
      expect(result.canProceed).toBe(true);
      expect(result.addedActions).toEqual(["audit.export"]);
      expect(result.removedActions).toEqual(["system.maintenance"]);
      expect(result.breakingChange).toBe(true);
      expect(result.requiresAdminConfirmation).toBe(true);
      expect(result.affectedRoles).toContain(Role.OPERATOR);
      expect(result.revokedActionsPerRole[Role.OPERATOR]).toContain("orders.create");
      expect(result.previewToken).toBeDefined();
      expect(result.rollbackPlan.reversible).toBe(true);
      expect(result.rollbackPlan.snapshotMatrix).toEqual(baseCurrentMatrix);
    });

    it("Failure Path: rejects malformed policy entries and duplicate actions", () => {
      expect(() =>
        service.previewPolicyChanges({
          actor: { id: "admin-1", roles: ["ADMIN"] },
          proposedMatrix: null as any,
        }),
      ).toThrow("proposedMatrix must be an array");

      expect(() =>
        service.previewPolicyChanges({
          actor: { id: "admin-1", roles: ["ADMIN"] },
          proposedMatrix: [
            {
              action: "",
              description: "bad",
              requiredPermissions: [],
              allowedRoles: [],
              scope: "own",
            } as any,
          ],
        }),
      ).toThrow("must specify a non-empty action identifier");

      expect(() =>
        service.previewPolicyChanges({
          actor: { id: "admin-1", roles: ["ADMIN"] },
          proposedMatrix: [
            {
              action: "dup.action",
              description: "first",
              requiredPermissions: [],
              allowedRoles: [],
              scope: "own",
            } as any,
            {
              action: "dup.action",
              description: "second",
              requiredPermissions: [],
              allowedRoles: [],
              scope: "own",
            } as any,
          ],
        }),
      ).toThrow("Duplicate action 'dup.action'");
    });

    it("Authorization Path: permits ADMIN and MAINTAINER, rejects unauthorized roles", () => {
      const validProposed = [...baseCurrentMatrix];

      // Admin authorized
      expect(() =>
        service.previewPolicyChanges({
          actor: { id: "admin-1", roles: ["ADMIN"] },
          currentMatrix: baseCurrentMatrix,
          proposedMatrix: validProposed,
        }),
      ).not.toThrow();

      // Maintainer authorized
      expect(() =>
        service.previewPolicyChanges({
          actor: { id: "maint-1", roles: ["MAINTAINER"] },
          currentMatrix: baseCurrentMatrix,
          proposedMatrix: validProposed,
        }),
      ).not.toThrow();

      // Standard user rejected
      expect(() =>
        service.previewPolicyChanges({
          actor: { id: "user-1", roles: ["USER"] },
          currentMatrix: baseCurrentMatrix,
          proposedMatrix: validProposed,
        }),
      ).toThrow("requires ADMIN or MAINTAINER role");
    });

    it("Retry Path: retries transient policy retrieval errors and succeeds", async () => {
      let attempts = 0;
      const transientFetcher = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Transient database read failure");
        }
        return baseCurrentMatrix;
      };

      const result = await service.previewPolicyChangesWithRetry(
        transientFetcher,
        baseCurrentMatrix,
        { id: "admin-1", roles: ["ADMIN"] },
        3,
      );

      expect(attempts).toBe(3);
      expect(result.dryRun).toBe(true);
      expect(result.canProceed).toBe(true);
    });
  });
});

import { Role, Permission, getUiCapabilities } from "./roles.enum";
import {
  UI_ACTION_RULES,
  isUiActionAllowed,
  evaluateUiPolicies,
} from "./rbac-ui-policy";

describe("RbacUiPolicy", () => {
  describe("UI Action Rules Registry", () => {
    it("defines rules with required permissions and descriptions", () => {
      expect(UI_ACTION_RULES.TRADE_SUBMIT.requiredPermission).toBe(
        Permission.TRADE_EXECUTE,
      );
      expect(UI_ACTION_RULES.PORTFOLIO_OPTIMIZE.requiredPermission).toBe(
        Permission.PORTFOLIO_OPTIMIZE,
      );
      expect(UI_ACTION_RULES.USER_ROLE_ASSIGN.requiredPermission).toBe(
        Permission.ROLE_ASSIGN,
      );
      expect(UI_ACTION_RULES.RECONCILIATION_EXECUTE.requiredPermission).toBe(
        Permission.RECONCILIATION_RUN,
      );
    });
  });

  describe("isUiActionAllowed", () => {
    it("allows standard USER to read portfolio and view public features", () => {
      const allowed = isUiActionAllowed(Role.USER, "PORTFOLIO_OPTIMIZE");
      expect(allowed).toBe(false);
    });

    it("allows OPERATOR to trade and optimize portfolios", () => {
      expect(isUiActionAllowed(Role.OPERATOR, "TRADE_SUBMIT")).toBe(true);
      expect(isUiActionAllowed(Role.OPERATOR, "PORTFOLIO_OPTIMIZE")).toBe(true);
      expect(isUiActionAllowed(Role.OPERATOR, "USER_ROLE_ASSIGN")).toBe(false);
    });

    it("allows MAINTAINER to manage modules and run reconciliation", () => {
      expect(isUiActionAllowed(Role.MAINTAINER, "MODULE_MANAGE")).toBe(true);
      expect(isUiActionAllowed(Role.MAINTAINER, "RECONCILIATION_EXECUTE")).toBe(
        true,
      );
      expect(isUiActionAllowed(Role.MAINTAINER, "USER_ROLE_ASSIGN")).toBe(
        false,
      );
    });

    it("allows ADMIN to execute all UI actions", () => {
      for (const actionKey of Object.keys(UI_ACTION_RULES)) {
        expect(isUiActionAllowed(Role.ADMIN, actionKey as any)).toBe(true);
      }
    });

    it("evaluates specialised roles correctly", () => {
      expect(isUiActionAllowed(Role.KYC_OPERATOR, "KYC_REVIEW")).toBe(true);
      expect(isUiActionAllowed(Role.KYC_OPERATOR, "TRADE_SUBMIT")).toBe(false);

      expect(isUiActionAllowed(Role.GOVERNANCE_OPERATOR, "GOVERNANCE_VOTE")).toBe(
        true,
      );
      expect(isUiActionAllowed(Role.GOVERNANCE_OPERATOR, "MODULE_MANAGE")).toBe(
        false,
      );

      expect(isUiActionAllowed(Role.SERVICE_ACTOR, "ORACLE_SUBMIT")).toBe(true);
      expect(isUiActionAllowed(Role.SERVICE_ACTOR, "PORTFOLIO_OPTIMIZE")).toBe(
        false,
      );
    });
  });

  describe("evaluateUiPolicies", () => {
    it("generates UI capabilities and boolean matrix for USER", () => {
      const { capabilities, allowedActions } = evaluateUiPolicies(Role.USER);
      expect(capabilities.canTrade).toBe(false);
      expect(capabilities.canOptimize).toBe(false);
      expect(capabilities.canManageUsers).toBe(false);
      expect(allowedActions.PORTFOLIO_OPTIMIZE).toBe(false);
    });

    it("generates UI capabilities and boolean matrix for ADMIN", () => {
      const { capabilities, allowedActions } = evaluateUiPolicies(Role.ADMIN);
      expect(capabilities.canTrade).toBe(true);
      expect(capabilities.canOptimize).toBe(true);
      expect(capabilities.canManageUsers).toBe(true);
      expect(capabilities.canManageModules).toBe(true);
      expect(capabilities.canRunReconciliation).toBe(true);
      expect(allowedActions.USER_ROLE_ASSIGN).toBe(true);
    });
  });
});

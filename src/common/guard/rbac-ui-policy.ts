import { Role, Permission, UiCapabilities, getUiCapabilities, hasPermission } from "./roles.enum";

/**
 * UI Action Descriptor for client-side permission policy evaluation.
 */
export interface UiActionRule {
  action: string;
  requiredPermission: Permission;
  requiredRoles?: Role[];
  description: string;
}

/**
 * Registry of UI actions mapped to backend required permissions.
 *
 * Frontends consume this mapping along with the user's role/permissions
 * (returned by `/auth/me/capabilities`) to:
 *   1. Hide unauthorized navigation elements.
 *   2. Disable unauthorized buttons/forms.
 *   3. Display contextual tooltips explaining why an action is restricted.
 *
 * IMPORTANT SECURITY INVARIANT:
 * UI gating is purely for user experience and presentation.
 * Server-side route handlers enforce @Roles and @RequirePermissions
 * independently. Even if a user bypasses the UI, the backend will return 401/403.
 */
export const UI_ACTION_RULES: Record<string, UiActionRule> = {
  TRADE_SUBMIT: {
    action: "TRADE_SUBMIT",
    requiredPermission: Permission.TRADE_EXECUTE,
    description: "Submit live DeFi or Stellar trade order",
  },
  PORTFOLIO_OPTIMIZE: {
    action: "PORTFOLIO_OPTIMIZE",
    requiredPermission: Permission.PORTFOLIO_OPTIMIZE,
    description: "Run portfolio rebalancing and algorithmic optimization",
  },
  USER_ROLE_ASSIGN: {
    action: "USER_ROLE_ASSIGN",
    requiredPermission: Permission.ROLE_ASSIGN,
    requiredRoles: [Role.ADMIN],
    description: "Assign or modify user roles in administrative console",
  },
  RECONCILIATION_EXECUTE: {
    action: "RECONCILIATION_EXECUTE",
    requiredPermission: Permission.RECONCILIATION_RUN,
    requiredRoles: [Role.ADMIN, Role.MAINTAINER],
    description: "Trigger manual or automated Stellar payment reconciliation",
  },
  MODULE_MANAGE: {
    action: "MODULE_MANAGE",
    requiredPermission: Permission.MODULE_MANAGE,
    requiredRoles: [Role.ADMIN, Role.MAINTAINER],
    description: "Install, upgrade, or toggle pluggable module packages",
  },
  METRICS_VIEW: {
    action: "METRICS_VIEW",
    requiredPermission: Permission.METRICS_READ,
    description: "Access operational telemetry and monitoring dashboards",
  },
  KYC_REVIEW: {
    action: "KYC_REVIEW",
    requiredPermission: Permission.KYC_REVIEW,
    requiredRoles: [Role.KYC_OPERATOR, Role.ADMIN],
    description: "Review and approve/reject user KYC verification submissions",
  },
  GOVERNANCE_VOTE: {
    action: "GOVERNANCE_VOTE",
    requiredPermission: Permission.GOVERNANCE_VOTE,
    requiredRoles: [Role.GOVERNANCE_OPERATOR, Role.ADMIN],
    description: "Cast vote or sign governance proposal",
  },
  ORACLE_SUBMIT: {
    action: "ORACLE_SUBMIT",
    requiredPermission: Permission.ORACLE_SUBMIT,
    requiredRoles: [Role.SERVICE_ACTOR, Role.ADMIN],
    description: "Publish signed oracle price feed payloads",
  },
};

/**
 * Evaluates whether a UI action is allowed for a user role or set of roles.
 */
export function isUiActionAllowed(
  roleOrRoles: Role | Role[],
  actionKey: keyof typeof UI_ACTION_RULES,
): boolean {
  const rule = UI_ACTION_RULES[actionKey];
  if (!rule) return false;
  return hasPermission(roleOrRoles, rule.requiredPermission);
}

/**
 * Returns a summary of UI visibility and enablement states for a user.
 */
export function evaluateUiPolicies(
  roleOrRoles: Role | Role[],
): {
  capabilities: UiCapabilities;
  allowedActions: Record<string, boolean>;
} {
  const capabilities = getUiCapabilities(roleOrRoles);
  const allowedActions: Record<string, boolean> = {};

  for (const [key, rule] of Object.entries(UI_ACTION_RULES)) {
    allowedActions[key] = hasPermission(roleOrRoles, rule.requiredPermission);
  }

  return { capabilities, allowedActions };
}

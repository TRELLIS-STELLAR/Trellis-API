import { SetMetadata } from "@nestjs/common";
import { Permission } from "./roles.enum";

export const PERMISSIONS_KEY = "permissions";

/**
 * Decorator to assign required granular permissions to a route handler or controller.
 *
 * @example
 * @RequirePermissions(Permission.PAYMENT_PROCESS)
 * @Post('process')
 * processPayment() { ... }
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Alias for @RequirePermissions()
 */
export const Permissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

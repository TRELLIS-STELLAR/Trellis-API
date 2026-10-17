import { AppController } from "../app.controller";
import { ROLES_KEY } from "../common/guard/roles.decorator";
import { Role, hasRole } from "../common/guard/roles.enum";

describe("storage compatibility endpoint authorization", () => {
  it("requires operator role and preserves the standard role hierarchy", () => {
    const handler = AppController.prototype.getStorageMigrationCompatibility;
    const requiredRoles = Reflect.getMetadata(ROLES_KEY, handler) as Role[];

    expect(requiredRoles).toEqual([Role.OPERATOR]);
    expect(hasRole(Role.USER, Role.OPERATOR)).toBe(false);
    expect(hasRole(Role.OPERATOR, Role.OPERATOR)).toBe(true);
    expect(hasRole(Role.MAINTAINER, Role.OPERATOR)).toBe(true);
    expect(hasRole(Role.ADMIN, Role.OPERATOR)).toBe(true);
  });
});

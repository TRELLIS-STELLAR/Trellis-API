# Role-Based Access Control (RBAC)

This service enforces role-based access control on every route through a global
`RolesGuard`. Roles are carried in the JWT and checked against the roles a route
declares with the `@Roles(...)` decorator.

## Roles

The canonical role set lives in [`src/common/guard/roles.enum.ts`](../src/common/guard/roles.enum.ts).
All role values are **UPPERCASE** strings:

| Role                  | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `USER`                | Default, least-privileged role. Baseline access.               |
| `OPERATOR`            | Elevated operational access (portfolio optimization, trade).   |
| `MAINTAINER`          | Platform maintainer access (modules, metrics, reconciliation). |
| `ADMIN`               | Full administrative access. Supersedes every other role.       |
| `GOVERNANCE_OPERATOR` | Specialised governance role. Exact-match only (no hierarchy).  |
| `KYC_OPERATOR`        | Specialised KYC/compliance role. Exact-match only.             |
| `SERVICE_ACTOR`       | Automated service principal (oracle submitter, daemon tasks).  |

### Hierarchy

`USER → OPERATOR → MAINTAINER → ADMIN` is a linear hierarchy: a higher role satisfies any
requirement for a lower one. `ADMIN` supersedes everything.

`GOVERNANCE_OPERATOR`, `KYC_OPERATOR`, and `SERVICE_ACTOR` sit **outside** the linear hierarchy —
they require an exact match and do not inherit from or grant each other. Only
`ADMIN` supersedes them. See `hasRole()` in the enum file for the exact logic.

### Granular Permissions

The service defines a granular `Permission` enum covering domain operations:
- **User & Security**: `user:read`, `user:write`, `user:manage`, `role:assign`
- **Portfolio & Trading**: `portfolio:read`, `portfolio:write`, `portfolio:optimize`, `trade:read`, `trade:execute`
- **Payments & Reconciliation**: `payment:create`, `payment:process`, `payment:refund`, `reconciliation:view`, `reconciliation:run`
- **Oracle & Plugins**: `oracle:read`, `oracle:submit`, `oracle:verify`, `module:read`, `module:manage`
- **Monitoring & System**: `metrics:read`, `system:maintenance`, `alerts:manage`, `rate_limit:manage`
- **Specialised**: `kyc:review`, `governance:vote`, `service:sync`

Permissions are mapped to canonical roles via `ROLE_PERMISSIONS` and enforced via `PermissionsGuard` and the `@RequirePermissions(...)` decorator.

### UI Boundaries & Capabilities

Frontends consume the user's capabilities via `GET /auth/me/capabilities` or `GET /admin/roles/matrix` to dynamically show, hide, or disable UI elements based on:
```ts
const { capabilities, allowedActions } = evaluateUiPolicies(currentUserRole);
```
**Security Invariant**: UI element gating is strictly a presentation convenience. All mutation endpoints and privileged operations are guarded on the server by `RolesGuard` and `PermissionsGuard`. Bypassing client-side UI restrictions directly triggers a `401 Unauthorized` or `403 Forbidden` response.


### Conflicting roles

`ADMIN` and `KYC_OPERATOR` are treated as mutually exclusive for separation of
duties: the account that administers the platform must not also sign off on KYC
reviews. `UserService.assignRole` rejects an assignment that would create the
conflicting pair with a `400 Bad Request`. Conflicting pairs are defined in
`CONFLICTING_ROLE_PAIRS` (`user.service.ts`).

## Enforcing roles on a route

Decorate the handler (or controller) with `@Roles(...)` and ensure the request
is authenticated. `RolesGuard` is registered globally in `AppModule`, so you do
not need to add it per-route — but the route must run behind an auth guard that
populates `request.user` (e.g. the global `StrategyAuthGuard`, or an explicit
`@UseGuards(JwtAuthGuard)`).

```ts
import { Roles } from "src/common/guard/roles.decorator";
import { Role } from "src/common/guard/roles.enum";

@Roles(Role.ADMIN)
@Get("admin/dashboard")
getAdminDashboard() { ... }
```

- A route with **no** `@Roles` decorator is not role-restricted.
- A route with `@Roles(Role.ADMIN)` returns **403** for any non-admin principal.
- A missing/unauthenticated principal returns **401**.

`@RequireRole(...)` is an alias of `@Roles(...)` kept for readability.

## How token claims map to roles

Roles are persisted as a single `role` column on the `users` table and signed
into the JWT `role` claim at login/registration. On each request:

1. The auth strategy validates the JWT and puts the principal on `request.user`.
2. `RolesGuard` reads `user.roles` (array) or `user.role` (single) and coerces
   each value to a canonical `Role` via `normalizeRole()`.
3. The normalized roles are compared against the route's required roles using
   the hierarchy rules above.

### Backwards compatibility

`normalizeRole()` is the single point of backwards compatibility:

- Legacy **lowercase** claims minted before canonicalisation (e.g. `"admin"`,
  `"kyc_operator"`) are accepted and mapped to their UPPERCASE canonical form.
- **Unknown, empty, or missing** role claims map to `USER` — the least
  privileged role — so tokens issued before roles existed default to read-only
  access rather than being rejected or over-privileged.

The same coercion is applied when reading the `role` column off the `User`
entity (via a TypeORM column transformer), so existing lowercase database rows
continue to work without a data migration.

## Admin role-management endpoints

Exposed by [`AdminRoleController`](../src/core/user/admin-role.controller.ts)
under `/admin`. Every route requires an authenticated `ADMIN` whose session is
2FA-verified (`JwtAuthGuard` + `RolesGuard` + `AdminTwoFactorGuard`).

| Method & path             | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `GET /admin/roles`        | List the assignable canonical roles.                    |
| `GET /admin/users/:id/role`   | Get a user's current role.                          |
| `PATCH /admin/users/:id/role` | Assign a role (`{ "role": "OPERATOR" }`). 400 on conflict, 404 if the user is missing. |
| `DELETE /admin/users/:id/role`| Reset the user to the least-privileged `USER` role. |

The assign payload is validated by `AssignRoleDto` (`@IsEnum(Role)`), so any
value outside the canonical role set is rejected with `400` before it reaches
the service — this prevents privilege escalation via malformed input.

## Bootstrapping the first admin

Because every role-management route already requires `ADMIN`, a fresh deployment
needs a way to mint the first admin. `RoleSeederService` handles this on
application start, idempotently and non-destructively.

Set **one** of the following environment variables to an **existing** account:

```bash
ADMIN_BOOTSTRAP_EMAIL=admin@example.com
# or
ADMIN_BOOTSTRAP_WALLET=0xabc...
```

On boot the seeder:

- does nothing if neither variable is set;
- logs a warning and does nothing if no matching user exists (it never creates
  phantom accounts or invents credentials — register the account first, then
  restart);
- does nothing if the user is already `ADMIN`;
- otherwise promotes the matching user to `ADMIN`.

> The application runs on TypeORM `synchronize: true`, and role data is a single
> column on the `users` table, so there is no separate roles migration. If
> migration infrastructure is added later, this promotion can move into a data
> migration unchanged.

## Testing

- `src/common/guard/normalize-role.spec.ts` — claim coercion and defaults.
- `src/common/guard/roles.guard.spec.ts` — guard behaviour, including legacy
  lowercase-claim compatibility.
- `src/core/user/admin-role.controller.spec.ts` — admin endpoint behaviour.
- `src/core/user/user-role-separation.spec.ts` — conflicting-role enforcement.
- `src/core/user/role-seeder.service.spec.ts` — idempotent bootstrap promotion.

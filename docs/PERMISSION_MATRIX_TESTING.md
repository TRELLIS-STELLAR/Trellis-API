# Permission matrix verification

The permission matrix is the source of truth for privileged action boundaries. `PermissionMatrixGuard` now requires both conditions: the caller must have every permission listed for the action and at least one of the action's declared roles. This prevents a permission shared by several roles from widening a privileged entrypoint accidentally.

The matrix test suite iterates over every action and every canonical role. It checks that excluded roles are denied, declared roles hold the required permission, administrators retain the global override, sensitive actions remain auditable, and unknown actions fail closed for non-admin callers.

Run it with:

```bash
npx jest src/common/guard/permission-matrix.spec.ts
```

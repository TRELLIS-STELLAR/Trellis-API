# Circular dependency check

`npm run check:circular` scans production TypeScript modules under `src/`, resolves relative imports, and fails when a module is reachable from itself. Test files are excluded so test-only fixtures do not affect the application graph. TypeORM entity files are excluded because bidirectional relation metadata intentionally references both entity classes; application services and shared policy contracts remain in the checked graph.

The check runs before `npm run build` and in the build workflow. Keep module boundaries directional; when a cycle is found, move shared contracts into a lower-level module or inject the dependency through an interface rather than suppressing the check.

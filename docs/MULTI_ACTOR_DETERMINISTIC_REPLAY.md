# Multi-Actor Deterministic Replay Tests

## Overview

The multi-actor deterministic replay test suite extends the deterministic replay framework to comprehensively validate concurrent mutation scenarios. This implementation covers normal operations, failure paths, retry logic, and authorization checks across multiple interacting actors.

## Purpose

These tests ensure that concurrent mutations maintain consistency guarantees across all possible execution interleavings. By controlling the schedule of actor steps, we can reproduce specific failure scenarios and validate that the system handles conflicts, retries, and authorization correctly.

## Test Coverage

### 1. Normal Path: Concurrent Mutations

**Scenarios:**
- Multiple actors applying mutations concurrently
- Verification across all possible interleavings
- Balance consistency with 3-6 concurrent actors
- Trace reproducibility for debugging

**Guarantees:**
- All valid mutations are eventually applied
- Final balance equals sum of successful operations
- Version numbers increment correctly
- No lost updates or race conditions

### 2. Failure Path: Validation and Rejection

**Scenarios:**
- Mutations failing validation checks
- Multiple concurrent validation failures
- Partial failure with successful operations
- State corruption prevention

**Guarantees:**
- Failed operations don't affect system state
- Balance reflects only successful operations
- Invalid operations are properly rejected
- No partial application of failed mutations

### 3. Retry Path: Conflict Resolution

**Scenarios:**
- Version conflicts with automatic retry
- Retry exhaustion and graceful failure
- Mixed retry limits across actors
- Conflict resolution under contention

**Guarantees:**
- Conflicts are detected via optimistic locking
- Retries eventually succeed when possible
- Exhausted retries fail without corruption
- Version consistency maintained throughout

### 4. Authorization Path: Permission Enforcement

**Scenarios:**
- Unauthorized actors blocked in all interleavings
- Multiple unauthorized actors
- Role-based access control validation
- Admin-only operation enforcement

**Guarantees:**
- Unauthorized operations never modify state
- Permission checks occur before mutations
- Authorization violations are tracked
- Role hierarchy is respected

### 5. Rollback and Recovery

**Scenarios:**
- Explicit rollback on conflict
- Rollback history tracking
- Recovery from partial failures

**Guarantees:**
- Rollbacks don't corrupt state
- Rollback history is accurate
- System remains consistent post-rollback

### 6. Edge Cases and Idempotency

**Scenarios:**
- Duplicate operation IDs
- Zero-amount mutations
- Negative amounts (debits)
- Large mutation sets

**Guarantees:**
- Operations applied exactly once per ID
- Zero and negative amounts handled correctly
- Idempotency maintained across retries

## Architecture

### Multi-Actor State

```typescript
interface MultiActorState {
  balance: number;                    // Primary value being mutated
  version: number;                    // Optimistic concurrency version
  appliedOperations: Set<string>;     // Idempotency tracking
  outcomes: Record<string, Outcome>;  // Actor results
  amounts: Record<string, number>;    // Amount per actor
  failureFlags: Set<string>;          // Failure injection
  authViolations: string[];           // Auth tracking
  rollbackHistory: Array<{            // Rollback log
    actor: string;
    reason: string;
  }>;
}
```

### Mutation Actor Phases

Each mutation actor progresses through deterministic phases:

1. **auth-check** - Verify permissions before proceeding
2. **read** - Capture current state snapshot
3. **validate** - Check business rules and idempotency
4. **write** - Apply mutation with version check
5. **rollback** (optional) - Undo on conflict if configured

### Outcomes

```typescript
type MutationOutcome =
  | "success"           // Mutation applied successfully
  | "conflict"          // Version conflict detected
  | "unauthorized"      // Permission denied
  | "retry-exhausted"   // Max retries exceeded
  | "validation-failed" // Business rule violation
  | "rolled-back";      // Explicitly rolled back
```

## Usage Examples

### Basic Multi-Actor Test

```typescript
const scenario = createScenario((state) => [
  createMutationActor(state, "actor-a", 100, "op-1", [Role.USER]),
  createMutationActor(state, "actor-b", 50, "op-2", [Role.USER]),
  createMutationActor(state, "actor-c", 25, "op-3", [Role.USER]),
]);

await exploreInterleavings(scenario, ({ state }) => {
  expect(state.balance).toBe(175);
  expect(successfulTotal(state)).toBe(175);
});
```

### Failure Injection

```typescript
const scenario = createScenario((state) => [
  createMutationActor(state, "valid", 100, "op-1", [Role.USER]),
  createMutationActor(state, "invalid", 50, "op-2", [Role.USER], {
    shouldFail: true,
  }),
]);

await exploreInterleavings(scenario, ({ state }) => {
  expect(state.balance).toBe(100);
  expect(state.outcomes.invalid).toBe("validation-failed");
});
```

### Authorization Testing

```typescript
const scenario = createScenario((state) => [
  createMutationActor(state, "authorized", 100, "op-1", [Role.USER]),
  createMutationActor(state, "unauthorized", 999, "op-2", []),
]);

await exploreInterleavings(scenario, ({ state }) => {
  expect(state.balance).toBe(100);
  expect(state.outcomes.unauthorized).toBe("unauthorized");
  expect(state.authViolations).toContain("unauthorized");
});
```

### Retry Configuration

```typescript
const scenario = createScenario((state) => [
  createMutationActor(state, "patient", 100, "op-1", [Role.USER], {
    maxRetries: 10,
  }),
  createMutationActor(state, "impatient", 50, "op-2", [Role.USER], {
    maxRetries: 1,
  }),
]);
```

## Integration with Existing Systems

### Optimistic Concurrency

The tests use the production `OptimisticConcurrencyService`:

```typescript
import { OptimisticConcurrencyService } from "../../common/concurrency/optimistic-concurrency.service";

const optimistic = new OptimisticConcurrencyService();
optimistic.assertCurrent({ version: currentVersion }, snapshotVersion);
```

### Permission System

Leverages the real authorization system:

```typescript
import { Permission, Role, hasPermission } from "../../common/guard/roles.enum";

if (!hasPermission(roles, Permission.PAYMENT_CREATE)) {
  // Deny mutation
}
```

## Debugging Failed Interleavings

When a test fails:

1. **Capture the trace**: The failure message includes the actor step sequence
2. **Create regression test**: Use `replaySchedule` with the captured trace
3. **Analyze state**: Examine the final state and outcomes
4. **Verify fix**: Ensure the trace passes after correction

```typescript
// Reproduce a specific failure
const failingTrace = [0, 1, 0, 2, 1, 0]; // From failure log
const result = await replaySchedule(scenario, failingTrace);
expect(result.state.balance).toBe(expectedValue);
```

## Performance Considerations

### Exploration Limits

- **Default**: 20,000 schedules per test
- **Custom**: Use `maxSchedules` option for larger scenarios
- **Truncation**: Tests mark when coverage is incomplete

```typescript
await exploreInterleavings(scenario, invariantCheck, {
  maxSchedules: 1000, // Limit for faster execution
});
```

### Seeded Testing

For quick smoke tests or CI:

```typescript
// Test specific interleavings via seeds
for (let seed = 1; seed <= 50; seed++) {
  const result = await runSeeded(scenario, seed);
  validateInvariants(result.state);
}
```

## Contract Guarantees

### Consistency Invariants

✅ **Balance Integrity**: `state.balance === successfulTotal(state)`
✅ **Version Consistency**: Version increments match successful operations
✅ **Idempotency**: Duplicate operation IDs applied exactly once
✅ **Authorization**: Unauthorized operations never modify state
✅ **No Lost Updates**: All valid operations eventually succeed

### Failure Behavior

✅ **Conflict Detection**: Version mismatches caught immediately
✅ **Retry Safety**: Retries don't cause duplicate application
✅ **Graceful Degradation**: Exhausted retries fail cleanly
✅ **Rollback Safety**: Rollbacks maintain consistency

## Migration and Rollback

### Adding Tests

Safe to add new test scenarios without affecting existing functionality:

```typescript
describe("New scenario", () => {
  it("validates new requirement", async () => {
    // New test scenario
  });
});
```

### Removing Tests

To rollback this feature:
1. Delete `src/testing/concurrency/multi-actor-mutations.spec.ts`
2. Delete `docs/MULTI_ACTOR_DETERMINISTIC_REPLAY.md`
3. No schema or runtime changes required

## Operational Notes

- **CI Integration**: Tests run in standard Jest pipeline
- **Execution Time**: ~5-15 seconds per full test suite
- **Memory**: Minimal overhead (state is lightweight)
- **Dependencies**: Uses existing concurrency and auth services

## Related Documentation

- [DETERMINISTIC_REPLAY.md](./DETERMINISTIC_REPLAY.md) - Core replay framework
- [CONCURRENCY_HARNESS.md](./CONCURRENCY_HARNESS.md) - Real async race testing
- [docs/RBAC.md](./RBAC.md) - Role-based access control

## Compliance

- ✅ Covers normal, failure, retry, and authorization paths
- ✅ Automated tests with executable verification
- ✅ Edge cases documented with recovery behavior
- ✅ No contract changes (test-only implementation)
- ✅ Focused vertical slice of multi-actor mutations

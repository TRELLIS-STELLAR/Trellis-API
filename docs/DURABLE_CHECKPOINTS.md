# Durable Checkpoints for External Side Effects

## Overview

The checkpoint system provides durable, idempotent execution guarantees for external side effects. It prevents duplicate operations, enables recovery from failures, and maintains audit trails for compliance and debugging.

## Architecture

### Core Concepts

1. **Checkpoint**: A durable record of an operation's lifecycle
2. **Idempotency Key**: Unique identifier preventing duplicate execution
3. **Operation Guard**: Decision point determining whether to proceed or return cached result
4. **Compensating Action**: Rollback function to undo side effects

### Guarantees

- **At-Most-Once Execution**: Idempotency prevents duplicate operations
- **Failure Recovery**: Incomplete operations can be retried or rolled back
- **Audit Trail**: Complete history of all operation attempts
- **Crash Recovery**: System restart doesn't lose operation state

## Usage

### Basic Checkpointing

```typescript
import { CheckpointService, OperationType } from './checkpoint.service';

constructor(private checkpointService: CheckpointService) {}

async sendWebhook(url: string, payload: any) {
  // Create checkpoint before external call
  const guard = await this.checkpointService.createCheckpoint(
    OperationType.WEBHOOK_DELIVERY,
    `webhook:${url}:${Date.now()}`,
    { url, payload }
  );

  if (!guard.canProceed) {
    // Operation already completed, return cached result
    return guard.previousResult;
  }

  try {
    // Make external call
    const response = await axios.post(url, payload);
    
    // Mark successful
    await this.checkpointService.completeCheckpoint(
      guard.operationId,
      response.data
    );
    
    return response.data;
  } catch (error) {
    // Mark failed
    await this.checkpointService.failCheckpoint(
      guard.operationId,
      error
    );
    throw error;
  }
}
```

### Automatic Checkpointing

```typescript
async processPayment(orderId: string, amount: number) {
  return this.checkpointService.executeWithCheckpoint(
    OperationType.PAYMENT_PROCESS,
    `payment:${orderId}`,
    async () => {
      // Operation code
      return await paymentGateway.charge(amount);
    },
    {
      context: { orderId, amount },
      maxRetries: 3,
      rollbackFn: async () => {
        // Compensating action
        await paymentGateway.refund(orderId);
      }
    }
  );
}
```

### Idempotency Keys

**Good Idempotency Keys:**
- Include operation type: `payment:order-123`
- Include resource ID: `webhook:user-456:event-789`
- Include timestamp for time-sensitive ops: `export:user-123:${timestamp}`

**Bad Idempotency Keys:**
- Too generic: `payment` (prevents all payments)
- Includes random values: `payment:${Math.random()}`
- Missing context: `123` (unclear what operation)

### Retry with Checkpoints

```typescript
async sendEmail(to: string, subject: string, body: string) {
  const idempotencyKey = `email:${to}:${subject}:${Date.now()}`;
  
  const guard = await this.checkpointService.createCheckpoint(
    OperationType.EMAIL_SEND,
    idempotencyKey,
    { to, subject },
    { maxRetries: 3 }
  );

  if (!guard.canProceed) {
    if (guard.reason === 'Max retries exceeded') {
      throw new Error('Failed to send email after 3 attempts');
    }
    return guard.previousResult;
  }

  try {
    const result = await emailService.send(to, subject, body);
    await this.checkpointService.completeCheckpoint(guard.operationId, result);
    return result;
  } catch (error) {
    await this.checkpointService.failCheckpoint(guard.operationId, error);
    throw error;
  }
}
```

### Rollback Operations

```typescript
async createUserAndNotify(userData: any) {
  const idempotencyKey = `user:create:${userData.email}`;
  
  let userId: string;
  
  return this.checkpointService.executeWithCheckpoint(
    OperationType.DATABASE_WRITE,
    idempotencyKey,
    async () => {
      // Create user
      userId = await userRepository.create(userData);
      
      // Send welcome email
      await emailService.sendWelcome(userData.email);
      
      return { userId };
    },
    {
      rollbackFn: async () => {
        // Rollback: delete user if email fails
        if (userId) {
          await userRepository.delete(userId);
        }
      }
    }
  );
}
```

### Recovery After Restart

```typescript
async onModuleInit() {
  // Recover incomplete checkpoints
  const incomplete = await this.checkpointService.recoverCheckpoints();
  
  for (const checkpoint of incomplete) {
    this.logger.warn(
      `Incomplete operation: ${checkpoint.operationId} (${checkpoint.operationType})`
    );
    
    // Decide whether to retry or rollback
    if (checkpoint.retryCount < checkpoint.maxRetries) {
      await this.retryOperation(checkpoint);
    } else {
      await this.rollbackOperation(checkpoint);
    }
  }
}
```

## Test Coverage

### Normal Operation Tests

✅ **Checkpoint Creation**
- Creates new checkpoint for first-time operations
- Assigns unique operation ID
- Tracks metadata (type, context, timestamps)

✅ **Successful Completion**
- Marks checkpoint as completed
- Stores operation result
- Records completion timestamp

✅ **Idempotency**
- Prevents duplicate execution with same key
- Returns cached result for completed operations
- Tracks duplicates prevented metric

✅ **Context Tracking**
- Stores operation context
- Tracks correlation IDs
- Supports parent-child relationships

✅ **Automatic Checkpointing**
- Wraps operations with checkpoint logic
- Handles success and failure automatically
- Returns cached results on duplicates

### Failure Scenarios

✅ **Operation Failure**
- Marks checkpoint as failed
- Stores error message
- Preserves failure state for retry

✅ **Missing Operations**
- Handles completion of nonexistent checkpoint gracefully
- Handles failure of nonexistent checkpoint gracefully
- Logs warnings appropriately

✅ **Max Retries**
- Prevents execution after max retries
- Returns appropriate error message
- Tracks retry exhaustion

✅ **Automatic Rollback**
- Executes rollback on operation failure
- Marks checkpoint as rolled back
- Handles rollback failures

### Retry Logic

✅ **Failed Operation Retry**
- Allows retry of failed operations
- Reuses same operation ID
- Increments retry counter

✅ **Retry Count Tracking**
- Starts at 0 for new operations
- Increments on each retry attempt
- Enforces max retry limit

✅ **Duplicate Prevention**
- Executes operation only once
- Returns cached result on duplicate attempts
- Updates duplicates prevented metric

### Rollback Operations

✅ **Compensating Actions**
- Executes provided rollback function
- Marks checkpoint as rolled back
- Records rollback timestamp

✅ **Rollback Failures**
- Logs compensation errors
- Throws error to caller
- Prevents checkpoint state update

✅ **Optional Rollback**
- Supports rollback without compensation
- Updates checkpoint status
- Records rollback timestamp

### Recovery Operations

✅ **Incomplete Checkpoint Identification**
- Finds in-progress operations
- Returns for recovery processing
- Excludes completed operations

✅ **Expired Checkpoint Cleanup**
- Removes expired checkpoints
- Cleans idempotency cache
- Returns cleanup count

✅ **TTL Enforcement**
- Respects checkpoint expiration
- Preserves non-expired checkpoints
- Configurable TTL per operation

### Querying and Filtering

✅ **List All Checkpoints**
- Returns all checkpoint records
- Sorts by creation time (newest first)
- Supports pagination with limit

✅ **Filter by Status**
- Filters completed checkpoints
- Filters failed checkpoints
- Filters in-progress checkpoints

✅ **Filter by Operation Type**
- Returns checkpoints of specific type
- Supports all operation types
- Combines with other filters

✅ **Filter by Correlation ID**
- Groups related operations
- Supports distributed tracing
- Enables operation chain analysis

✅ **Lookup by Idempotency Key**
- Direct lookup by key
- Returns single checkpoint
- Efficient cache-based retrieval

### Metrics and Statistics

✅ **Comprehensive Stats**
- Total checkpoint count
- Status distribution
- Average completion time

✅ **Duplicate Tracking**
- Counts prevented duplicates
- Measures idempotency effectiveness
- Identifies repeated requests

✅ **Timing Metrics**
- Average completion time
- Completion time distribution
- Performance monitoring

### Authorization Patterns

✅ **User Context**
- Includes user ID in metadata
- Tracks user roles
- Stores permissions

✅ **Audit Trail**
- Records request details
- Sanitizes sensitive data
- Supports compliance requirements

## Edge Cases and Recovery

### Handled Edge Cases

1. **Concurrent Requests**: First request wins, others get cached result
2. **System Crash**: Incomplete operations recovered on restart
3. **Network Partition**: Operations retry after connectivity restored
4. **Clock Skew**: Uses server time consistently
5. **Storage Failure**: Logs errors, allows operation to proceed (fail-open)

### Recovery Procedures

#### Incomplete Operations After Restart

```typescript
// System restart detected incomplete operations
const incomplete = await checkpointService.recoverCheckpoints();

for (const checkpoint of incomplete) {
  if (shouldRetry(checkpoint)) {
    // Retry the operation
    await retryOperation(checkpoint);
  } else {
    // Rollback and clean up
    await rollbackOperation(checkpoint);
  }
}
```

#### Failed Rollback Recovery

```typescript
// Manual rollback for failed compensation
const failedRollbacks = checkpointService.listCheckpoints({
  status: CheckpointStatus.FAILED
});

for (const checkpoint of failedRollbacks) {
  // Manual compensation based on operation type
  switch (checkpoint.operationType) {
    case OperationType.PAYMENT_PROCESS:
      await manualRefund(checkpoint.context);
      break;
    case OperationType.DATABASE_WRITE:
      await manualDelete(checkpoint.context);
      break;
  }
  
  await checkpointService.rollbackCheckpoint(checkpoint.operationId);
}
```

#### Expired Checkpoint Cleanup

```typescript
// Schedule periodic cleanup
setInterval(async () => {
  const cleaned = await checkpointService.cleanupExpiredCheckpoints();
  logger.log(`Cleaned ${cleaned} expired checkpoints`);
}, 60 * 60 * 1000); // Every hour
```

## Operation Types

### HTTP_REQUEST
External HTTP API calls

**Example:**
```typescript
await checkpointService.executeWithCheckpoint(
  OperationType.HTTP_REQUEST,
  `http:${method}:${url}:${requestId}`,
  async () => axios.request(config)
);
```

### DATABASE_WRITE
Database mutations outside transactions

**Example:**
```typescript
await checkpointService.executeWithCheckpoint(
  OperationType.DATABASE_WRITE,
  `db:insert:users:${email}`,
  async () => userRepository.create(userData),
  { rollbackFn: () => userRepository.delete(userId) }
);
```

### EXTERNAL_API
Third-party service integrations

**Example:**
```typescript
await checkpointService.executeWithCheckpoint(
  OperationType.EXTERNAL_API,
  `stripe:charge:${orderId}`,
  async () => stripe.charges.create(chargeData)
);
```

### WEBHOOK_DELIVERY
Outbound webhook notifications

**Example:**
```typescript
await checkpointService.executeWithCheckpoint(
  OperationType.WEBHOOK_DELIVERY,
  `webhook:${webhookId}:${eventId}`,
  async () => axios.post(webhookUrl, eventData)
);
```

### EMAIL_SEND
Email delivery operations

**Example:**
```typescript
await checkpointService.executeWithCheckpoint(
  OperationType.EMAIL_SEND,
  `email:${userId}:${templateId}:${timestamp}`,
  async () => emailService.send(email)
);
```

### PAYMENT_PROCESS
Payment gateway transactions

**Example:**
```typescript
await checkpointService.executeWithCheckpoint(
  OperationType.PAYMENT_PROCESS,
  `payment:${orderId}`,
  async () => paymentGateway.charge(amount),
  { rollbackFn: () => paymentGateway.refund(orderId) }
);
```

## Monitoring and Alerts

### Metrics to Track

```typescript
const stats = checkpointService.getStats();

// Monitor these metrics
- stats.totalCheckpoints: Total operations
- stats.completedCheckpoints / stats.totalCheckpoints: Success rate
- stats.failedCheckpoints: Error rate
- stats.duplicatesPrevented: Idempotency effectiveness
- stats.avgCompletionTimeMs: Performance
```

### Recommended Alerts

```typescript
// High failure rate
if (stats.failedCheckpoints / stats.totalCheckpoints > 0.1) {
  alert('High checkpoint failure rate (>10%)');
}

// Slow operations
if (stats.avgCompletionTimeMs > 5000) {
  alert('Checkpointed operations are slow (>5s average)');
}

// Many duplicates (possible retry storm)
if (stats.duplicatesPrevented > stats.completedCheckpoints * 0.5) {
  alert('High duplicate rate - possible retry storm');
}

// Many incomplete operations
const incomplete = await checkpointService.recoverCheckpoints();
if (incomplete.length > 100) {
  alert('Many incomplete operations - investigate failures');
}
```

## Best Practices

### Idempotency Key Design

1. **Include Resource Identifier**: `payment:order-123` not `payment`
2. **Include Operation Type**: `email:send:user-456` not `user-456`
3. **Be Deterministic**: Same input → same key
4. **Include Version**: `payment:v2:order-123` for schema changes

### Error Handling

```typescript
try {
  await checkpointService.executeWithCheckpoint(
    OperationType.EXTERNAL_API,
    key,
    operation,
    { maxRetries: 3 }
  );
} catch (error) {
  if (error.message === 'Max retries exceeded') {
    // Alert ops team
    await alertOpsTeam(error);
  }
  throw error;
}
```

### Context Data

```typescript
// Good context
{
  userId: 'user-123',
  operation: 'payment',
  amount: 100,
  currency: 'USD',
  timestamp: new Date()
}

// Bad context (too large, contains PII)
{
  user: entireUserObject, // Too large
  creditCard: '4111111111111111', // Sensitive
  allOrderHistory: [...] // Unnecessary
}
```

## Performance Considerations

- **Memory**: Checkpoints stored in-memory (consider persistent storage for production)
- **Lookup**: O(1) for idempotency key lookup
- **Cleanup**: Schedule periodic cleanup to prevent unbounded growth
- **TTL**: Set appropriate TTL based on retry window

## Migration Plan

This is a new feature requiring no database migrations. Integration steps:

1. Add CheckpointService to module providers
2. Inject service where external calls are made
3. Wrap external operations with checkpointing
4. Add recovery logic to module initialization
5. Configure monitoring and alerts

## Security Considerations

1. **Sensitive Data**: Don't store credentials in checkpoint context
2. **Authorization**: Verify permissions before operation AND on retry
3. **Audit Trail**: Checkpoint metadata provides compliance evidence
4. **Idempotency Key Guessing**: Use UUIDs or cryptographically random values

## Dependencies

- uuid: For generating operation IDs
- NestJS: For dependency injection
- TypeScript: For type safety

## Future Improvements

1. Persistent storage backend (Redis, PostgreSQL)
2. Distributed checkpointing across service instances
3. Checkpoint compression for large payloads
4. Integration with distributed tracing (OpenTelemetry)
5. Checkpoint snapshot/restore for disaster recovery

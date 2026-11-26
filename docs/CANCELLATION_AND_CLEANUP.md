# Cancellation and Cleanup for Long Operations

## Overview

This document describes the cancellation and cleanup system for long-running operations in the Trellis API. The system provides cooperative cancellation, resource cleanup, rollback capabilities, and comprehensive audit trails.

## Architecture

### Components

1. **CancellationService**: Core service managing cancellation requests, cleanup, and audit
2. **CancellationToken**: Lightweight object tracking cancellation state
3. **CleanupContext**: Container for resources and rollback actions per job
4. **Audit Log**: Immutable trail of all cancellation events

### Cancellation Flow

```
┌─────────────┐
│  Request    │
│Cancellation │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Create     │
│   Token     │
└──────┬──────┘
       │
       ▼
┌─────────────┐      ┌──────────────┐
│   Worker    │─────▶│  Check Token │
│   Detects   │      │  Periodically│
└──────┬──────┘      └──────────────┘
       │
       ▼
┌─────────────┐
│ Acknowledge │
│Cancellation │
└──────┬──────┘
       │
       ▼
┌─────────────┐      ┌──────────────┐
│  Execute    │─────▶│   Release    │
│  Rollback   │      │  Resources   │
└──────┬──────┘      └──────────────┘
       │
       ▼
┌─────────────┐
│   Update    │
│ Audit Log   │
└─────────────┘
```

## Usage

### Requesting Cancellation

```typescript
import { CancellationService } from './cancellation.service';

// Inject service
constructor(private cancellationService: CancellationService) {}

// Request cancellation
const cancelled = await this.cancellationService.requestCancellation(
  'job-123',
  'User requested cancellation',
  'user-456'
);

if (cancelled) {
  console.log('Cancellation initiated');
}
```

### Checking for Cancellation (Worker Side)

```typescript
// In your long-running operation
async function processLargeDataset(jobId: string) {
  for (const batch of dataset) {
    // Check if cancelled before processing each batch
    if (this.cancellationService.shouldCancel(jobId)) {
      await this.cancellationService.acknowledgeCancellation(jobId);
      return; // Exit early
    }
    
    await processBatch(batch);
  }
}
```

### Registering Resources

```typescript
// Register resources that need cleanup
async function processWithResources(jobId: string) {
  const fileHandle = await openFile('data.txt');
  this.cancellationService.registerResource(jobId, 'file-handle', fileHandle);
  
  const dbConnection = await connectToDatabase();
  this.cancellationService.registerResource(jobId, 'db-connection', dbConnection);
  
  try {
    await processData(fileHandle, dbConnection);
  } catch (error) {
    // Resources will be cleaned up on cancellation
    throw error;
  }
}
```

### Registering Rollback Actions

```typescript
// Register actions to undo work on cancellation
async function processWithRollback(jobId: string) {
  const recordId = await createRecord();
  
  // Register rollback to delete the record
  this.cancellationService.registerRollback(jobId, async () => {
    await deleteRecord(recordId);
  });
  
  const tempFile = await createTempFile();
  
  // Register rollback to delete temp file
  this.cancellationService.registerRollback(jobId, async () => {
    await deleteTempFile(tempFile);
  });
  
  await processRecord(recordId, tempFile);
}
```

## Test Coverage

### Normal Operation Tests

✅ **Request Cancellation**
- Successfully requests cancellation for active jobs
- Creates cancellation token
- Invokes worker service cancellation

✅ **Audit Logging**
- Tracks all cancellation requests
- Records requester and timestamp
- Maintains complete lifecycle history

✅ **Worker Polling**
- Allows workers to check cancellation status
- Returns true for cancelled jobs
- Returns false for non-cancelled jobs

✅ **Acknowledgement**
- Processes worker acknowledgement
- Updates audit log with timestamps
- Triggers cleanup procedures

✅ **Resource Cleanup**
- Closes registered resources
- Handles multiple resource types
- Supports close(), destroy(), release(), end() methods

✅ **Rollback Execution**
- Executes rollback actions in reverse order (LIFO)
- Handles async rollback functions
- Completes all rollback actions

### Failure Scenarios

✅ **Missing Job**
- Returns false when job not found
- Logs appropriate warning
- Does not create cancellation token

✅ **Terminal Status**
- Prevents cancellation of completed jobs
- Prevents cancellation of already-cancelled jobs
- Prevents cancellation of dead-lettered jobs

✅ **Idempotent Requests**
- Handles duplicate cancellation requests
- Does not create duplicate audit entries
- Returns success for repeated requests

✅ **Rollback Failures**
- Continues cleanup despite rollback errors
- Logs rollback failures
- Attempts all registered rollbacks

✅ **Resource Cleanup Failures**
- Continues cleanup despite resource errors
- Logs cleanup failures
- Attempts all resource cleanups

✅ **Multiple Cleanup Methods**
- Handles resources with various cleanup APIs
- Gracefully handles resources without cleanup methods
- Tests all common cleanup patterns

### Retry and Timeout Handling

✅ **Forced Cleanup**
- Schedules timeout-based forced cleanup
- Executes after 30 seconds without acknowledgement
- Cleans up resources if worker doesn't respond

✅ **Acknowledgement Before Timeout**
- Skips forced cleanup if already acknowledged
- Prevents duplicate cleanup
- Respects worker cooperation

### Authorization and Audit

✅ **Requester Tracking**
- Records who requested cancellation
- Includes requester in audit log
- Supports authorization checks

✅ **Complete Audit Trail**
- Provides per-job audit history
- Provides system-wide audit history
- Tracks full lifecycle timestamps

✅ **Lifecycle Tracking**
- Tracks requested → acknowledged → completed flow
- Records timing for each stage
- Flags failed cleanups

### Metrics

✅ **Cancellation Statistics**
- Total cancellations
- Completed vs. failed
- Success rate calculation
- Average timing metrics

✅ **Active Context Tracking**
- Number of active cleanup contexts
- Number of active cancellation tokens
- Resource usage monitoring

✅ **Performance Metrics**
- Average acknowledgement time
- Average cleanup time
- Context cleanup efficiency

## Edge Cases and Recovery

### Handled Edge Cases

1. **Acknowledgement without request**: Logged warning, no error
2. **Resource registration for nonexistent job**: Throws descriptive error
3. **Rollback registration for nonexistent job**: Throws descriptive error
4. **Resources without cleanup methods**: Handled gracefully
5. **Concurrent cancellation requests**: Idempotent handling
6. **Cancellation after completion**: Rejected appropriately

### Recovery Procedures

#### Failed Cleanup

If cleanup fails:

1. Error is logged with full context
2. Audit log marked as 'failed' with error message
3. Other cleanup operations continue
4. Manual intervention may be required

**Manual Recovery:**

```typescript
// Get failed cancellations
const metrics = cancellationService.getMetrics();
const failedCount = metrics.failed;

// Review audit log
const audits = cancellationService.getAllCancellationAudits();
const failed = audits.filter(a => a.status === 'failed');

// Manually clean up resources
for (const audit of failed) {
  // Custom recovery logic based on job type
  await manualCleanup(audit.jobId, audit.jobType);
}
```

#### Stuck Cancellations

If cancellation is not acknowledged within 30 seconds:

1. Forced cleanup is triggered automatically
2. Resources are released
3. Audit log records forced completion

**Monitoring:**

```typescript
// Check for long-running cancellations
const metrics = cancellationService.getMetrics();
if (metrics.avgAcknowledgeTimeMs > 10000) {
  console.warn('Cancellations taking too long to acknowledge');
}
```

## Rollback Strategies

### Database Transactions

```typescript
async function processWithTransaction(jobId: string) {
  const transaction = await db.beginTransaction();
  
  this.cancellationService.registerRollback(jobId, async () => {
    await transaction.rollback();
  });
  
  await performDatabaseOperations(transaction);
  
  if (!this.cancellationService.shouldCancel(jobId)) {
    await transaction.commit();
  }
}
```

### File Operations

```typescript
async function processWithFiles(jobId: string) {
  const tempFiles: string[] = [];
  
  this.cancellationService.registerRollback(jobId, async () => {
    for (const file of tempFiles) {
      await fs.unlink(file);
    }
  });
  
  // Create temp files during processing
  tempFiles.push(await createTempFile());
}
```

### External API Calls

```typescript
async function processWithExternalAPI(jobId: string) {
  const orderId = await createOrder();
  
  this.cancellationService.registerRollback(jobId, async () => {
    await cancelOrder(orderId);
  });
  
  await processOrder(orderId);
}
```

## Monitoring and Alerts

### Metrics to Monitor

- **Cancellation rate**: `cancellations / total_jobs`
- **Cleanup success rate**: `completed / total_cancellations`
- **Average acknowledgement time**: Should be < 10 seconds
- **Average cleanup time**: Should be < 5 seconds
- **Active contexts**: Should not grow unbounded

### Recommended Alerts

```typescript
// Alert on high cancellation rate
if (cancellationRate > 0.1) { // 10%
  alert('High cancellation rate detected');
}

// Alert on slow acknowledgements
if (avgAcknowledgeTimeMs > 15000) { // 15 seconds
  alert('Workers slow to acknowledge cancellations');
}

// Alert on cleanup failures
if (metrics.failed > 0) {
  alert('Cleanup failures detected - manual intervention required');
}

// Alert on context leak
if (metrics.activeCleanupContexts > 1000) {
  alert('Potential context leak - investigate memory usage');
}
```

## Security Considerations

1. **Authorization**: Verify user has permission to cancel job before allowing cancellation
2. **Audit Trail**: Maintain immutable audit log for compliance
3. **Resource Protection**: Ensure cleanup doesn't delete shared resources
4. **Rollback Safety**: Validate rollback actions don't create security holes

## Performance Impact

- **Cancellation request**: O(1) - negligible impact
- **Worker polling**: O(1) - single map lookup
- **Resource cleanup**: O(n) - linear with registered resources
- **Rollback execution**: O(n) - linear with registered rollbacks

### Optimization Tips

1. Register resources lazily (only when needed)
2. Batch resource registration when possible
3. Keep rollback actions lightweight
4. Use forced cleanup timeout appropriate for your workload

## Migration Plan

This feature extends the existing worker infrastructure. No database migrations required.

### Integration Steps

1. Add `CancellationService` to worker module providers
2. Inject service into worker processors
3. Add periodic cancellation checks in long operations
4. Register resources and rollbacks as needed
5. Update monitoring dashboards with cancellation metrics

## Dependencies

- Existing `BackgroundWorkerService`
- NestJS dependency injection
- Bull queue infrastructure

## Future Improvements

1. Distributed cancellation coordination
2. Batch cancellation endpoints
3. Cancellation policies (auto-cancel after N hours)
4. Resource usage limits with auto-cancellation
5. Advanced rollback orchestration (sagas)

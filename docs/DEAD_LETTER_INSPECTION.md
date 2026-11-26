# Dead-Letter Inspection and Safe Retry Tooling

## Overview

The dead-letter inspection system provides comprehensive tools for monitoring, analyzing, and safely retrying failed background jobs that have exhausted their retry attempts. This system helps operators diagnose recurring failures and recover from transient issues without manual intervention.

## Features

### 1. Dead-Letter Queue Statistics

Get comprehensive statistics about dead-lettered jobs including:
- Total count of dead-lettered jobs
- Breakdown by job type
- Breakdown by error pattern
- Oldest job information with age tracking
- Recent failures list

**Endpoint:** `GET /api/v1/dead-letter/stats`

**Response:**
```json
{
  "total": 45,
  "byType": {
    "webhook.delivery": 30,
    "email.send": 10,
    "data.export": 5
  },
  "byError": {
    "Connection timeout": 25,
    "SMTP error": 10,
    "Invalid recipient": 10
  },
  "oldestJob": {
    "id": "job_1234567890_abc123",
    "type": "webhook.delivery",
    "deadLetteredAt": "2024-11-20T10:30:00Z",
    "ageHours": 48
  },
  "recentFailures": [
    {
      "id": "job_9876543210_xyz789",
      "type": "email.send",
      "error": "SMTP error: Connection refused",
      "attempts": 3,
      "deadLetteredAt": "2024-11-22T14:20:00Z"
    }
  ]
}
```

### 2. List Dead-Lettered Jobs with Filtering

Filter and search dead-lettered jobs by multiple criteria:

**Endpoint:** `GET /api/v1/dead-letter/jobs`

**Query Parameters:**
- `type` (optional): Filter by job type (e.g., "webhook.delivery")
- `errorPattern` (optional): Regex pattern to match error messages
- `minAge` (optional): Minimum age in hours
- `maxAge` (optional): Maximum age in hours
- `limit` (optional): Maximum number of results (default: 50)

**Examples:**

```bash
# Get all webhook delivery failures
GET /api/v1/dead-letter/jobs?type=webhook.delivery

# Get jobs with timeout errors
GET /api/v1/dead-letter/jobs?errorPattern=timeout

# Get jobs older than 24 hours
GET /api/v1/dead-letter/jobs?minAge=24

# Get recent failures (less than 12 hours old)
GET /api/v1/dead-letter/jobs?maxAge=12

# Combine filters
GET /api/v1/dead-letter/jobs?type=email.send&errorPattern=SMTP&minAge=6
```

### 3. Job Detail Inspection

Get detailed information about a specific dead-lettered job:

**Endpoint:** `GET /api/v1/dead-letter/jobs/:id`

**Response:**
```json
{
  "id": "job_1234567890_abc123",
  "type": "webhook.delivery",
  "status": "dead_letter",
  "payload": {
    "url": "https://example.com/webhook",
    "event": "loan.approved",
    "data": { ... }
  },
  "priority": "normal",
  "attempts": 5,
  "maxAttempts": 5,
  "backoffMs": 2000,
  "error": "Connection timeout after 30000ms",
  "createdAt": "2024-11-20T10:00:00Z",
  "updatedAt": "2024-11-20T12:30:00Z",
  "deadLetteredAt": "2024-11-20T12:30:00Z",
  "correlationId": "req_abc123",
  "schemaVersion": "1.0.0"
}
```

### 4. Safe Single Job Retry

Retry a single dead-lettered job with validation and audit logging:

**Endpoint:** `POST /api/v1/dead-letter/jobs/:id/retry`

**Authorization:** Requires `operator` or `admin` role

**Response:**
```json
{
  "success": true,
  "job": {
    "id": "job_1234567890_abc123",
    "status": "pending",
    ...
  },
  "message": "Job job_1234567890_abc123 has been queued for retry"
}
```

**Safeguards:**
- Only retries jobs in `dead_letter` or `failed` status
- Resets attempt counter to 0
- Preserves original correlation ID for tracing
- Logs operator action for audit trail

### 5. Batch Retry Operations

Retry multiple jobs matching specific criteria:

**Endpoint:** `POST /api/v1/dead-letter/batch-retry`

**Authorization:** Requires `operator` or `admin` role

**Request Body:**
```json
{
  "filter": {
    "type": "webhook.delivery",
    "errorPattern": "timeout",
    "minAge": 1,
    "maxAge": 24
  },
  "dryRun": true
}
```

**Response:**
```json
{
  "attempted": 15,
  "succeeded": 14,
  "failed": 1,
  "errors": [
    {
      "jobId": "job_abc123",
      "reason": "Job not found or not in a retryable state"
    }
  ]
}
```

**Dry-Run Mode:**
Set `dryRun: true` to preview which jobs would be retried without actually performing the retry operation. This is recommended before executing large batch operations.

### 6. Purge Old Jobs

Remove old dead-lettered jobs that are beyond recovery:

**Endpoint:** `POST /api/v1/dead-letter/purge`

**Authorization:** Requires `admin` role only

**Request Body:**
```json
{
  "olderThanHours": 168,
  "dryRun": true
}
```

**Constraints:**
- Minimum age: 24 hours (cannot purge recent failures)
- Admin-only operation
- Supports dry-run mode for safety

**Response:**
```json
{
  "purged": 45,
  "dryRun": true
}
```

## Authorization & Security

### Role Requirements

| Endpoint | Required Role | Notes |
|----------|--------------|-------|
| GET /stats | Authenticated | Read-only access |
| GET /jobs | Authenticated | Read-only access |
| GET /jobs/:id | Authenticated | Read-only access |
| POST /jobs/:id/retry | operator, admin | Write operation with audit |
| POST /batch-retry | operator, admin | Write operation with audit |
| POST /purge | admin | Destructive operation |

### Audit Trail

All retry and purge operations are logged with:
- Operator identity (email or user ID)
- Timestamp
- Operation details (job IDs, filters applied)
- Results (success/failure counts)

## Common Use Cases

### 1. Investigate Webhook Failures

```bash
# Get statistics
curl -H "Authorization: Bearer $TOKEN" \
  https://api.trellis.example/api/v1/dead-letter/stats

# List webhook failures with timeout errors
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.trellis.example/api/v1/dead-letter/jobs?type=webhook.delivery&errorPattern=timeout"

# Inspect specific job
curl -H "Authorization: Bearer $TOKEN" \
  https://api.trellis.example/api/v1/dead-letter/jobs/job_1234567890_abc123
```

### 2. Retry After Downstream Service Recovery

```bash
# Dry run first to preview
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"type":"webhook.delivery","minAge":1},"dryRun":true}' \
  https://api.trellis.example/api/v1/dead-letter/batch-retry

# Execute batch retry
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"type":"webhook.delivery","minAge":1},"dryRun":false}' \
  https://api.trellis.example/api/v1/dead-letter/batch-retry
```

### 3. Clean Up Old Failures

```bash
# Purge jobs older than 7 days (168 hours)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"olderThanHours":168,"dryRun":false}' \
  https://api.trellis.example/api/v1/dead-letter/purge
```

## Edge Cases & Recovery

### Edge Case: Job Not Found

If a job ID doesn't exist or is not in the dead-letter queue:

```json
{
  "statusCode": 404,
  "message": "Job not found or not in dead-letter queue"
}
```

**Recovery:** Verify the job ID and check job status using the main workers API (`GET /api/v1/workers/jobs/:id`).

### Edge Case: Job Already Retrying

If a job is already being retried when another retry is requested:

- The service checks the current status before retry
- Returns null if the job is not in a retryable state
- No duplicate retry operations occur

**Recovery:** Wait for the current retry attempt to complete or fail before retrying again.

### Edge Case: Batch Retry Partial Failure

If some jobs in a batch retry fail:

```json
{
  "attempted": 10,
  "succeeded": 7,
  "failed": 3,
  "errors": [
    {"jobId": "job_1", "reason": "Job not found"},
    {"jobId": "job_2", "reason": "Job not in retryable state"},
    {"jobId": "job_3", "reason": "Internal error"}
  ]
}
```

**Recovery:** 
1. Review the errors array to identify problematic jobs
2. Retry successful jobs will proceed normally
3. Investigate failed jobs individually using job detail inspection
4. Retry failed jobs individually after resolving issues

### Edge Case: Correlation ID Preservation

When retrying a job:
- Original correlation ID is preserved for distributed tracing
- Original request trace context is maintained
- This allows end-to-end request tracking even across retries

### Edge Case: Job Age Calculation

Jobs without explicit `deadLetteredAt` timestamp:
- Falls back to `failedAt` timestamp
- Falls back to `updatedAt` timestamp if neither is available
- Age filters may not be precise for older jobs migrated from systems without these fields

## Rollback Behavior

Since retry operations re-queue jobs rather than modify existing state:

**Rollback Strategy:**
1. Monitor the retried jobs' progress
2. If retries continue to fail, cancel them using the job control API
3. Original dead-letter records are preserved until jobs complete successfully
4. No data loss occurs during retry operations

**Manual Rollback:**
If a batch retry causes issues:
1. Cancel active retried jobs: `POST /queue/jobs/:id/cancel`
2. Jobs will return to failed/dead-letter state
3. Investigate root cause before attempting retry again

## Testing

### Unit Tests

Run the dead-letter inspection tests:

```bash
npm test -- dead-letter-inspection.spec.ts
```

### Integration Tests

Test the full workflow:

1. Create jobs that will fail:
```bash
POST /api/v1/workers/jobs
{
  "type": "webhook.delivery",
  "payload": {"url": "https://invalid.example.com/webhook"}
}
```

2. Wait for jobs to fail and move to dead-letter queue

3. Test inspection:
```bash
GET /api/v1/dead-letter/stats
GET /api/v1/dead-letter/jobs
```

4. Test retry:
```bash
POST /api/v1/dead-letter/jobs/:id/retry
```

## Monitoring & Alerts

### Recommended Metrics

- `dead_letter_queue_size`: Total number of dead-lettered jobs
- `dead_letter_age_max`: Age of oldest dead-lettered job in hours
- `dead_letter_retry_success_rate`: Percentage of successful retries
- `dead_letter_by_type`: Count of dead-lettered jobs per job type

### Alert Thresholds

```yaml
alerts:
  - name: DeadLetterQueueGrowing
    condition: dead_letter_queue_size > 100
    severity: warning
    
  - name: OldDeadLetterJobs
    condition: dead_letter_age_max > 168  # 7 days
    severity: info
    
  - name: HighRetryFailureRate
    condition: dead_letter_retry_success_rate < 50
    severity: warning
```

## Migration Plan

This feature is fully backward compatible and requires no migration:

- Existing dead-lettered jobs are automatically visible
- No database schema changes required
- Existing retry mechanism (`POST /api/v1/workers/jobs/:id/retry`) continues to work
- New endpoints provide additional inspection and batch capabilities

## Performance Considerations

### Memory Usage

- Job store is in-memory (Map-based)
- For large deployments (>10,000 dead-letter jobs), consider:
  - Regular purging of old jobs
  - Moving to persistent storage (database)
  - Implementing pagination for list operations

### Query Performance

- Filtering operations scan all dead-letter jobs
- For optimal performance with large queues:
  - Use specific filters (type, error pattern)
  - Limit result sets appropriately
  - Consider indexing if moving to database storage

## Related Documentation

- [Background Workers](../src/infrastructure/workers/README.md) - Core worker framework
- [Job Control API](JOB_CONTROL_API.md) - Job pause/resume/cancel operations
- [Operational Runbook](OPERATIONAL_RUNBOOK.md) - Incident response procedures

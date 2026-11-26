# Worst-Case Load Tests and Resource Budgets

## Overview

This document describes the worst-case load testing framework and resource budgets implemented to ensure the Trellis API maintains predictable performance under extreme conditions.

## Resource Budgets

The following resource budgets are enforced across all code paths:

| Resource | Limit | Rationale |
|----------|-------|-----------|
| Concurrent Requests | 1,000 | Prevents thread pool exhaustion |
| Request Duration | 5,000ms | Prevents hung connections |
| Memory Growth | 100MB | Prevents memory leaks under load |
| Retry Attempts | 3 | Prevents retry storms |
| Auth Validation | 100ms | Maintains request responsiveness |
| Queue Size | 10,000 | Prevents unbounded queue growth |
| Response Size | 1MB | Prevents bandwidth exhaustion |

## Test Coverage

### Normal Operation Tests

**Concurrent Request Handling**
- Tests 1,000 concurrent read requests
- Verifies 95%+ success rate
- Ensures completion within 5 seconds
- Validates memory growth stays under 100MB

**Response Size Limits**
- Enforces 1MB maximum response size
- Validates bulk data queries are bounded
- Prevents bandwidth exhaustion

**Sustained Load Memory Stability**
- Tests memory usage over 5 sample periods
- Validates memory remains stable (no leaks)
- Ensures garbage collection is effective

### Failure Path Tests

**Invalid Request Handling**
- Handles 500 concurrent invalid requests
- Validates resource cleanup on errors
- Ensures memory growth stays bounded

**Rate Limiting**
- Enforces request rate limits per source
- Returns 429 status when exceeded
- Prevents abuse and resource exhaustion

**Oversized Payload Rejection**
- Rejects 10MB+ payloads without processing
- Returns 413 (Payload Too Large) status
- Validates early rejection (before parsing)

**Network Timeout Handling**
- Tests graceful timeout handling
- Ensures no indefinite hangs
- Validates resource cleanup on timeout

### Retry Path Tests

**Retry Budget Enforcement**
- Limits retries to maximum of 3 attempts
- Prevents retry storms on persistent failures
- Validates proper error propagation

**Exponential Backoff**
- Implements exponential backoff on retries
- Each retry delay increases exponentially
- Prevents thundering herd problems

**Non-Retryable Failure Handling**
- Does not retry 4xx client errors
- Distinguishes between transient and permanent failures
- Returns appropriate error responses

**Circuit Breaker**
- Opens circuit after 10 consecutive failures
- Prevents cascading failures
- Implements graceful degradation

### Authorization Path Tests

**Token Validation Performance**
- Validates 1,000 tokens in under 100ms average
- Ensures authentication doesn't bottleneck requests
- Tests various token formats and sizes

**Invalid Token Rejection**
- Rejects invalid tokens quickly (< 200ms)
- Tests injection attacks, oversized tokens
- Validates early rejection without processing

**Concurrent Auth Failure Handling**
- Handles 500 concurrent auth failures
- Validates memory growth stays under 50MB
- Ensures no resource exhaustion on attacks

**Role-Based Access Control**
- Tests RBAC under concurrent load
- Validates proper enforcement of permissions
- Ensures no permission leakage

## Edge Cases and Recovery

### Malformed Request Handling
- Handles binary garbage, malformed JSON
- Returns appropriate 4xx errors
- Never crashes or hangs

### Sensitive Data Protection
- Logs errors without exposing secrets
- Redacts passwords, API keys, tokens
- Validates sanitization under load

### Graceful Degradation
- Continues operation when dependencies fail
- Returns degraded but functional responses
- Maintains core functionality

### Resource Exhaustion Recovery
- Tests recovery after resource exhaustion
- Validates garbage collection effectiveness
- Ensures normal operations resume after load spike

## Verification

All tests are automated and can be executed with:

```bash
npm run test -- src/testing/load/worst-case-load.spec.ts
```

## Monitoring

Resource budgets should be monitored in production:

- **Metrics to track:**
  - Request latency (p50, p95, p99)
  - Memory usage and growth rate
  - Queue depth and overflow rate
  - Retry attempts and circuit breaker state
  - Auth validation duration
  - Rate limit hit rate

- **Alerts:**
  - P50 latency > 500ms
  - P99 latency > 5000ms
  - Memory growth > 50MB/hour
  - Queue overflow rate > 1%
  - Circuit breaker open > 5 minutes
  - Auth validation > 100ms average

## Rollback Plan

If resource budgets are exceeded in production:

1. **Immediate Actions:**
   - Enable rate limiting at load balancer
   - Increase instance count (horizontal scaling)
   - Enable circuit breakers for failing dependencies

2. **Investigation:**
   - Check metrics dashboard for anomalies
   - Review recent deployments
   - Examine error logs for patterns

3. **Rollback Procedure:**
   - Revert to last known good version
   - Restore from configuration backup
   - Validate resource usage returns to normal

4. **Post-Incident:**
   - Perform root cause analysis
   - Update resource budgets if needed
   - Add new test cases for discovered scenarios

## Migration Plan

No database migrations required. This feature adds test coverage and documentation only.

## Security Considerations

- Tests validate injection attack resistance
- Ensures sensitive data is never logged
- Validates auth bypass attempts fail
- Tests DoS attack resistance

## Performance Impact

Load tests should run in isolated test environments only. Do not run against production.

## Dependencies

- Jest testing framework
- Supertest for HTTP testing
- NestJS testing utilities

## Future Improvements

1. Add distributed load testing capability
2. Implement chaos engineering tests
3. Add database query performance budgets
4. Test WebSocket connection limits
5. Add cache invalidation storm tests

# Dependency-Aware Public Health Status

## Overview

The dependency-aware health system provides intelligent health monitoring that understands dependency relationships, criticality levels, and cascading failures. It enables informed decision-making about system availability, traffic acceptance, and operational interventions.

## Architecture

### Key Concepts

1. **Dependency Classification**
   - **Critical**: System cannot operate without it (e.g., database)
   - **Optional**: System can degrade gracefully without it (e.g., cache)
   - **Degraded-OK**: Acceptable in degraded state (e.g., analytics)

2. **Health States**
   - **Healthy**: All checks passing, normal operation
   - **Degraded**: Some optional dependencies failing, reduced functionality
   - **Unhealthy**: Critical dependencies failing, cannot accept traffic
   - **Unknown**: Health check not yet performed

3. **Circuit Breaker Pattern**
   - Opens after N consecutive failures
   - Prevents cascading failures
   - Auto-resets after cooldown period

4. **Health Score**
   - 0-100 score based on healthy dependencies
   - Penalizes critical failures heavily
   - Informs load balancer decisions

## Usage

### Registering Dependencies

```typescript
import {
  DependencyAwareHealthService,
  DependencyType,
  Criticality,
  DependencyStatus,
} from './dependency-aware-health.service';

constructor(private healthService: DependencyAwareHealthService) {
  this.registerDependencies();
}

private registerDependencies() {
  // Critical database
  this.healthService.registerDependency({
    name: 'postgresql',
    type: DependencyType.DATABASE,
    criticality: Criticality.CRITICAL,
    timeout: 5000,
    retryAttempts: 2,
    circuitBreakerThreshold: 5,
    healthCheckFn: async () => {
      try {
        await this.dataSource.query('SELECT 1');
        return {
          status: DependencyStatus.HEALTHY,
          responseTime: Date.now() - start,
        };
      } catch (error) {
        throw error;
      }
    },
  });

  // Optional cache
  this.healthService.registerDependency({
    name: 'redis',
    type: DependencyType.CACHE,
    criticality: Criticality.OPTIONAL,
    timeout: 3000,
    retryAttempts: 1,
    circuitBreakerThreshold: 3,
    healthCheckFn: async () => {
      await this.redis.ping();
      return { status: DependencyStatus.HEALTHY };
    },
  });

  // External API
  this.healthService.registerDependency({
    name: 'payment-gateway',
    type: DependencyType.PAYMENT_GATEWAY,
    criticality: Criticality.CRITICAL,
    timeout: 10000,
    retryAttempts: 3,
    circuitBreakerThreshold: 5,
    healthCheckFn: async () => {
      const response = await axios.get('https://api.stripe.com/v1/health');
      return {
        status: DependencyStatus.HEALTHY,
        responseTime: response.headers['x-response-time'],
      };
    },
  });
}
```

### Getting System Health

```typescript
async getHealth() {
  const health = await this.healthService.getSystemHealth();
  
  if (!health.canAcceptTraffic) {
    throw new ServiceUnavailableException(
      'System cannot accept traffic due to critical failures'
    );
  }
  
  return {
    status: health.overall,
    score: health.score,
    timestamp: health.timestamp,
    // Public view - no sensitive details
  };
}
```

### Authorization-Aware Health

```typescript
async canPerformAuthorization(): Promise<boolean> {
  return this.healthService.canAuthorizeRequests();
}

// Use in guard
@Injectable()
export class HealthAwareAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const canAuth = await this.healthService.canAuthorizeRequests();
    
    if (!canAuth) {
      throw new ServiceUnavailableException(
        'Authentication service temporarily unavailable'
      );
    }
    
    // Proceed with auth
    return true;
  }
}
```

### Load Balancer Integration

```typescript
@Controller('health')
export class HealthController {
  @Get('liveness')
  getLiveness() {
    // Always return 200 - process is alive
    return { status: 'ok' };
  }

  @Get('readiness')
  async getReadiness() {
    const health = await this.healthService.getSystemHealth();
    
    if (!health.canAcceptTraffic) {
      throw new ServiceUnavailableException();
    }
    
    return {
      status: health.overall,
      score: health.score,
    };
  }

  @Get('startup')
  async getStartup() {
    const health = await this.healthService.getSystemHealth();
    
    // Startup probe succeeds when critical deps are up
    if (health.criticalFailures.length > 0) {
      throw new ServiceUnavailableException();
    }
    
    return { status: 'ready' };
  }
}
```

### Circuit Breaker Management

```typescript
// Monitor circuit breakers
const metrics = this.healthService.getMetrics();

if (metrics.circuitBreakersOpen > 0) {
  this.logger.warn(`${metrics.circuitBreakersOpen} circuit breakers open`);
  
  // Get details
  const dependencies = this.healthService.listDependencies();
  const openBreakers = dependencies.filter(d => d.circuitBreakerOpen);
  
  for (const dep of openBreakers) {
    this.logger.warn(
      `Circuit breaker open for ${dep.name}: ${dep.recoveryGuidance}`
    );
  }
}

// Manual reset after fixing issue
this.healthService.resetCircuitBreakerManually('postgresql');
```

## Test Coverage

### Normal Operations

✅ **Dependency Registration**
- Registers dependencies with configuration
- Initializes state tracking
- Validates configuration

✅ **Healthy Checks**
- Executes health check functions
- Records response times
- Updates dependency state

✅ **System Health Calculation**
- Aggregates dependency states
- Calculates health score
- Determines traffic acceptance

✅ **Metrics Tracking**
- Counts dependencies by status
- Calculates average response time
- Tracks circuit breaker state

✅ **Dependency Listing**
- Lists all registered dependencies
- Provides current state
- Includes metadata

### Failure Scenarios

✅ **Unhealthy Dependencies**
- Marks dependency as unhealthy
- Records error message
- Increments failure counter

✅ **Critical Failures**
- Marks system as unhealthy
- Prevents traffic acceptance
- Requires admin intervention

✅ **Optional Failures**
- Marks system as degraded
- Allows traffic with reduced functionality
- Tracks degradation reasons

✅ **Timeouts**
- Handles slow health checks
- Marks as unhealthy on timeout
- Configurable timeout per dependency

✅ **Consecutive Failures**
- Tracks failure streak
- Triggers circuit breaker
- Provides recovery guidance

✅ **Recovery Guidance**
- Type-specific guidance
- Actionable recommendations
- Available when unhealthy

### Retry Logic

✅ **Transient Failure Recovery**
- Retries configured number of times
- Uses exponential backoff
- Succeeds after retries

✅ **Retry Exhaustion**
- Fails after max retries
- Counts total attempts
- Marks as unhealthy

✅ **Failure Reset**
- Resets counter on success
- Clears circuit breaker
- Restores healthy state

### Circuit Breaker

✅ **Threshold Detection**
- Opens after N failures
- Tracks open circuit breakers
- Updates metrics

✅ **Request Prevention**
- Skips health checks when open
- Returns circuit breaker status
- Prevents cascading load

✅ **Manual Reset**
- Operator can force reset
- Clears failure counter
- Closes circuit breaker

### Authorization Checks

✅ **Healthy Authorization**
- Allows when auth service up
- Allows when database up
- Returns true for requests

✅ **Auth Service Failure**
- Prevents authorization
- Returns false
- Protects auth integrity

✅ **Database Failure**
- Prevents authorization
- Returns false
- User data unavailable

### Cascading Failures

✅ **Background Job Impact**
- Detects queue failures
- Blocks job processing
- Prevents work loss

✅ **Multiple Failures**
- Reduces health score
- Marks as unhealthy
- Lists all failures

### Edge Cases

✅ **Non-existent Dependency**
- Returns null gracefully
- Logs warning
- Doesn't crash

✅ **No Dependencies**
- Returns healthy status
- Score of 100
- Empty dependency list

✅ **Degraded Status**
- Handles explicit degraded state
- Records degradation message
- Updates system state

## Dependency Types

### DATABASE
Primary data store requiring high availability.

**Configuration:**
```typescript
{
  type: DependencyType.DATABASE,
  criticality: Criticality.CRITICAL,
  timeout: 5000,
  retryAttempts: 2,
  circuitBreakerThreshold: 5,
}
```

**Recovery Guidance:**
- Check database connection string
- Verify credentials
- Ensure database server is running
- Check network connectivity

### CACHE
Performance optimization layer, can degrade gracefully.

**Configuration:**
```typescript
{
  type: DependencyType.CACHE,
  criticality: Criticality.OPTIONAL,
  timeout: 3000,
  retryAttempts: 1,
  circuitBreakerThreshold: 3,
}
```

**Recovery Guidance:**
- Verify Redis/Memcached is running
- Check connection configuration
- Monitor cache server resources

### EXTERNAL_API
Third-party service integration.

**Configuration:**
```typescript
{
  type: DependencyType.EXTERNAL_API,
  criticality: Criticality.CRITICAL, // or OPTIONAL
  timeout: 10000,
  retryAttempts: 3,
  circuitBreakerThreshold: 5,
}
```

**Recovery Guidance:**
- Check network connectivity
- Verify API credentials
- Review external service status page
- Check rate limits

### MESSAGE_QUEUE
Asynchronous job processing.

**Configuration:**
```typescript
{
  type: DependencyType.MESSAGE_QUEUE,
  criticality: Criticality.CRITICAL,
  timeout: 5000,
  retryAttempts: 2,
  circuitBreakerThreshold: 5,
}
```

**Recovery Guidance:**
- Verify queue service is running
- Check connection configuration
- Monitor queue depth
- Review worker status

### AUTH_SERVICE
Authentication and authorization.

**Configuration:**
```typescript
{
  type: DependencyType.AUTH_SERVICE,
  criticality: Criticality.CRITICAL,
  timeout: 5000,
  retryAttempts: 2,
  circuitBreakerThreshold: 5,
}
```

**Recovery Guidance:**
- Verify auth service is running
- Check credentials and keys
- Review auth service logs
- Validate configuration

### PAYMENT_GATEWAY
Payment processing integration.

**Configuration:**
```typescript
{
  type: DependencyType.PAYMENT_GATEWAY,
  criticality: Criticality.CRITICAL,
  timeout: 10000,
  retryAttempts: 3,
  circuitBreakerThreshold: 5,
}
```

**Recovery Guidance:**
- Check gateway credentials
- Review service status page
- Verify webhook configuration
- Contact gateway support

## Monitoring and Alerts

### Health Score Alerts

```typescript
const health = await healthService.getSystemHealth();

if (health.score < 50) {
  alert('CRITICAL: Health score below 50%');
} else if (health.score < 80) {
  alert('WARNING: Health score below 80%');
}
```

### Circuit Breaker Alerts

```typescript
const metrics = healthService.getMetrics();

if (metrics.circuitBreakersOpen > 0) {
  alert(`${metrics.circuitBreakersOpen} circuit breakers open`);
}
```

### Response Time Monitoring

```typescript
const metrics = healthService.getMetrics();

if (metrics.averageResponseTime > 5000) {
  alert('Health checks are slow (>5s average)');
}
```

### Critical Failure Alerts

```typescript
const health = await healthService.getSystemHealth();

if (health.criticalFailures.length > 0) {
  alert('CRITICAL: System has critical failures', {
    failures: health.criticalFailures,
    requiresIntervention: health.requiresAdminIntervention,
  });
}
```

## Best Practices

### Dependency Configuration

1. **Critical Dependencies**: Set lower retry counts and higher circuit breaker thresholds
2. **Optional Dependencies**: Use aggressive circuit breakers to fail fast
3. **Timeout Values**: Set based on p99 latency, not average
4. **Retry Strategy**: Use exponential backoff to avoid thundering herd

### Health Check Implementation

```typescript
// Good: Fast, focused check
healthCheckFn: async () => {
  await db.query('SELECT 1');
  return { status: DependencyStatus.HEALTHY };
}

// Bad: Slow, complex check
healthCheckFn: async () => {
  await db.query('SELECT COUNT(*) FROM users'); // Expensive!
  return { status: DependencyStatus.HEALTHY };
}
```

### Error Handling

```typescript
healthCheckFn: async () => {
  try {
    await externalApi.ping();
    return { status: DependencyStatus.HEALTHY };
  } catch (error) {
    // Don't expose internal details in message
    throw new Error('External API unavailable');
  }
}
```

## Migration Plan

No database migrations required. Integration steps:

1. Add DependencyAwareHealthService to health module
2. Register dependencies in `onModuleInit`
3. Update health endpoints to use dependency-aware checks
4. Configure monitoring and alerts
5. Update runbooks with recovery procedures

## Security Considerations

1. **Error Messages**: Don't expose connection strings or credentials
2. **Public Endpoints**: Only expose sanitized health status
3. **Admin Endpoints**: Require authentication for detailed health
4. **Circuit Breakers**: Prevent DoS via health check abuse

## Performance Impact

- **Health Check**: O(1) per dependency
- **System Health**: O(n) for n dependencies
- **Memory**: Minimal state per dependency
- **Concurrency**: Checks run in parallel

## Dependencies

- NestJS framework
- TypeScript
- Existing health infrastructure

## Future Improvements

1. Persistent health history
2. Anomaly detection (ML-based)
3. Predictive failure alerts
4. Auto-scaling integration
5. Multi-region health aggregation

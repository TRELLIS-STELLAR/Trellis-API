# Problem Details Exception Filter

## Quick Start

### 1. Register Filter Globally

```typescript
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './problem-details.filter';

@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: ProblemDetailsFilter,
    },
  ],
})
export class AppModule {}
```

### 2. Throw Exceptions with Context

```typescript
import { ErrorCode } from '../errors/error-codes';

// Custom exception
class OwnershipException extends Error {
  constructor(
    message: string,
    public errorCode: ErrorCode,
    public statusCode: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

// Usage
throw new OwnershipException(
  'Transfer has expired',
  ErrorCode.PRECONDITION_FAILED,
  412,
  { transferId: 'ot-123', expiresAt: '2024-01-15T10:00:00Z' }
);
```

### 3. Client Response

```json
{
  "type": "https://trellis-stellar.github.io/Trellis-API/problems/PRECONDITION_FAILED",
  "title": "Precondition failed",
  "status": 412,
  "detail": "Transfer has expired",
  "instance": "/api/ownership/transfers/ot-123/accept",
  "remediation": "The resource state changed or prerequisites were not met. Refresh resource state and retry.",
  "errorCode": "PRECONDITION_FAILED",
  "domain": "validation",
  "retryable": false,
  "correlationId": "req_1234567890_abc123",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Features

### Automatic Error Classification

- **Retryable errors**: Include `retryable: true` and `retryAfterSeconds`
- **Non-retryable errors**: Include remediation guidance
- **Domain classification**: Groups errors by subsystem

### Correlation ID Tracking

Automatically extracts or generates correlation IDs:

```typescript
// From request headers
X-Correlation-Id: abc-123
X-Request-Id: xyz-789
X-Trace-Id: trace-456

// Auto-generated if missing
req_1234567890_abc123
```

### Production Sanitization

Internal error details are hidden in production:

```typescript
// Development
{
  "detail": "QueryFailedError: duplicate key value violates unique constraint \"users_email_key\""
}

// Production
{
  "detail": "Resource with this identifier already exists"
}
```

## Error Domains

- `auth` - Authentication and authorization
- `validation` - Request validation
- `settlement` - Stellar payment settlement
- `payment` - Payment processing
- `reconciliation` - Transaction reconciliation
- `blockchain` - Blockchain/Horizon communication
- `portfolio` - Portfolio management
- `rate_limit` - Rate limiting
- `quota` - Quota management
- `system` - Generic system errors

## Client Integration

### TypeScript/JavaScript

```typescript
interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string | object;
  instance: string;
  remediation: string;
  errorCode: string;
  domain: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  correlationId: string;
  timestamp: string;
}

async function handleError(error: AxiosError) {
  const problem = error.response?.data as ProblemDetails;
  
  if (problem.retryable && problem.retryAfterSeconds) {
    console.log(`Retrying after ${problem.retryAfterSeconds} seconds...`);
    await sleep(problem.retryAfterSeconds * 1000);
    return retry();
  }
  
  console.error(`Error ${problem.errorCode}: ${problem.detail}`);
  console.error(`Remediation: ${problem.remediation}`);
  console.error(`Correlation ID: ${problem.correlationId}`);
}
```

### Python

```python
import requests
from typing import Optional

class ProblemDetails:
    def __init__(self, response_data: dict):
        self.type = response_data['type']
        self.title = response_data['title']
        self.status = response_data['status']
        self.detail = response_data['detail']
        self.error_code = response_data['errorCode']
        self.retryable = response_data['retryable']
        self.retry_after_seconds = response_data.get('retryAfterSeconds')
        self.remediation = response_data['remediation']
        self.correlation_id = response_data['correlationId']

def handle_error(error: requests.HTTPError):
    problem = ProblemDetails(error.response.json())
    
    if problem.retryable and problem.retry_after_seconds:
        print(f"Retrying after {problem.retry_after_seconds} seconds...")
        time.sleep(problem.retry_after_seconds)
        return retry()
    
    print(f"Error {problem.error_code}: {problem.detail}")
    print(f"Remediation: {problem.remediation}")
    print(f"Correlation ID: {problem.correlation_id}")
```

## Monitoring

Track error metrics:

```typescript
import { Counter } from 'prom-client';

const errorCounter = new Counter({
  name: 'api_errors_total',
  help: 'Total API errors',
  labelNames: ['error_code', 'domain', 'retryable', 'status'],
});

// In ProblemDetailsFilter
errorCounter.inc({
  error_code: mapped.errorCode,
  domain: taxonomy.domain,
  retryable: taxonomy.retryable.toString(),
  status: mapped.status.toString(),
});
```

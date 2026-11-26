# Critical Workflows - Synthetic Monitoring

## Quick Start

```typescript
import { CriticalWorkflowsService } from './critical-workflows';
import { SyntheticMonitoringService } from '../synthetic-monitoring.service';

// Setup
const workflowService = new CriticalWorkflowsService({
  httpClient: axiosHttpClient,
  config: {
    apiBaseUrl: 'https://api.trellis.example',
    testUserToken: process.env.SYNTHETIC_USER_TOKEN,
    testAdminToken: process.env.SYNTHETIC_ADMIN_TOKEN,
  },
});

const monitoringService = new SyntheticMonitoringService();

// Register all workflows
workflowService.getAllJourneys().forEach(journey => {
  monitoringService.register(journey);
});

// Run all workflows
const results = await monitoringService.runAll();

// Check results
results.forEach(result => {
  if (!result.passed) {
    console.error(`❌ ${result.journeyName} FAILED`);
    result.steps
      .filter(s => s.status === 'fail')
      .forEach(step => {
        console.error(`   Step: ${step.name}`);
        console.error(`   Error: ${step.error}`);
      });
  } else {
    console.log(`✅ ${result.journeyName} passed (${result.totalDurationMs}ms)`);
  }
});
```

## Workflows

### 1. User Authentication Flow
Tests the complete authentication lifecycle including login, token validation, and protected endpoint access.

### 2. Portfolio Management Flow
Tests portfolio CRUD operations, authorization checks, and error handling.

### 3. Payment Settlement Flow
Tests invoice creation, payment validation, and error scenarios (insufficient funds, invalid addresses).

### 4. Ownership Transfer Flow
Tests the two-step ownership transfer process with authorization enforcement.

## Configuration

Required environment variables:
- `SYNTHETIC_USER_TOKEN`: Valid user token for authenticated requests
- `SYNTHETIC_ADMIN_TOKEN`: Valid admin token for privileged operations
- `SYNTHETIC_API_BASE_URL`: Base URL of the API to test

## Scheduling

Run synthetic checks periodically:

```typescript
import { Cron } from '@nestjs/schedule';

@Injectable()
export class SyntheticScheduler {
  @Cron('*/5 * * * *') // Every 5 minutes
  async runChecks() {
    const results = await this.monitoringService.runAll();
    await this.publishMetrics(results);
    await this.alertOnFailures(results);
  }
}
```

## Alerting

```typescript
async alertOnFailures(results: JourneyResult[]) {
  const failures = results.filter(r => !r.passed);
  
  if (failures.length > 0) {
    await sendAlert({
      severity: 'critical',
      title: `${failures.length} synthetic journey(s) failed`,
      journeys: failures.map(f => ({
        name: f.journeyName,
        failedSteps: f.steps.filter(s => s.status === 'fail'),
      })),
    });
  }
}
```

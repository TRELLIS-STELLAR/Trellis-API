# Ownership Transfer Service

## Quick Start

```typescript
import { OwnershipTransferService } from './ownership-transfer.service';

// 1. Initiate transfer (by current owner)
const transfer = await ownershipTransferService.initiateTransfer({
  resourceType: 'portfolio',
  resourceId: 'port-123',
  currentOwnerId: 'user-1',
  proposedOwnerId: 'user-2',
  expiresInHours: 72,
  idempotencyKey: 'unique-request-id', // Optional
});

// 2. Accept transfer (by proposed owner)
const accepted = await ownershipTransferService.acceptTransfer(
  transfer.id,
  'user-2'
);

// 3. Or cancel (by current owner)
const cancelled = await ownershipTransferService.cancelTransfer(
  transfer.id,
  'user-1',
  'Changed mind'
);

// 4. Or reject (by proposed owner)
const rejected = await ownershipTransferService.rejectTransfer(
  transfer.id,
  'user-2',
  'Not interested'
);
```

## Workflow States

```
PENDING ──┬──> ACCEPTED (by proposed owner)
          ├──> CANCELLED (by current owner)
          ├──> REJECTED (by proposed owner)
          └──> EXPIRED (automatic)
```

## Authorization Matrix

| Action   | Current Owner | Proposed Owner | Other |
|----------|---------------|----------------|-------|
| Initiate | ✅            | ❌             | ❌    |
| Accept   | ❌            | ✅             | ❌    |
| Cancel   | ✅            | ❌             | ❌    |
| Reject   | ❌            | ✅             | ❌    |
| Read     | ✅            | ✅             | ❌    |

## Expiry Handling

### Lazy Expiry (on read)

```typescript
const transfer = await ownershipTransferService.getTransfer('ot-123');
// If expired, status automatically changes to EXPIRED
```

### Batch Expiry (scheduled)

```typescript
import { Cron } from '@nestjs/schedule';

@Injectable()
export class OwnershipExpiryScheduler {
  @Cron('0 * * * *') // Every hour
  async expireTransfers() {
    const count = await this.ownershipTransferService.expirePendingTransfers();
    this.logger.log(`Expired ${count} pending transfer(s)`);
  }
}
```

## Idempotency

Prevent duplicate transfers:

```typescript
// First call
const t1 = await service.initiateTransfer({
  resourceType: 'portfolio',
  resourceId: 'port-123',
  currentOwnerId: 'user-1',
  proposedOwnerId: 'user-2',
  idempotencyKey: 'request-abc-123',
});

// Retry with same key returns existing transfer
const t2 = await service.initiateTransfer({
  resourceType: 'portfolio',
  resourceId: 'port-123',
  currentOwnerId: 'user-1',
  proposedOwnerId: 'user-2',
  idempotencyKey: 'request-abc-123',
});

// t1.id === t2.id (same transfer)
```

## Audit Trail

Retrieve complete audit history:

```typescript
const history = await ownershipTransferService.getAuditHistory(
  'ot-123',
  'user-1' // Optional: enforces authorization
);

// Returns chronological events:
[
  {
    id: 'audit-1',
    transferId: 'ot-123',
    action: 'INITIATED',
    actorId: 'user-1',
    fromStatus: null,
    toStatus: 'PENDING',
    occurredAt: '2024-01-15T10:00:00Z',
  },
  {
    id: 'audit-2',
    transferId: 'ot-123',
    action: 'ACCEPTED',
    actorId: 'user-2',
    fromStatus: 'PENDING',
    toStatus: 'ACCEPTED',
    occurredAt: '2024-01-15T11:30:00Z',
  },
]
```

## List Transfers

```typescript
// All transfers (incoming + outgoing)
const all = await ownershipTransferService.listTransfers('user-1', 'all');

// Only incoming transfers (where user is proposed owner)
const incoming = await ownershipTransferService.listTransfers('user-1', 'incoming');

// Only outgoing transfers (where user is current owner)
const outgoing = await ownershipTransferService.listTransfers('user-1', 'outgoing');
```

## Error Handling

```typescript
try {
  await ownershipTransferService.acceptTransfer('ot-123', 'user-3');
} catch (error) {
  if (error instanceof ForbiddenException) {
    // Only proposed owner can accept
    console.error('Unauthorized access attempt');
  } else if (error instanceof BadRequestException) {
    // Invalid state (expired, cancelled, already accepted)
    console.error('Cannot accept transfer in current state');
  }
}
```

## Database Migration

```bash
# Generate migration
npm run migration:generate -- -n CreateOwnershipTransferTables

# Run migration
npm run migration:run

# Revert if needed
npm run migration:revert
```

## API Integration

```typescript
import { Controller, Post, Param, Body, Get, Patch } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('ownership/transfers')
export class OwnershipTransferController {
  constructor(
    private readonly ownershipTransferService: OwnershipTransferService,
  ) {}

  @Post()
  async initiate(
    @Body() dto: InitiateTransferDto,
    @CurrentUser() user: User,
  ) {
    return this.ownershipTransferService.initiateTransfer({
      ...dto,
      currentOwnerId: user.id,
    });
  }

  @Patch(':id/accept')
  async accept(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ) {
    return this.ownershipTransferService.acceptTransfer(id, user.id);
  }

  @Patch(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body() dto: { reason?: string },
    @CurrentUser() user: User,
  ) {
    return this.ownershipTransferService.cancelTransfer(
      id,
      user.id,
      dto.reason,
    );
  }

  @Patch(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: { reason?: string },
    @CurrentUser() user: User,
  ) {
    return this.ownershipTransferService.rejectTransfer(
      id,
      user.id,
      dto.reason,
    );
  }

  @Get(':id')
  async getTransfer(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ) {
    return this.ownershipTransferService.getTransfer(id, user.id);
  }

  @Get(':id/audit')
  async getAuditHistory(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ) {
    return this.ownershipTransferService.getAuditHistory(id, user.id);
  }

  @Get()
  async listTransfers(
    @Query('direction') direction: 'incoming' | 'outgoing' | 'all',
    @CurrentUser() user: User,
  ) {
    return this.ownershipTransferService.listTransfers(
      user.id,
      direction || 'all',
    );
  }
}
```

## Monitoring

```typescript
import { Counter, Histogram } from 'prom-client';

const transferCounter = new Counter({
  name: 'ownership_transfers_total',
  help: 'Total ownership transfers',
  labelNames: ['status', 'resource_type'],
});

const transferDuration = new Histogram({
  name: 'ownership_transfer_duration_hours',
  help: 'Time from initiation to acceptance',
  buckets: [1, 6, 12, 24, 48, 72],
});
```

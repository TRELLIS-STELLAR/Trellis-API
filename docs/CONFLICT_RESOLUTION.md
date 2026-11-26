## Conflict Resolution for Concurrent Edits

## Overview

The conflict resolution system provides comprehensive tooling for handling concurrent edits to shared resources. It supports multiple resolution strategies, automatic conflict detection, and provides detailed audit trails for all edit attempts.

## Features

### Conflict Detection

The system detects conflicts using optimistic concurrency control with version numbers:

1. Each resource has a `version` field that increments with every edit
2. Clients read a resource and its version
3. When submitting edits, clients include the version they read
4. The system detects conflicts when the base version doesn't match the current version

### Resolution Strategies

#### 1. Three-Way Merge (Default)

Intelligently merges changes from both sides when possible:

```typescript
// Base state (version 0)
{ title: "Original", content: "Original", tags: [] }

// User A's edit (version 1)
{ title: "Updated by A", content: "Original", tags: [] }

// User B's edit (based on version 0)
{ title: "Original", content: "Updated by B", tags: ["new"] }

// Merged result (version 2)
{ title: "Updated by A", content: "Updated by B", tags: ["new"] }
```

**When to use:**
- Collaborative document editing
- Configuration updates by multiple admins
- Portfolio rebalancing with concurrent trades

**Behavior:**
- ✅ Auto-merges non-overlapping field changes
- ⚠️ Reports conflicts when same field edited by both users
- 🔄 Requires manual resolution for conflicts

#### 2. Last Write Wins

Always accepts the most recent edit, overwriting previous changes:

```typescript
// Current state (version 2)
{ title: "Edit by User A", content: "Content A" }

// User B's edit (based on version 0) - applied with last-write-wins
{ title: "Edit by User B", content: "Content B" }

// Result (version 3) - User A's changes lost
{ title: "Edit by User B", content: "Content B" }
```

**When to use:**
- Real-time collaborative whiteboards
- Live cursors/presence indicators
- Non-critical metadata updates

**Tradeoffs:**
- ✅ Never blocks edits
- ❌ Can lose work
- ⚠️ Use only for non-critical data

#### 3. First Write Wins

Rejects concurrent edits, preserving the first modification:

```typescript
// Current state (version 2)
{ title: "Edit by User A" }

// User B's edit (based on version 0) - rejected
{ title: "Edit by User B" }

// Result - User A's edit preserved, User B must retry
{ title: "Edit by User A" }
```

**When to use:**
- Financial transactions (prevent double-spend)
- Limited inventory allocation
- Exclusive resource locks

**Behavior:**
- ✅ Prevents lost updates
- ❌ Requires manual retry
- 🔒 Pessimistic approach

#### 4. Manual Resolution

Always requires explicit user intervention for conflicts:

```typescript
// Conflict detected
{
  success: false,
  requiresManualResolution: true,
  message: "Concurrent modification detected",
  data: { /* current state */ },
  version: 2
}
```

**When to use:**
- Critical configuration changes
- Legal document edits
- When automatic resolution is too risky

## API Endpoints

### Create Resource

Initialize a new editable resource:

```bash
POST /api/v1/conflicts/resource/:type/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "My Document",
  "content": "Initial content"
}

# Response: 201 Created
{
  "resourceType": "document",
  "resourceId": "doc1",
  "data": {
    "title": "My Document",
    "content": "Initial content",
    "version": 0,
    "createdBy": "user_123",
    "createdAt": "2024-11-22T10:00:00Z"
  },
  "version": 0
}
```

### Get Resource

Retrieve current resource state:

```bash
GET /api/v1/conflicts/resource/:type/:id
Authorization: Bearer <token>

# Response: 200 OK
{
  "resourceType": "document",
  "resourceId": "doc1",
  "data": {
    "title": "My Document",
    "content": "Initial content",
    "version": 2
  },
  "version": 2
}
```

### Resolve Edit

Apply an edit with conflict resolution:

```bash
POST /api/v1/conflicts/resolve
Authorization: Bearer <token>
Content-Type: application/json

{
  "resourceId": "doc1",
  "resourceType": "document",
  "baseVersion": 2,
  "proposedData": {
    "title": "Updated Title",
    "content": "Updated content"
  },
  "strategy": "three_way_merge"
}

# Success Response: 200 OK
{
  "success": true,
  "data": {
    "title": "Updated Title",
    "content": "Updated content",
    "version": 3
  },
  "version": 3,
  "strategy": "three_way_merge",
  "requiresManualResolution": false,
  "message": "Edit applied successfully"
}

# Conflict Response: 409 Conflict
{
  "statusCode": 409,
  "message": "Conflicts detected in fields: title",
  "data": {
    "title": "Current Title",
    "content": "Current content",
    "version": 3
  },
  "version": 3,
  "conflicts": [
    {
      "field": "title",
      "base": "Original",
      "current": "Current Title",
      "proposed": "Updated Title"
    }
  ],
  "strategy": "three_way_merge"
}
```

### Get Statistics

Retrieve conflict resolution metrics:

```bash
GET /api/v1/conflicts/statistics?resourceType=document
Authorization: Bearer <token>

# Response: 200 OK
{
  "total": 150,
  "byOutcome": {
    "success": 120,
    "conflict": 20,
    "rejected": 8,
    "retry": 2
  },
  "byStrategy": {
    "three_way_merge": 100,
    "last_write_wins": 30,
    "first_write_wins": 15,
    "manual": 5
  },
  "conflictRate": 13.33,
  "successRate": 80.00,
  "recentAttempts": [...]
}
```

## Usage Examples

### Example 1: Collaborative Document Editing

```typescript
// Client reads document
const doc = await fetch("/api/v1/conflicts/resource/document/doc1");
const { data, version } = await doc.json();

// User edits locally
const edited = { ...data, title: "New Title" };

// Submit edit with version
const result = await fetch("/api/v1/conflicts/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    resourceId: "doc1",
    resourceType: "document",
    baseVersion: version,
    proposedData: edited,
    strategy: "three_way_merge"
  })
});

if (result.status === 409) {
  // Conflict detected - show merge UI
  const conflict = await result.json();
  showConflictResolutionUI(conflict);
} else {
  // Success - update local state
  const updated = await result.json();
  updateUI(updated.data);
}
```

### Example 2: Portfolio Rebalancing

```typescript
async function rebalancePortfolio(portfolioId: string, newAllocations: any) {
  // Read current portfolio
  const current = await getPortfolio(portfolioId);
  
  try {
    const result = await fetch("/api/v1/conflicts/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceId: portfolioId,
        resourceType: "portfolio",
        baseVersion: current.version,
        proposedData: {
          ...current.data,
          allocations: newAllocations
        },
        strategy: "first_write_wins" // Prevent double-rebalancing
      })
    });

    if (!result.ok) {
      // Another rebalance already in progress
      throw new Error("Portfolio was modified by another operation");
    }

    return await result.json();
  } catch (error) {
    // Retry with latest state
    console.error("Rebalance conflict:", error);
    throw error;
  }
}
```

### Example 3: Real-Time Collaboration

```typescript
// Using last-write-wins for cursor positions
async function updateCursorPosition(docId: string, position: any) {
  const doc = await getDocument(docId);
  
  await fetch("/api/v1/conflicts/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resourceId: docId,
      resourceType: "document",
      baseVersion: doc.version,
      proposedData: {
        ...doc.data,
        cursorPosition: position
      },
      strategy: "last_write_wins" // Always use latest cursor
    })
  });
}
```

## Edge Cases and Recovery

### Edge Case: Stale Version After Long Idle Time

**Scenario:** User leaves browser tab open overnight, then tries to edit.

**Handling:**
```typescript
// Detect stale version
if (conflict.message.includes("modified by another user")) {
  // Show refresh prompt
  const shouldRefresh = confirm("Document was updated. Reload to see changes?");
  
  if (shouldRefresh) {
    const latest = await getDocument(docId);
    // Optionally: attempt to merge user's local changes
    const merged = tryLocalMerge(userEdits, latest.data);
    showDocument(merged);
  }
}
```

### Edge Case: Network Failure During Edit

**Scenario:** Request sent but no response received.

**Recovery:**
```typescript
async function reliableEdit(resource: any, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await submitEdit(resource);
      return result;
    } catch (error) {
      if (attempt === retries - 1) throw error;
      
      // Refresh version before retry
      const latest = await getResource(resource.id);
      resource.baseVersion = latest.version;
      
      await sleep(1000 * Math.pow(2, attempt)); // Exponential backoff
    }
  }
}
```

### Edge Case: Simultaneous Saves

**Scenario:** Two users save at exact same time with same base version.

**Behavior:**
- One request processes first (wins)
- Second request detects conflict
- System ensures consistency via version check

**Recovery:**
```typescript
// Auto-retry with three-way merge
async function saveWithRetry(doc: any, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await submitEdit(doc, "three_way_merge");
    } catch (conflict) {
      if (i === maxRetries - 1) {
        // Manual resolution required
        return showConflictUI(conflict);
      }
      
      // Refresh and retry
      const latest = await getDocument(doc.id);
      doc.baseVersion = latest.version;
    }
  }
}
```

### Edge Case: Conflict in Deleted Resource

**Scenario:** User A deletes resource while User B is editing.

**Handling:**
```typescript
try {
  await submitEdit(doc);
} catch (error) {
  if (error.status === 404) {
    alert("This document was deleted. Your changes cannot be saved.");
    redirectToDocumentList();
  }
}
```

## Rollback Behavior

### Automatic Rollback

Conflicts do NOT modify the resource - the current state is preserved:

```typescript
// Current state (version 2)
{ title: "Current", content: "Current" }

// Conflicting edit rejected
// State remains unchanged at version 2
```

### Manual Rollback

To rollback to a previous version:

```typescript
async function rollbackToVersion(resourceId: string, targetVersion: number) {
  // Fetch version history (requires history table)
  const history = await getVersionHistory(resourceId);
  const targetState = history.find(v => v.version === targetVersion);
  
  if (!targetState) {
    throw new Error("Version not found");
  }
  
  // Apply as new version with last-write-wins
  const current = await getResource(resourceId);
  return await submitEdit({
    resourceId,
    resourceType: current.resourceType,
    baseVersion: current.version,
    proposedData: targetState.data,
    strategy: "last_write_wins"
  });
}
```

## Testing

### Unit Tests

```bash
npm test -- conflict-resolution.service.spec.ts
```

Covers:
- All resolution strategies
- Concurrent edit scenarios
- Statistics tracking
- Edge cases (invalid versions, empty data)

### Integration Tests

```bash
npm test -- conflict-resolution.e2e.spec.ts
```

Covers:
- Full HTTP request/response flow
- Multiple concurrent clients
- Retry scenarios
- Authorization checks

### Manual Testing Scenarios

1. **Two Browser Tabs:**
   - Open same document in two tabs
   - Edit different fields → should merge
   - Edit same field → should conflict

2. **Network Interruption:**
   - Start edit
   - Disconnect network
   - Reconnect and retry

3. **Long Idle Time:**
   - Open document
   - Leave idle for hours
   - Other user edits
   - Original user tries to save → conflict

## Monitoring and Alerts

### Metrics to Track

```yaml
conflict_resolution_attempts_total: Counter
  - Labels: resource_type, strategy, outcome

conflict_resolution_duration_seconds: Histogram
  - Labels: resource_type, strategy

conflict_rate_percent: Gauge
  - Labels: resource_type

conflicts_requiring_manual_resolution: Counter
  - Labels: resource_type
```

### Alert Thresholds

```yaml
alerts:
  - name: HighConflictRate
    condition: conflict_rate_percent > 20
    severity: warning
    message: "More than 20% of edits are conflicting"
    
  - name: FrequentManualResolution
    condition: rate(conflicts_requiring_manual_resolution[5m]) > 10
    severity: info
    message: "Many conflicts requiring manual resolution"
```

## Performance Considerations

### Scalability

- Version checks are O(1) with indexed version column
- Three-way merge is O(k) where k is number of fields
- In-memory statistics limited to 1000 recent attempts
- Consider moving history to separate table for large resources

### Optimization Tips

1. **Index Version Column:**
   ```sql
   CREATE INDEX idx_resource_version ON resources(id, version);
   ```

2. **Cache Current State:**
   ```typescript
   // Use Redis for hot resources
   const cached = await redis.get(`resource:${id}`);
   if (cached) return JSON.parse(cached);
   ```

3. **Batch Version Checks:**
   ```typescript
   // Check multiple resources at once
   const versions = await db.query(
     "SELECT id, version FROM resources WHERE id IN (?)",
     resourceIds
   );
   ```

## Migration Plan

This feature extends existing concurrency infrastructure:

- ✅ Uses existing `OptimisticConcurrencyService`
- ✅ Uses existing `threeWayMerge` function
- ✅ New controller and service added
- ✅ No database migrations required (uses in-memory storage for demo)
- ⚠️ Production requires adding version column to resources

### Database Migration (Production)

```sql
-- Add version column to resources
ALTER TABLE resources ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- Create index for performance
CREATE INDEX idx_resources_version ON resources(id, version);

-- Optional: Create version history table
CREATE TABLE resource_versions (
  id UUID PRIMARY KEY,
  resource_id UUID NOT NULL,
  version INTEGER NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);

CREATE INDEX idx_resource_versions_lookup 
  ON resource_versions(resource_id, version);
```

## Related Documentation

- [Optimistic Concurrency Service](../src/common/concurrency/optimistic-concurrency.service.ts)
- [Three-Way Merge](../src/common/concurrency/conflict-resolver.ts)
- [Deterministic Replay Tests](../src/testing/concurrency/deterministic-replay.spec.ts)
- [Concurrency Harness](../src/testing/concurrency/concurrency-harness.spec.ts)

## Security Considerations

### Authorization

All edit operations require authentication:

```typescript
@UseGuards(JwtAuthGuard)
@Controller("api/v1/conflicts")
class ConflictResolutionController { ... }
```

### Audit Trail

All edit attempts are logged:

```typescript
{
  timestamp: "2024-11-22T10:30:00Z",
  userId: "user_123",
  resourceId: "doc1",
  resourceType: "document",
  baseVersion: 1,
  currentVersion: 2,
  strategy: "three_way_merge",
  outcome: "conflict"
}
```

### Resource Ownership

Implement ownership checks:

```typescript
async function validateOwnership(userId: string, resourceId: string) {
  const resource = await getResource(resourceId);
  if (resource.ownerId !== userId && !isAdmin(userId)) {
    throw new ForbiddenException("Not authorized to edit this resource");
  }
}
```

## FAQ

**Q: What happens if version history is lost?**
A: Three-way merge will treat current state as base, which may report false conflicts. Use last-write-wins or manual resolution as fallback.

**Q: Can I customize conflict resolution per resource type?**
A: Yes, implement custom resolution logic in the service or use strategy parameter per request.

**Q: How do I handle binary data (images, files)?**
A: Version the metadata separately. For binary content, use checksums or last-write-wins.

**Q: What's the overhead of version tracking?**
A: Minimal - one integer column and index. Version increment is O(1).

**Q: Can conflicts be resolved offline?**
A: Yes, but requires syncing version state. Consider operational transform or CRDT for true offline support.

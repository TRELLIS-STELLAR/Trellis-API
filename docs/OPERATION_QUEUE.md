# Conflict-Aware Offline and Multi-Tab Operation Queue (#240)

## Overview
When clients interact with Trellis-API across multiple tabs or intermittently offline networks, concurrent mutations can lead to lost updates, silent overwrites, or corrupted state. The `OperationQueueService` provides client/hybrid queuing semantics with:
1. **Durable Local/Session/IndexedDB Storage**: Uncommitted actions survive browser refreshes, network drops, or worker crashes.
2. **Multi-Tab Synchronization**: Cross-tab communication using `BroadcastChannel` or storage events to coordinate leader execution and avoid duplicate dispatch.
3. **Optimistic Concurrency Conflict Detection**: Verifies entity version tokens (`expectedVersion` vs current version) and traps HTTP 409 Conflict status.
4. **Deterministic Resolution Semantics**:
   - `RETRY_WITH_LATEST`: Automatically re-bases the mutation payload against the latest remote entity version and re-queues.
   - `DISCARD`: Drops the stale operation safely, updating the ledger and notifying the operator/user.
   - `FORCE_APPLY`: Overrides the version conflict explicitly when administrative or authoritative overrides are requested.
5. **Backoff and Offline Buffering**: Intelligently halts queue consumption during offline periods and automatically drains with exponential backoff on reconnection.

## Architecture
- `src/common/queue/operation-queue.types.ts`: Interface definitions for queue entries, conflict details, storage adapters, and resolution choices.
- `src/common/queue/operation-queue.service.ts`: Core queue manager, processing pipeline, and conflict handler.
- `src/common/queue/operation-queue.service.spec.ts`: Unit and integration test suite covering durability, conflict scenarios, retry handling, and offline-online transitions.

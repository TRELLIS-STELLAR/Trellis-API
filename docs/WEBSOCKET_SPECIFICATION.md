# WebSocket Event Specification

## Overview

This document specifies the WebSocket implementation for real-time dashboard communications, including connection management, event specifications, and reconnection logic.

## Connection Endpoint

```
WebSocket: ws://host:port/api/v1/dashboard
```

## Authentication

All WebSocket connections require JWT authentication. Include the token in one of the following ways:

1. **Authorization Header** (preferred):
   ```
   Authorization: Bearer <jwt_token>
   ```

2. **Auth Object**:
   ```javascript
   io(url, {
     auth: { token: "<jwt_token>" }
   });
   ```

3. **Query Parameter**:
   ```
   ws://host:port/api/v1/dashboard?token=<jwt_token>
   ```

## Connection Lifecycle

### 1. Connection Establishment

**Client → Server:**
```javascript
// Connect with authentication
const socket = io("http://localhost:3001/api/v1/dashboard", {
  auth: { token: "your_jwt_token" },
  transports: ["websocket"]
});
```

**Server → Client:**
```json
{
  "event": "connection:established",
  "data": {
    "clientId": "abc123",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "heartbeatInterval": 30000
  }
}
```

### 2. Reconnection with Buffer Replay

When a client reconnects after disconnection, the server automatically replays buffered events:

**Server → Client:**
```json
{
  "event": "reconnection:success",
  "data": {
    "missedEvents": 5,
    "events": [
      {
        "event": "portfolio:update",
        "data": { "portfolioId": "xyz", "totalValue": 10000 },
        "timestamp": "2024-01-15T10:25:00.000Z"
      }
    ]
  }
}
```

## Events

### Connection Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `connection:established` | Server → Client | Confirms successful connection |
| `connection:stale` | Server → Client | Notifies client connection is stale |
| `reconnection:success` | Server → Client | Confirms reconnection with buffered events |

### Heartbeat Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `heartbeat` | Server → Client | Periodic heartbeat (every 30 seconds) |
| `ping` | Client → Server | Client heartbeat request |
| `pong` | Server → Client | Server heartbeat response |

### Subscription Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `portfolio:subscribe` | Client → Server | `{ portfolioId: string }` | Subscribe to portfolio updates |
| `portfolio:subscription:confirmed` | Server → Client | `{ portfolioId, subscribedAt }` | Subscription confirmed |
| `portfolio:unsubscribe` | Client → Server | `{ portfolioId: string }` | Unsubscribe from portfolio |
| `portfolio:unsubscription:confirmed` | Server → Client | `{ portfolioId }` | Unsubscription confirmed |

### Data Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `portfolio:update` | Server → Client | PortfolioUpdatePayload | Portfolio value update |
| `portfolio:performance:update` | Server → Client | PerformanceUpdatePayload | Performance metrics update |
| `portfolio:allocation:update` | Server → Client | AllocationUpdatePayload | Asset allocation update |
| `portfolio:risk:update` | Server → Client | RiskUpdatePayload | Risk assessment update |
| `portfolio:holdings:update` | Server → Client | HoldingsPayload | Holdings update |

### Replay Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `events:replay` | Client → Server | `{ since: string }` | Request events since timestamp |
| `events:replayed` | Server → Client | `{ count, events }` | Replayed events response |

### Error Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `error` | Server → Client | `{ code, message, details? }` | Error notification |

## Payload Specifications

### PortfolioUpdatePayload

```typescript
interface PortfolioUpdatePayload {
  portfolioId: string;
  totalValue: number;
  change: number;
  changePercent: number;
  timestamp: string;
}
```

### PerformanceUpdatePayload

```typescript
interface PerformanceUpdatePayload {
  portfolioId: string;
  performance: {
    value: number;
    change: number;
    changePercent: number;
    timeRange: string;
  };
  history: Array<{
    timestamp: string;
    value: number;
  }>;
}
```

### AllocationUpdatePayload

```typescript
interface AllocationUpdatePayload {
  portfolioId: string;
  allocation: Array<{
    asset: string;
    percentage: number;
    value: number;
  }>;
  lastUpdated: string;
}
```

### RiskUpdatePayload

```typescript
interface RiskUpdatePayload {
  portfolioId: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  factors: string[];
  lastUpdated: string;
}
```

## Connection Management

### Heartbeat Configuration

- **Interval**: 30 seconds
- **Timeout**: 5 seconds for pong response
- **Stale Threshold**: 5 minutes (connection closed if no heartbeat response)

### Reconnection Logic

The client implements exponential backoff with the following parameters:

| Parameter | Default | Max | Description |
|-----------|---------|-----|-------------|
| baseDelay | 1000ms | - | Starting delay |
| maxDelay | 30000ms | 30000ms | Maximum delay |
| factor | 2 | - | Multiplier for each attempt |
| jitter | 30% | - | Random variation |

**Reconnection Sequence:**
1. First attempt: 1s
2. Second attempt: 2s
3. Third attempt: 4s
4. ... (doubling each time)
5. Max: 30s (capped)

### Event Buffering

- **Max Events Per User**: 1000
- **Buffer Duration**: 5 minutes
- **Replay on Reconnect**: Automatic

## Server-Side Connection Pool

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| maxConnections | 100 | Max connections per upstream service |
| connectionTimeout | 10s | Connection establishment timeout |
| heartbeatInterval | 30s | Heartbeat interval |
| staleThreshold | 5min | Time before connection considered stale |
| reconnectDelay | 1s | Base reconnection delay |
| maxReconnectDelay | 30s | Maximum reconnection delay |

## Metrics

The following Prometheus metrics are exposed:

### Connection Metrics
- `trellis_ws_connections_total` - Total WebSocket connections by namespace and type
- `trellis_ws_active_connections` - Active WebSocket connections by namespace

### Subscription Metrics
- `trellis_ws_subscriptions_total` - Total subscriptions by namespace and channel
- `trellis_ws_active_subscriptions` - Active subscriptions by namespace and channel

### Heartbeat Metrics
- `trellis_ws_heartbeats_sent_total` - Heartbeats sent by namespace
- `trellis_ws_heartbeats_received_total` - Heartbeat responses received
- `trellis_ws_heartbeat_latency_seconds` - Heartbeat response latency

### Event Metrics
- `trellis_ws_events_buffered` - Events in buffer by namespace and user
- `trellis_ws_events_sent_total` - Events sent by namespace and event type
- `trellis_ws_events_received_total` - Events received by namespace and event type

### Reconnection Metrics
- `trellis_ws_reconnections_total` - Reconnection attempts by namespace and status
- `trellis_ws_reconnection_delay_seconds` - Reconnection delay histogram

### Upstream Pool Metrics
- `trellis_upstream_pool_connections_total` - Total pool connections
- `trellis_upstream_pool_active_connections` - Active pool connections
- `trellis_upstream_pool_utilization_percent` - Pool utilization percentage
- `trellis_upstream_pool_requests_total` - Pool requests by status

## Example Usage

### Client Connection

```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:3001/api/v1/dashboard", {
  auth: { token: "your_jwt_token" },
  transports: ["websocket"]
});

socket.on("connection:established", (data) => {
  console.log("Connected:", data);
  
  // Subscribe to portfolio updates
  socket.emit("portfolio:subscribe", { portfolioId: "port_123" });
});

socket.on("portfolio:update", (data) => {
  console.log("Portfolio update:", data);
});

// Handle disconnection with auto-reconnect
socket.on("disconnect", (reason) => {
  console.log("Disconnected:", reason);
  // Reconnection is automatic
});
```

### Server Broadcasting

```typescript
// In your service
@Inject()
private readonly dashboardGateway: DashboardGateway;

// Broadcast to all subscribers of a portfolio
this.dashboardGateway.broadcastToPortfolio("port_123", DashboardEvent.PORTFOLIO_UPDATE, {
  portfolioId: "port_123",
  totalValue: 15000,
  change: 500,
  changePercent: 3.45,
  timestamp: new Date().toISOString(),
});
```

## Error Codes

| Code | Description |
|------|-------------|
| `AUTH_REQUIRED` | No authentication token provided |
| `AUTH_FAILED` | Token validation failed |
| `INVALID_TOKEN` | Token is malformed or expired |
| `WS_ERROR` | General WebSocket error |
| `INTERNAL_ERROR` | Server internal error |
| `UNKNOWN_ERROR` | Unknown error occurred |

## Health Check

WebSocket health can be checked via the health endpoint:

```
GET /api/v1/health/websocket
```

Response:
```json
{
  "status": "healthy",
  "connections": {
    "total": 50,
    "active": 48,
    "stale": 2
  },
  "lastCheck": "2024-01-15T10:30:00.000Z",
  "uptime": 86400000
}
```

## Testing

Run WebSocket tests:
```bash
npm test -- --testPathPattern=websocket
```

## Stress Testing

The implementation supports stress testing with 1000 concurrent clients:

```bash
npm run test:stress -- --clients=1000 --expectedFailureRate=0.01
```

Requirements:
- Max 1% failure rate
- All clients reconnect successfully with exponential backoff
- Events replayed correctly upon reconnection